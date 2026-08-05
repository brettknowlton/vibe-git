#!/usr/bin/env node
'use strict';
/*
 * An MCP server for a RUNNING vibe-git server.
 *
 *   claude mcp add vibe-git -- node /path/to/vibe-git/tools/vibe-mcp.js
 *
 * This is the same client as tools/vibe.js wearing a different collar: it discovers the
 * per-run token, talks to the same guarded /api, and inherits every guard the browser
 * does. What changes is who is driving — an agent instead of a person at a shell.
 *
 * Transport is stdio, deliberately. Serving MCP over HTTP would mean a second listener
 * with a second set of Host and Origin decisions to get right, and the DNS-rebinding
 * guard in server.js exists precisely because that is easy to get wrong. Over stdio the
 * only thing that can reach this process is the thing that spawned it.
 *
 * WHAT IS NOT HERE: push. The staged-change queue exists so that nothing reaches GitHub
 * without a person reading the exact gh argv first, and an agent that can both stage and
 * push is an agent that has quietly deleted that review step. `stage` and `queue` are
 * exposed; applying the queue stays in the web UI, under a human. `clear` is absent for
 * the same reason in miniature — it can discard work staged in another window, which is
 * not a decision an agent should be making. `unstage` takes a specific id, so it can only
 * remove something it can name.
 *
 * The git-mutating routes (commit, merge, discard, undo, branch-delete) are not exposed
 * either. They are reachable from the UI by someone looking at the tree.
 *
 * Zero dependencies, like the rest of the project. That includes the MCP protocol, which
 * is JSON-RPC 2.0 in newline-delimited JSON and does not need an SDK to speak.
 *
 * One hard rule: stdout carries protocol frames and nothing else. Every diagnostic goes
 * to stderr. A stray console.log here corrupts the stream and the client sees the server
 * die for no visible reason.
 */

const http = require('http');
const readline = require('readline');

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'vibe-git', version: '0.1.0' };

const argv = process.argv.slice(2);
const portAt = argv.indexOf('--port');
const PORT = portAt > -1 ? Number(argv[portAt + 1]) : Number(process.env.VIBE_GIT_PORT || 11001);
const BASE = `http://127.0.0.1:${PORT}`;

const log = (msg) => process.stderr.write('  vibe-mcp: ' + msg + '\n');

/* ── the guarded HTTP client ─────────────────────────────────────── */

function request(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path, method,
      headers: Object.assign({
        // Host must match what the server expects, or the DNS-rebinding guard refuses us.
        Host: `127.0.0.1:${PORT}`,
      }, payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}, headers || {}),
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(120000, () => req.destroy(new Error('timed out — a model call can take minutes')));
    req.on('error', (e) => reject(e.code === 'ECONNREFUSED'
      ? new Error(`Nothing is listening on ${BASE}. Start it with:  node server.js --port ${PORT}`)
      : e));
    req.end(payload || undefined);
  });
}

/*
 * The token is minted per server run and injected into the page as window.__VIBE_GIT__.
 * Unlike the CLI, this process outlives the server it is talking to: restart vibe-git and
 * the cached token is suddenly wrong. So a rejected token is not fatal here, it is a cue
 * to go and read the new one — see call().
 */
let TOKEN = null;
async function token() {
  if (TOKEN) return TOKEN;
  const { status, text } = await request('GET', '/');
  if (status !== 200) throw new Error(`The server answered ${status} for the page — cannot read the token`);
  const hit = /window\.__VIBE_GIT__=(\{.*?\});/.exec(text);
  if (!hit) throw new Error('Could not find the boot token in the served page');
  TOKEN = JSON.parse(hit[1].replace(/\\u003c/g, '<')).token;
  return TOKEN;
}

async function call(method, path, body, retried) {
  const { status, text } = await request(method, path, body, { 'X-Vibe-Git-Token': await token() });
  if ((status === 401 || status === 403) && !retried) {
    TOKEN = null;
    return call(method, path, body, true);
  }
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Non-JSON reply (HTTP ${status}): ${text.slice(0, 200)}`); }
  if (status >= 400) {
    const err = new Error(data.error || `HTTP ${status}`);
    // Some failures carry the way out of themselves; keep it rather than flattening.
    if (data.recovery) err.recovery = data.recovery;
    throw err;
  }
  return data;
}

/* ── shaping ─────────────────────────────────────────────────────── */

/*
 * /api/state is built for a UI that renders all of it at once: full commit log, every
 * file in the working tree, every issue body, the whole plan. Handing that to a model
 * verbatim spends thousands of tokens to answer "which repo am I in". Each tool below
 * returns the part of it that its own question needs.
 */
function briefState(s) {
  const st = (s.git && s.git.status) || {};
  return {
    repo: s.selected ? { name: s.selected.name, slug: s.selected.github || null, path: s.selected.path } : null,
    branch: st.branch || null,
    upstream: st.upstream || null,
    ahead: st.ahead || 0,
    behind: st.behind || 0,
    dirtyFiles: (st.files || []).length,
    conflicted: st.conflicted || 0,
    mergeInProgress: !!(s.git && s.git.merge && s.git.merge.inProgress),
    issuesLoaded: !!s.issuesLoaded,
    issuesAt: s.issuesAt || null,
    issuesStale: !!s.issuesStored,
    openIssues: (s.issues || []).filter(i => i.st === 'OPEN').length,
    closedIssues: (s.issues || []).filter(i => i.st !== 'OPEN').length,
    staged: (s.queue || []).length,
    auth: s.auth ? { authed: !!s.auth.authed, login: s.auth.login || null } : null,
    githubError: s.githubError || null,
    milestones: ((s.github && s.github.milestones) || []).map(m => m.title),
    labels: ((s.github && s.github.labels) || []).map(l => l.name),
    activeAiJobs: (s.aiJobs || []).length,
  };
}

const oneLine = (i) => `#${i.n} [${i.st}] ${i.t}` +
  (i.ms ? `  (${i.ms})` : '') +
  ((i.l || []).length ? `  [${i.l.join(', ')}]` : '') +
  ((i.a || []).length ? `  @${i.a.join(' @')}` : '');

async function issuesFrom(state) {
  if (!state.issuesLoaded) {
    throw new Error('No issues are cached for this repo yet — call `pull` first');
  }
  return state.issues || [];
}

const json = (v) => JSON.stringify(v, null, 2);

/* ── tools ───────────────────────────────────────────────────────── */

/*
 * Descriptions are the only documentation the model gets, so they say what a tool costs
 * and what it does NOT do, not just what it returns. `pull` reaching the network and
 * `stage` being review-gated are both things worth knowing before the call, not after.
 */
const TOOLS = [
  {
    name: 'state',
    description:
      'Which repository vibe-git currently has selected, plus branch, working-tree state, ' +
      'issue counts, how many changes are staged, and the available milestones and labels. ' +
      'There is no per-call repo argument anywhere in this server — selection is global and ' +
      'changed by the user in the web UI, so call this first to confirm you are looking at ' +
      'the repo you think you are.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      return json(briefState(await call('GET', '/api/state')));
    },
  },

  {
    name: 'issues',
    description:
      'List issues from the local cache (one line each: number, state, title, milestone, ' +
      'labels, assignees). Does not hit the network — call `pull` if the cache is stale. ' +
      'Use `issue` for a single issue with its body.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Default "open".' },
        milestone: { type: 'string', description: 'Exact milestone title.' },
        label: { type: 'string', description: 'Exact label name.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Default 100.' },
      },
      additionalProperties: false,
    },
    async run(a) {
      const want = String(a.state || 'open').toLowerCase();
      let rows = await issuesFrom(await call('GET', '/api/state'));
      rows = rows.filter(i => want === 'all' ? true : want === 'closed' ? i.st !== 'OPEN' : i.st === 'OPEN');
      if (a.milestone) rows = rows.filter(i => i.ms === a.milestone);
      if (a.label) rows = rows.filter(i => (i.l || []).includes(a.label));
      const limit = Math.max(1, Math.min(Number(a.limit) || 100, 500));
      const shown = rows.slice(0, limit);
      const more = rows.length - shown.length;
      return (shown.map(oneLine).join('\n') || '(none)') +
        (more > 0 ? `\n… ${more} more (raise limit to see them)` : '');
    },
  },

  {
    name: 'issue',
    description:
      'One issue in full — title, state, milestone, labels, assignees, body, checkbox counts, ' +
      'the issue numbers its body references, and (when an embedding index exists) issues ' +
      'that look related.',
    inputSchema: {
      type: 'object',
      properties: { number: { type: 'integer', minimum: 1 } },
      required: ['number'],
      additionalProperties: false,
    },
    async run(a) {
      const rows = await issuesFrom(await call('GET', '/api/state'));
      const hit = rows.find(i => i.n === Number(a.number));
      if (!hit) throw new Error(`No issue #${a.number} in the cache — it may be new, so try \`pull\``);
      // Related is best-effort: without an embedding index it simply has nothing to say,
      // which should not cost the caller the issue they actually asked for.
      let related = [];
      try {
        const r = await call('GET', `/api/issues/related?number=${hit.n}`);
        related = r.related || [];
      } catch { /* no index, no problem */ }
      return json(Object.assign({}, hit, { related }));
    },
  },

  {
    name: 'search',
    description:
      'Search issues. Semantic when an embedding model and index are configured, lexical ' +
      'otherwise — the reply says which mode ran, and never fails just because the index is ' +
      'missing. Prefer this over listing everything and reading it yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Free text.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Default "open".' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 40.' },
        semantic: { type: 'boolean', description: 'Set false to force lexical.' },
      },
      required: ['q'],
      additionalProperties: false,
    },
    async run(a) {
      /*
       * A hit is {number, score, why} — the search index scores, it does not carry titles.
       * Joining against the cache costs one extra call and is the difference between a
       * list a model can act on and a list of bare integers.
       */
      const [r, s] = await Promise.all([
        call('POST', '/api/issues/search', {
          q: String(a.q), state: a.state || 'open',
          limit: a.limit, semantic: a.semantic !== false,
        }),
        call('GET', '/api/state'),
      ]);
      const byNum = new Map((s.issues || []).map(i => [i.n, i]));
      const head = `mode: ${r.mode}` + (r.embedError ? `  (embeddings unavailable: ${r.embedError})` : '');
      const lines = (r.hits || []).map((h) => {
        const i = byNum.get(h.number);
        return (i ? oneLine(i) : `#${h.number}`) + `  — ${h.score.toFixed(2)} ${h.why}`;
      });
      return head + '\n' + (lines.join('\n') || '(no hits)');
    },
  },

  {
    name: 'dependencies',
    description:
      'The dependency structure between issues, derived from "#123" references in issue ' +
      'bodies: what blocks what, and which issues are ready to start because nothing open ' +
      'blocks them. Use this to answer "what should I work on next" from structure rather ' +
      'than from guessing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      // Both sides of this are bare issue numbers. Sixty integers tell a model nothing it
      // can reason about, so join the titles on the way past.
      const [r, s] = await Promise.all([
        call('GET', '/api/issues/dependencies'),
        call('GET', '/api/state'),
      ]);
      const byNum = new Map((s.issues || []).map(i => [i.n, i]));
      const label = (n) => { const i = byNum.get(n); return i ? `#${n} ${i.t}` : `#${n}`; };
      const out = [];
      out.push(`READY (${(r.ready || []).length}) — open, blocked by nothing still open`);
      out.push((r.ready || []).map(n => '  ' + label(n)).join('\n') || '  (none)');
      out.push('');
      out.push(`BLOCKED (${(r.blocked || []).length})`);
      out.push((r.blocked || []).map(b =>
        `  ${label(b.number)}\n      waiting on ${(b.waitingOn || []).map(label).join('; ') || '(nothing open)'}`
      ).join('\n') || '  (none)');
      if ((r.blocking || []).length) {
        out.push('');
        out.push(`BLOCKING (${r.blocking.length}) — finishing these frees other work`);
        out.push(r.blocking.map(b =>
          `  ${label(b.number)}\n      unblocks ${(b.waiters || []).map(label).join('; ')}`
        ).join('\n'));
      }
      return out.join('\n');
    },
  },

  {
    name: 'plan',
    description:
      'The saved plan for this repo: phases, ranked order, and identified gaps, plus how far ' +
      'the plan has drifted from the tracker as it is now. This reads the stored plan only — ' +
      'it does not run the model or generate a new one. Generating is a UI action.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const s = await call('GET', '/api/state');
      const p = s.insights;
      if (!p) return 'No plan for this repo yet — generate one in the vibe-git assistant.';
      const byNum = new Map((s.issues || []).map(i => [i.n, i]));
      const label = (n) => { const i = byNum.get(n); return i ? `#${n} ${i.t}` : `#${n}`; };
      const d = s.planStatus || {};
      // baselineNums/baselineOpen are how the plan detects its own drift — bookkeeping the
      // caller has no use for, and the longest thing in the file.
      return json({
        source: p.source,
        capturedAt: p.capturedAt,
        hoursPerWeek: p.hoursPerWeek,
        phases: (p.phases || []).map(f => ({
          title: f.title, state: f.state, dueOn: f.dueOn || null, gate: f.gate || null,
        })),
        ranked: (p.ranked || []).map(r => ({
          issues: (r.ns || []).map(label), tag: r.tag, why: r.why,
        })),
        gaps: p.gaps || [],
        drift: {
          stale: !!d.stale,
          closedSincePlan: (d.closed || []).map(label),
          addedSincePlan: (d.added || []).map(label),
        },
      });
    },
  },

  {
    name: 'pull',
    description:
      'Refresh the issue cache from GitHub. This is the one read tool that reaches the ' +
      'network, and it takes a few seconds. It only reads — nothing is written to GitHub.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const r = await call('POST', '/api/issues/pull', {});
      return r.message || 'Pulled';
    },
  },

  {
    name: 'queue',
    description:
      'What is currently staged and not yet applied, each with the exact `gh` argv it will ' +
      'run. Includes anything staged from the web UI, not just from here.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const s = await call('GET', '/api/state');
      const q = s.queue || [];
      if (!q.length) return '(nothing staged)';
      return q.map((c, i) => `${i + 1}. [${c.id}] ${c.summary}\n     gh ${JSON.stringify(c.argv)}`).join('\n');
    },
  },

  {
    name: 'stage',
    description:
      'Queue a change for the user to review. NOTHING REACHES GITHUB FROM HERE. The change ' +
      'sits in the queue until the user reads the generated `gh` argv and applies it in the ' +
      'vibe-git web UI; this server has no tool that can apply it. Staging is therefore safe ' +
      'and reversible — say what you staged and let the user decide.\n' +
      'Payload by kind:\n' +
      '  close     {number, reason?: "completed"|"not planned", comment?}\n' +
      '  reopen    {number}\n' +
      '  comment   {number, body}\n' +
      '  edit      {number, title?, body?, milestone?: title|null, addLabels?[], removeLabels?[], addAssignees?[], removeAssignees?[]}\n' +
      '  create    {title, body?, milestone?, labels?[], assignees?[]}\n' +
      '  milestone {title, description?, dueOn?: "YYYY-MM-DD"}\n' +
      '  label     {name, description?, color?: "rrggbb"}\n' +
      'Milestones and labels must already exist in the repo (see `state`) unless you are ' +
      'creating them. Staging an identical change twice is rejected, as is closing something ' +
      'already staged for reopen.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['close', 'reopen', 'comment', 'edit', 'create', 'milestone', 'label'],
        },
        payload: { type: 'object', description: 'Shape depends on kind — see the description.' },
      },
      required: ['kind', 'payload'],
      additionalProperties: false,
    },
    async run(a) {
      const r = await call('POST', '/api/queue/add', { kind: String(a.kind), payload: a.payload || {} });
      return `${r.message}\n     gh ${JSON.stringify(r.change.argv)}\n(id ${r.change.id} — staged only; the user applies it in the vibe-git UI)`;
    },
  },

  {
    name: 'unstage',
    description:
      'Remove one staged change by its id (from `queue`). Takes a specific id rather than ' +
      'clearing the queue, so it cannot discard work staged elsewhere by accident.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    async run(a) {
      const r = await call('POST', '/api/queue/remove', { id: String(a.id) });
      return r.message || 'Removed';
    },
  },
];

const BY_NAME = new Map(TOOLS.map(t => [t.name, t]));

/* ── JSON-RPC over stdio ─────────────────────────────────────────── */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function onMessage(msg) {
  const { id, method, params } = msg;
  // A notification has no id and must never be answered — initialized/cancelled land here.
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    // Echo the client's protocol version when we recognise it; otherwise state ours and
    // let the client decide whether it can live with that.
    const asked = params && params.protocolVersion;
    return reply(id, {
      protocolVersion: asked === PROTOCOL_VERSION ? asked : PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    });
  }

  if (isNotification) return;

  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') {
    return reply(id, {
      tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
  }
  // Answered rather than refused: some clients probe for these on connect, and a
  // method-not-found there reads like a broken server in the logs.
  if (method === 'resources/list') return reply(id, { resources: [] });
  if (method === 'prompts/list') return reply(id, { prompts: [] });

  if (method === 'tools/call') {
    const tool = BY_NAME.get(params && params.name);
    if (!tool) return fail(id, -32602, `No such tool: ${params && params.name}`);
    try {
      const text = await tool.run((params && params.arguments) || {});
      return reply(id, { content: [{ type: 'text', text: String(text) }] });
    } catch (e) {
      /*
       * A failing tool is a result, not a transport error. The server's messages are
       * written to be read by a person and mostly say what to do next ("Pull issues
       * first"), so they are worth more to the model than a JSON-RPC error code — which
       * most clients would swallow before it ever reached the model.
       */
      let text = (e && e.message) || 'Unknown error';
      if (e && e.recovery) {
        text += '\n' + (e.recovery.title || 'What to do') + ':';
        for (const step of e.recovery.steps || []) text += '\n  - ' + step;
      }
      return reply(id, { content: [{ type: 'text', text }], isError: true });
    }
  }

  return fail(id, -32601, `Method not found: ${method}`);
}

/*
 * Handlers run concurrently — one slow tool must not stall the next request — so closing
 * stdin cannot simply exit. A client that shuts us down by closing the pipe would truncate
 * whatever was still in flight, and the reply it was waiting for would never arrive. Count
 * the outstanding work and leave on the last one.
 */
let inFlight = 0;
let stdinClosed = false;
const maybeExit = () => { if (stdinClosed && inFlight === 0) process.exit(0); };

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); }
  catch { return fail(null, -32700, 'Parse error'); }
  inFlight++;
  Promise.resolve(onMessage(msg)).catch((e) => {
    log('handler crashed: ' + ((e && e.stack) || e));
    if (msg && msg.id != null) fail(msg.id, -32603, (e && e.message) || 'Internal error');
  }).finally(() => { inFlight--; maybeExit(); });
});
rl.on('close', () => { stdinClosed = true; maybeExit(); });

log(`ready — ${TOOLS.length} tools against ${BASE} (push is deliberately not among them)`);
