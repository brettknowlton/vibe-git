#!/usr/bin/env node
'use strict';
/*
 * A command-line client for a RUNNING vibe-git server.
 *
 *   node tools/vibe.js state
 *   node tools/vibe.js issues --state open
 *   node tools/vibe.js stage close '{"number":11,"reason":"completed","comment":"Done in lib/x.js:3"}'
 *   node tools/vibe.js push
 *
 * Why this exists: every /api call needs the per-run token, and the only place that token
 * appears is inside the HTML the server serves. Scraping it out of `curl | grep` by hand
 * works and is exactly the sort of thing that gets pasted wrong once and then quietly
 * targets the wrong port. So the discovery happens here, once.
 *
 * It talks to the same guarded API the browser uses, which means it inherits every guard:
 * the token, the Host and Origin checks, and above all the staged-change queue. `stage` puts
 * something in the queue; only `push` sends it to GitHub. There is no command here that
 * writes to GitHub without going through that queue, deliberately.
 *
 * Zero dependencies, like the rest of the project.
 */

const http = require('http');

const DEFAULT_PORT = Number(process.env.VIBE_GIT_PORT || 11001);

const argv = process.argv.slice(2);
const optIndex = argv.indexOf('--port');
const PORT = optIndex > -1 ? Number(argv[optIndex + 1]) : DEFAULT_PORT;
if (optIndex > -1) argv.splice(optIndex, 2);

const flag = (name, dflt = null) => {
  const at = argv.indexOf('--' + name);
  if (at < 0) return dflt;
  const value = argv[at + 1];
  argv.splice(at, value && !value.startsWith('--') ? 2 : 1);
  return value && !value.startsWith('--') ? value : true;
};

const BASE = `http://127.0.0.1:${PORT}`;

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

/* The token is minted per run and injected into the page as window.__VIBE_GIT__. */
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

async function call(method, path, body) {
  const t = await token();
  const { status, text } = await request(method, path, body, { 'X-Vibe-Git-Token': t });
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

const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

/* Parse a JSON argument, with a readable error — a bad payload here is the common mistake. */
function payload(raw, what) {
  if (!raw) throw new Error(`${what} needs a JSON payload`);
  try { return JSON.parse(raw); }
  catch (e) { throw new Error(`That is not valid JSON: ${e.message}`); }
}

const COMMANDS = {
  async token() { out(await token()); },

  async state() { out(await call('GET', '/api/state')); },

  /* The tracker as the server has it cached. --state open|closed|all, --json for everything. */
  async issues() {
    const want = String(flag('state', 'open')).toLowerCase();
    const full = flag('json', false);
    const s = await call('GET', '/api/state');
    if (!s.issuesLoaded) throw new Error('No issues are cached — run `pull` first');
    const rows = s.issues.filter(i => want === 'all' ? true
      : want === 'closed' ? i.st !== 'OPEN' : i.st === 'OPEN');
    if (full) return out(rows);
    out(rows.map(i => `#${i.n} [${i.st}] ${i.t}` +
      (i.ms ? `  (${i.ms})` : '') +
      ((i.l || []).length ? `  [${i.l.join(', ')}]` : '')).join('\n') || '(none)');
  },

  async pull() { const r = await call('POST', '/api/issues/pull', {}); out(r.message); },

  /* Everything below is queue-mediated. Nothing reaches GitHub until `push`. */
  async stage() {
    const kind = argv[1];
    if (!kind) throw new Error('stage needs a kind: close, reopen, comment, edit, create, milestone, label');
    const r = await call('POST', '/api/queue/add', { kind, payload: payload(argv[2], 'stage') });
    out(r.message);
  },

  /* The common case, spelled out, because closing finished work is most of what this is for. */
  async close() {
    const number = Number(argv[1]);
    if (!Number.isInteger(number)) throw new Error('close needs an issue number');
    const body = { number, reason: String(flag('reason', 'completed')) };
    const comment = flag('comment', null);
    if (comment && comment !== true) body.comment = String(comment);
    const r = await call('POST', '/api/queue/add', { kind: 'close', payload: body });
    out(r.message);
  },

  async queue() {
    const s = await call('GET', '/api/state');
    out(s.queue.length
      ? s.queue.map((c, i) => `${i + 1}. ${c.summary}\n     gh ${JSON.stringify(c.argv)}`).join('\n')
      : '(nothing staged)');
  },

  async unstage() {
    const id = argv[1];
    if (!id) throw new Error('unstage needs a staged-change id (see `queue --json`)');
    out((await call('POST', '/api/queue/remove', { id })).message);
  },

  async clear() { out((await call('POST', '/api/queue/clear', {})).message); },

  /*
   * The only command that writes to GitHub. It refuses to guess: you have to have staged
   * something first, and what it will run is printable beforehand with `queue`.
   */
  async push() {
    const r = await call('POST', '/api/queue/push', {});
    out(r.message);
    for (const item of r.results || []) {
      out(`  ${item.ok ? '✓' : '✗'} ${item.summary}${item.url ? '  ' + item.url : ''}${item.error ? '  — ' + item.error : ''}`);
    }
    if (!r.ok) process.exitCode = 1;
  },

  async ai() {
    const sub = argv[1] || 'status';
    if (sub === 'status') return out(await call('GET', '/api/ai/status'));
    if (sub === 'jobs') return out(await call('GET', '/api/ai/jobs'));
    if (sub === 'config') return out(await call('POST', '/api/ai/config', payload(argv[2], 'ai config')));
    throw new Error('ai takes: status, jobs, config <json>');
  },

  async dryLog() { out(await call('GET', '/api/dry-log')); },

  /* Escape hatches, so a route this file has not grown a verb for is still reachable. */
  async get() { out(await call('GET', argv[1] || '/api/state')); },
  async post() { out(await call('POST', argv[1], argv[2] ? payload(argv[2], 'post') : {})); },
};

const ALIASES = { 'dry-log': 'dryLog', ls: 'issues', rm: 'unstage' };

async function main() {
  const name = ALIASES[argv[0]] || argv[0];
  if (!name || name === 'help' || name === '--help') {
    out([
      'vibe.js — drive a running vibe-git server',
      '',
      `  --port N          which instance (default ${DEFAULT_PORT}, or $VIBE_GIT_PORT)`,
      '',
      '  state                          full server state as JSON',
      '  issues [--state open|closed|all] [--json]',
      '  pull                           refresh the issue cache from GitHub',
      '',
      '  stage <kind> <json>            queue a change (close reopen comment edit create milestone label)',
      '  close <n> [--reason completed|"not planned"] [--comment TEXT]',
      '  queue                          what is staged, with the exact gh argv',
      '  unstage <id> | clear',
      '  push                           APPLY the staged changes to GitHub',
      '',
      '  ai status | ai jobs | ai config <json>',
      '  dry-log                        what --dry-run would have run',
      '  get <path> | post <path> [json]',
    ].join('\n'));
    return;
  }
  const fn = COMMANDS[name];
  if (!fn) throw new Error(`Unknown command "${argv[0]}". Try: node tools/vibe.js help`);
  await fn();
}

main().catch((e) => {
  console.error('  ' + e.message);
  if (e.recovery) {
    console.error('  ' + (e.recovery.title || 'What to do') + ':');
    for (const step of e.recovery.steps || []) console.error('    - ' + step);
  }
  process.exit(1);
});
