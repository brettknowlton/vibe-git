#!/usr/bin/env node
'use strict';
/*
 * vibe-git — a small local GitHub Desktop for issues.
 *
 *   node server.js                  # http://127.0.0.1:11001
 *   node server.js --dry-run        # reads are real, every write just logs its argv
 *   node server.js --port 8080
 *   node server.js --scan ~/work    # add a directory to the repo search path
 *
 * Zero dependencies — node's own http + child_process.
 *
 * SAFETY, since this runs git and gh against your repos:
 *   - Binds 127.0.0.1 only. Nothing off this machine can reach it.
 *   - Every subprocess is execFile with an argument array and shell:false. There is no
 *     endpoint anywhere that accepts a command string.
 *   - A random per-run token is minted at startup and injected into the page; every /api
 *     call must carry it. Another site cannot read our HTML, so it cannot forge one.
 *   - Origin and Host are both checked, so a cross-site POST is rejected outright.
 *   - Milestones, labels and file paths are validated against what the repo actually has.
 *   - Issue writes are staged and only leave the machine when you press Push.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ex = require('./lib/exec');
const gitOps = require('./lib/git');
const issueOps = require('./lib/issues');
const {
  Repos, CONFIG_DIR, LEGACY_CONFIG_DIR, readConfig, writeConfig,
} = require('./lib/repos');
const { Queue } = require('./lib/queue');
const prs = require('./lib/prs');
const llm = require('./lib/llm');
const planOps = require('./lib/plans');

const HERE = __dirname;
const WEB = path.join(HERE, 'web');
const HOST = '127.0.0.1';
const DEFAULT_PORT = 11001;
const TOKEN = crypto.randomBytes(24).toString('hex');
const CSP_NONCE = crypto.randomBytes(18).toString('base64');

// Repository slugs become local cache filenames. Replace every separator and collapse
// dot-dot so even a malformed hand-edited remote cannot escape the intended directory.
const slugKey = (slug) => (String(slug || '')
  .replace(/\//g, '__')
  .replace(/[^A-Za-z0-9._-]/g, '_')
  .replace(/\.\./g, '__')
  .slice(0, 180) || 'repo');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};

const portValue = opt('port', process.env.VIBE_GIT_PORT || process.env.BOARD_PORT || DEFAULT_PORT);
const WANT_PORT = Number(portValue);
if (!Number.isInteger(WANT_PORT) || WANT_PORT < 1 || WANT_PORT > 65535) {
  console.error(`\n  Invalid port "${portValue}". Use an integer from 1 to 65535.\n`);
  process.exit(1);
}
ex.setDryRun(flag('dry-run'));

const repos = new Repos([opt('scan', null), process.cwd()].filter(Boolean));
const queue = new Queue();

/* Cached per-repo GitHub metadata, so every state poll isn't three extra API calls. */
const metaCache = new Map();
let AUTH = null;
async function metaFor(dir, { fresh = false } = {}) {
  if (!fresh && metaCache.has(dir)) return metaCache.get(dir);
  const m = await issueOps.repoMeta(dir);
  metaCache.set(dir, m);
  return m;
}

/*
 * Issues are cached separately and NEVER fetched as a side effect of /api/state.
 *
 * `gh issue list` costs ~2.3s on a 107-issue repo while every git call is ~0ms, so
 * folding it into the state poll made each staged edit feel like a hang. Pulling issues
 * is now an explicit act: the Pull button, or the first load of a repo.
 */
const issueCache = new Map();   // dir -> { issues, truncated, at }

/* AI is opt-in and off until configured. Nothing here runs unless the user turns it on. */
function aiConfig() {
  const c = readConfig().ai || {};
  return {
    enabled: !!c.enabled,
    endpoint: c.endpoint || llm.DEFAULT_ENDPOINT,
    model: c.model || null,
    embedModel: c.embedModel || null,
    concurrency: c.concurrency || 2,
    temperature: c.temperature == null ? 0 : c.temperature,
    timeoutMs: c.timeoutMs || 300000,
    numCtx: c.numCtx || 8192,
  };
}
/*
 * Embedding index, one file per repo under the config dir. Keyed by issue number plus a
 * hash of its text, so re-indexing only embeds what actually changed.
 */
const idxFile = (slug) => path.join(CONFIG_DIR, 'embeddings', slugKey(slug) + '.json');
const legacyIdxFile = (slug) => path.join(LEGACY_CONFIG_DIR, 'embeddings', slugKey(slug) + '.json');

function loadIndex(slug) {
  try { return JSON.parse(fs.readFileSync(idxFile(slug), 'utf8')); }
  catch {
    try { return JSON.parse(fs.readFileSync(legacyIdxFile(slug), 'utf8')); }
    catch { return { model: null, dim: 0, items: {} }; }
  }
}
function saveIndex(slug, idx) {
  try {
    fs.mkdirSync(path.join(CONFIG_DIR, 'embeddings'), { recursive: true });
    fs.writeFileSync(idxFile(slug), JSON.stringify(idx), { mode: 0o600 });
  } catch (e) { console.error('  ! could not save embedding index: ' + e.message); }
}
const ignFile = (slug) => path.join(CONFIG_DIR, 'ignored', slugKey(slug) + '.json');
const legacyIgnFile = (slug) => path.join(LEGACY_CONFIG_DIR, 'ignored', slugKey(slug) + '.json');
function loadIgnored(slug) {
  try { return JSON.parse(fs.readFileSync(ignFile(slug), 'utf8')); }
  catch {
    try { return JSON.parse(fs.readFileSync(legacyIgnFile(slug), 'utf8')); }
    catch { return []; }
  }
}
function saveIgnored(slug, list) {
  try {
    fs.mkdirSync(path.join(CONFIG_DIR, 'ignored'), { recursive: true });
    fs.writeFileSync(ignFile(slug), JSON.stringify(list, null, 2), { mode: 0o600 });
  } catch (e) { console.error('  ! could not save ignore list: ' + e.message); }
}
const ignKey = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const textHash = (t) => crypto.createHash('sha1').update(t).digest('hex').slice(0, 16);

async function buildIndex(dir, slug, cfg, { force = false } = {}) {
  const cache = cachedIssues(dir);
  if (!cache) throw new HttpError(400, 'Pull issues first');
  let idx = loadIndex(slug);
  // A different embedding model produces incompatible vectors — start clean.
  if (force || idx.model !== cfg.embedModel) idx = { model: cfg.embedModel, dim: 0, items: {} };

  const need = [];
  for (const i of cache.issues) {
    const txt = llm.issueText(i);
    const hv = textHash(txt);
    const have = idx.items[i.n];
    if (!have || have.h !== hv) need.push({ n: i.n, txt, h: hv });
  }
  if (need.length) {
    const B = 32;
    for (let k = 0; k < need.length; k += B) {
      const batch = need.slice(k, k + B);
      const vecs = await llm.embed(cfg, batch.map(b => b.txt));
      batch.forEach((b, j) => { idx.items[b.n] = { h: b.h, v: vecs[j] }; });
      idx.dim = (vecs[0] && vecs[0].length) || idx.dim;
    }
    // Drop entries for issues that no longer exist.
    const live = new Set(cache.issues.map(i => i.n));
    for (const k of Object.keys(idx.items)) if (!live.has(Number(k))) delete idx.items[k];
    saveIndex(slug, idx);
  }
  return { idx, embedded: need.length, total: cache.issues.length };
}

/* Issues with a milestone become the precedent corpus retrieval draws on. */
function corpusFrom(dir, idx) {
  const cache = cachedIssues(dir);
  if (!cache) return [];
  return cache.issues
    .filter(i => i.ms && idx.items[i.n])
    .map(i => ({ n: i.n, t: i.t, ms: i.ms, l: i.l, vec: idx.items[i.n].v }));
}

/* Prefer a dedicated planning document, with the README as broad fallback context. */
function planFor(dir) {
  for (const rel of ['PLAN.md', 'ROADMAP.md', 'PLANNING.md', 'TODO.md',
                     'docs/PLAN.md', 'docs/ROADMAP.md', 'docs/PLANNING.md', 'README.md']) {
    try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { /* next */ }
  }
  return null;
}

function requireAi() {
  const c = aiConfig();
  if (!c.enabled) throw new HttpError(400, 'AI features are turned off — enable them in AI settings');
  if (!c.model) throw new HttpError(400, 'No model selected — pick one in AI settings');
  return c;
}

async function pullIssues(dir) {
  const l = await issueOps.list(dir);
  // Resolve each issue's milestone by exact title. Repositories do not need to encode a
  // phase number in milestone names for plan filtering and colours to work.
  const m = await metaFor(dir).catch(() => null);
  const phases = m ? planOps.milestonePhases(m.milestones) : [];
  const issues = phases.length ? planOps.assignIssuePhases(l.issues, phases) : l.issues;
  const entry = { issues, truncated: l.truncated, at: new Date().toISOString() };
  issueCache.set(dir, entry);
  return entry;
}
const cachedIssues = (dir) => issueCache.get(dir) || null;

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

/* ── state ───────────────────────────────────────────────────────── */

async function buildState({ fresh = false } = {}) {
  const sel = repos.selected;
  const base = {
    dryRun: ex.isDryRun(),
    repos: repos.list.map(r => ({ path: r.path, name: r.name, github: r.github, branch: r.branch })),
    // The raw remote can contain an embedded credential. The UI only needs the parsed
    // GitHub slug, so never copy the remote URL into an HTTP response.
    selected: sel ? { path: sel.path, name: sel.name, github: sel.github } : null,
    fetchedAt: new Date().toISOString(),
  };
  if (!sel) return Object.assign(base, { git: null, github: null, issues: [], queue: [] });

  const dir = sel.path;
  // Git is local and effectively instant; GitHub may be absent (no remote, or not authed).
  const [st, br, hist] = await Promise.all([
    gitOps.status(dir),
    gitOps.branches(dir).catch(() => ({ current: null, local: [], remote: [], remoteOnly: [] })),
    gitOps.log(dir, 40).catch(() => []),
  ]);

  let github = null, githubError = null;
  if (sel.github) {
    try {
      const m = await metaFor(dir, { fresh });
      github = { repo: m.repo, login: m.login, milestones: m.milestones, labels: m.labels, assignable: m.assignable };
    } catch (e) {
      githubError = e.message;
    }
  }

  let branchPr = null;
  if (sel.github && st.branch) branchPr = await prs.forBranch(dir, st.branch).catch(() => null);

  // Who gh is authenticated as. Cached: `gh auth status` is ~350ms and rarely changes.
  if (!AUTH || fresh) AUTH = await issueOps.authStatus(dir);

  // Issues come from cache only. `issuesLoaded: false` tells the UI to pull them once.
  const cache = cachedIssues(dir);
  const livePhases = planOps.milestonePhases((github && github.milestones) || []);
  const issues = cache ? (livePhases.length
    ? planOps.assignIssuePhases(cache.issues, livePhases)
    : cache.issues) : [];
  return Object.assign(base, {
    git: { status: st, branches: br, log: hist },
    github, githubError,
    issues,
    truncated: cache ? cache.truncated : false,
    issuesLoaded: !!cache,
    issuesAt: cache ? cache.at : null,
    queue: queue.for(dir),
    auth: AUTH,
    branchPr,
    insights: insightsFor(sel.github, (github && github.milestones) || [], issues),
    ignoredCount: loadIgnored(sel.github || sel.name).length,
    ignoredTitles: loadIgnored(sel.github || sel.name).map(x => x.title),
  });
}

/*
 * Per-repo editorial analysis (the ranked order, and the "issues that should exist"
 * list). Lives in insights/<owner>__<repo>.json so it travels with the repo it describes
 * instead of being hardcoded for one project.
 */
function genFile(slug) { return path.join(CONFIG_DIR, 'plans', slugKey(slug) + '.json'); }
function legacyGenFile(slug) { return path.join(LEGACY_CONFIG_DIR, 'plans', slugKey(slug) + '.json'); }

/* Plan files are optional local/editorial input, not trusted application code. Keep a
 * malformed or half-written file from taking down the UI while retaining its prose for
 * the front-end's allowlist renderer. */
function normalizeInsights(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const phases = Array.isArray(value.phases) ? value.phases.filter(p => p && typeof p === 'object') : [];
  return Object.assign({}, value, {
    source: String(value.source || 'local plan').slice(0, 300),
    hoursPerWeek: Number.isFinite(Number(value.hoursPerWeek)) ? Number(value.hoursPerWeek) : 0,
    phases,
    baselineNums: Array.isArray(value.baselineNums) ? value.baselineNums.filter(Number.isInteger) : [],
    ranked: Array.isArray(value.ranked) ? value.ranked.filter(r => r && typeof r === 'object') : [],
    gaps: Array.isArray(value.gaps) ? value.gaps.filter(g => g && typeof g === 'object') : [],
  });
}

function generatedInsights(slug) {
  if (!slug) return null;
  try { return normalizeInsights(JSON.parse(fs.readFileSync(genFile(slug), 'utf8'))); }
  catch {
    try { return normalizeInsights(JSON.parse(fs.readFileSync(legacyGenFile(slug), 'utf8'))); }
    catch { return null; }
  }
}

function loadInsights(slug) {
  if (!slug) return null;
  const file = path.join(HERE, 'insights', slugKey(slug) + '.json');
  try { return normalizeInsights(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch { return null; }
}

/* A checked-in plan is reviewed editorial content. A file marked `showcase` is a
 * distributable fallback, so a plan generated locally for that repository can still
 * take precedence. Live GitHub metadata hydrates either source before it reaches UI. */
function insightsFor(slug, milestones, issues) {
  if (!slug) return null;
  const checked = loadInsights(slug);
  const generated = generatedInsights(slug);
  const selected = checked && !checked.showcase ? checked : (generated || checked);
  if (selected) return planOps.hydratePlan(selected, milestones, issues);
  return milestones.length ? planOps.programmaticPlan(slug, milestones, issues) : null;
}

/* ── routes ──────────────────────────────────────────────────────── */

function withRepo(fn) {
  if (!repos.selected) throw new HttpError(400, 'No repository selected');
  return fn(repos.selected.path);
}

const routes = {
  'GET /api/state': async (q) => buildState({ fresh: q.get('fresh') === '1' }),

  'POST /api/repos/refresh': async () => { await repos.refresh(); return buildState(); },
  'POST /api/repos/select': async (_q, body) => {
    await repos.select(body.path); metaCache.clear(); return buildState({ fresh: true });
  },

  /* The one place issues are fetched. Explicit, so it can own the spinner. */
  'POST /api/issues/pull': async () => withRepo(async (dir) => {
    if (!repos.selected.github) throw new HttpError(400, 'This repository has no GitHub remote');
    const t0 = Date.now();
    const c = await pullIssues(dir);
    return {
      ok: true, issues: c.issues, truncated: c.truncated, issuesAt: c.at, issuesLoaded: true,
      insights: insightsFor(repos.selected.github, (await metaFor(dir)).milestones, c.issues),
      message: `Pulled ${c.issues.length} issues in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    };
  }),
  'POST /api/repos/clone': async (_q, body) => {
    const r = await repos.clone(body.url, body.into);
    metaCache.clear();
    const st = await buildState({ fresh: true });
    return Object.assign(st, {
      message: (r.adopted ? 'Adopted existing clone of ' : 'Cloned ') + r.repo.github || r.repo.name,
    });
  },
  'POST /api/repos/add': async (_q, body) => {
    const r = repos.addRepos(body.path);
    await repos.refresh();
    return Object.assign(await buildState(), {
      message: r.added ? `Added ${r.added} repositor${r.added === 1 ? 'y' : 'ies'}` : 'Already tracked',
    });
  },
  'POST /api/repos/remove': async (_q, body) => {
    const requestedPath = String(body.path || '').trim();
    if (!requestedPath) throw new HttpError(400, 'Choose a repository to stop tracking');
    const removedPath = path.resolve(requestedPath);
    const removed = repos.list.find(repo => repo.path === removedPath);
    repos.remove(removedPath);
    metaCache.delete(removedPath);
    issueCache.delete(removedPath);
    await repos.refresh();
    if (!repos.selected && repos.list.length) await repos.select(repos.list[0].path);
    return Object.assign(await buildState(), {
      message: `Stopped tracking ${(removed && removed.name) || path.basename(removedPath)}. Its folder and files were not deleted.`,
    });
  },

  'POST /api/git/sync': async (_q, body) => withRepo(dir => gitOps.sync(dir, String(body.action || ''))),
  'POST /api/git/checkout': async (_q, body) => withRepo(dir =>
    gitOps.checkout(dir, body.branch, { create: !!body.create, from: body.from || null })),
  'POST /api/git/commit': async (_q, body) => withRepo(dir =>
    gitOps.commit(dir, { paths: body.paths, subject: body.subject, body: body.body })),
  'POST /api/ai/commit-summary': async (_q, body) => withRepo(async (dir) => {
    const cfg = requireAi();
    const changes = await gitOps.summaryDiff(dir, body.paths);
    const draft = await llm.summarizeCommit(cfg, changes);
    return Object.assign({ ok: true }, draft, {
      message: `Drafted a commit message from ${changes.files.length} selected file${changes.files.length === 1 ? '' : 's'}` +
        (changes.truncated ? ' (large diffs were bounded)' : ''),
    });
  }),
  'GET /api/git/show': async (q) => withRepo(dir => gitOps.showCommit(dir, q.get('sha'))),
  'POST /api/git/undo': async () => withRepo(dir => gitOps.undoLastCommit(dir)),
  'POST /api/git/amend': async (_q, body) => withRepo(dir => gitOps.amendCommit(dir, body)),
  'POST /api/git/stash': async (_q, body) => withRepo(dir => gitOps.stash(dir, String(body.action || ''), body.ref)),
  'POST /api/git/merge': async (_q, body) => withRepo(dir => gitOps.merge(dir, body.branch)),
  'GET /api/git/tags': async () => withRepo(async dir => ({ ok: true, tags: await gitOps.tags(dir) })),
  'POST /api/git/tag': async (_q, body) => withRepo(dir => gitOps.createTag(dir, body)),
  'POST /api/git/branch-delete': async (_q, body) => withRepo(dir =>
    gitOps.deleteBranch(dir, body.branch, { force: !!body.force })),

  'GET /api/pr/list': async (q) => withRepo(async (dir) => {
    if (!repos.selected.github) throw new HttpError(400, 'This repository has no GitHub remote');
    return { ok: true, prs: await prs.list(dir, { state: q.get('state') || 'open' }) };
  }),
  'GET /api/pr/view': async (q) => withRepo(dir => prs.view(dir, q.get('number'))),
  'POST /api/pr/create': async (_q, body) => withRepo(async (dir) => {
    if (!repos.selected.github) throw new HttpError(400, 'This repository has no GitHub remote');
    return prs.create(dir, body);
  }),

  'POST /api/queue/update': async (_q, body) => withRepo(async (dir) => {
    const m = await metaFor(dir).catch(() => null);
    const cache = cachedIssues(dir);
    const change = queue.update(dir, String(body.id || ''), body.payload || {},
      { milestones: m && m.milestones, labels: m && m.labels, issues: cache ? cache.issues : [] });
    return { ok: true, change, queue: queue.for(dir), message: 'Updated: ' + change.summary };
  }),
  'POST /api/queue/move': async (_q, body) => withRepo(dir =>
    ({ ok: true, queue: queue.move(dir, String(body.id || ''), Number(body.delta) || 0) })),

  'POST /api/git/discard': async (_q, body) => withRepo(dir => gitOps.discard(dir, body.paths)),
  'GET /api/git/diff': async (q) => withRepo(dir => gitOps.fileDiff(dir, q.get('file'))),

  /* Staging must be instant — it validates against cached metadata, never re-fetches. */
  'POST /api/queue/add': async (_q, body) => withRepo(async (dir) => {
    const m = await metaFor(dir).catch(() => null);
    const cache = cachedIssues(dir);
    const change = queue.add(dir, String(body.kind || ''), body.payload || {},
      { milestones: m && m.milestones, labels: m && m.labels, issues: cache ? cache.issues : [] });
    return { ok: true, change, queue: queue.for(dir), message: 'Staged: ' + change.summary };
  }),
  'POST /api/queue/remove': async (_q, body) => withRepo(dir =>
    ({ ok: true, queue: queue.remove(dir, String(body.id || '')), message: 'Removed from staged changes' })),
  'POST /api/queue/clear': async () => withRepo(dir =>
    ({ ok: true, queue: queue.clear(dir), message: 'Cleared staged changes' })),
  /* A push changes what's on GitHub, so this is the one mutation that re-pulls. */
  'POST /api/queue/push': async () => withRepo(async (dir) => {
    const r = await queue.push(dir, dir);
    metaCache.delete(dir);
    let refreshed = null;
    try { refreshed = await pullIssues(dir); } catch { issueCache.delete(dir); }
    return Object.assign(r, {
      queue: queue.for(dir),
      issues: refreshed ? refreshed.issues : undefined,
      issuesAt: refreshed ? refreshed.at : undefined,
      issuesLoaded: !!refreshed,
      insights: refreshed
        ? insightsFor(repos.selected.github, (await metaFor(dir)).milestones, refreshed.issues)
        : undefined,
    });
  }),

  'GET /api/ai/status': async () => {
    const cfg = aiConfig();
    const st = await llm.status(cfg.endpoint);
    return Object.assign(st, { config: cfg });
  },
  'POST /api/ai/config': async (_q, body) => {
    // Validate the endpoint before persisting it, so a bad scheme can't be saved at all.
    if (body.endpoint) {
      let u;
      try { u = new URL(String(body.endpoint).trim()); }
      catch { throw new HttpError(400, 'That is not a valid URL'); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new HttpError(400, 'The AI endpoint must be http:// or https:// — got ' + u.protocol);
      }
    }
    const cur = readConfig();
    const ai = Object.assign({}, cur.ai || {}, {
      enabled: body.enabled === undefined ? !!(cur.ai && cur.ai.enabled) : !!body.enabled,
      endpoint: body.endpoint ? String(body.endpoint).trim() : (cur.ai && cur.ai.endpoint) || llm.DEFAULT_ENDPOINT,
      model: body.model === undefined ? (cur.ai && cur.ai.model) || null : (body.model || null),
      embedModel: body.embedModel === undefined ? (cur.ai && cur.ai.embedModel) || null : (body.embedModel || null),
      concurrency: Math.max(1, Math.min(Number(body.concurrency) || (cur.ai && cur.ai.concurrency) || 2, 8)),
      temperature: body.temperature == null ? ((cur.ai && cur.ai.temperature) || 0) : Math.max(0, Math.min(Number(body.temperature), 1)),
      timeoutMs: Math.max(10000, Math.min(Number(body.timeoutMs) || (cur.ai && cur.ai.timeoutMs) || 300000, 1800000)),
    });
    // Switching models evicts the old one rather than leaving two competing for VRAM.
    const prev = (cur.ai && cur.ai.model) || null;
    const unloaded = [];
    if (prev && prev !== ai.model) {
      const r = await llm.unload(ai.endpoint, prev);
      if (r.ok) unloaded.push(prev);
    }
    const prevEmbed = (cur.ai && cur.ai.embedModel) || null;
    if (prevEmbed && prevEmbed !== ai.embedModel) {
      const r = await llm.unload(ai.endpoint, prevEmbed);
      if (r.ok) unloaded.push(prevEmbed);
    }
    writeConfig(Object.assign(cur, { ai }));
    const st = await llm.status(ai.endpoint);
    return Object.assign(st, {
      config: aiConfig(), ok: true,
      message: 'AI settings saved' + (unloaded.length ? ' · unloaded ' + unloaded.join(', ') : ''),
    });
  },

  'POST /api/ai/unload': async (_q, body) => {
    const cfg = aiConfig();
    const targets = body.model ? [String(body.model)] : [cfg.model, cfg.embedModel].filter(Boolean);
    const done = [];
    for (const m of targets) { const r = await llm.unload(cfg.endpoint, m); if (r.ok) done.push(m); }
    const st = await llm.status(cfg.endpoint);
    return Object.assign(st, { ok: true, config: cfg, message: done.length ? 'Unloaded ' + done.join(', ') : 'Nothing was loaded' });
  },

  'GET /api/auth': async () => { AUTH = await issueOps.authStatus(repos.selected && repos.selected.path); return AUTH; },

  'POST /api/ai/ignore': async (_q, body) => withRepo(() => {
    const slug = repos.selected.github || repos.selected.name;
    const title = String(body.title || '').trim();
    if (!title) throw new HttpError(400, 'Nothing to ignore');
    const list = loadIgnored(slug);
    if (!list.some(x => ignKey(x.title) === ignKey(title))) {
      list.unshift({ title, reason: String(body.reason || '').slice(0, 300) || null, at: new Date().toISOString() });
      saveIgnored(slug, list);
    }
    return { ok: true, ignored: list, message: 'Ignored — it will not be suggested again' };
  }),
  'POST /api/ai/unignore': async (_q, body) => withRepo(() => {
    const slug = repos.selected.github || repos.selected.name;
    const list = loadIgnored(slug).filter(x => ignKey(x.title) !== ignKey(String(body.title || '')));
    saveIgnored(slug, list);
    return { ok: true, ignored: list, message: 'Restored — it can be suggested again' };
  }),
  'GET /api/ai/ignored': async () => withRepo(() =>
    ({ ok: true, ignored: loadIgnored(repos.selected.github || repos.selected.name) })),

  'POST /api/ai/milestones': async (_q, body) => withRepo(async (dir) => {
    const cfg = requireAi();
    const m = await metaFor(dir);
    const cache = cachedIssues(dir);
    if (!cache) throw new HttpError(400, 'Pull issues first');
    // Only issues that classification could not place, or that the caller nominates.
    let orphans;
    if (Array.isArray(body.numbers) && body.numbers.length) {
      const want = new Set(body.numbers.map(Number));
      orphans = cache.issues.filter(i => want.has(i.n));
    } else {
      orphans = cache.issues.filter(i => i.st === 'OPEN' && !i.ms).slice(0, 30);
    }
    if (!orphans.length) return { ok: true, milestones: [], message: 'Every open issue already has a milestone' };
    const t0 = Date.now();
    const out = await llm.suggestMilestones(cfg, { orphans, milestones: m.milestones, planText: planFor(dir) });
    return {
      ok: true, milestones: out, consideredIssues: orphans.map(o => o.n),
      message: out.length
        ? `Proposed ${out.length} milestone${out.length === 1 ? '' : 's'} in ${((Date.now() - t0) / 1000).toFixed(0)}s`
        : 'The model thinks the existing milestones already cover these',
    };
  }),

  'POST /api/ai/plan': async (_q, body) => withRepo(async (dir) => {
    const cfg = requireAi();
    const m = await metaFor(dir);
    const cache = cachedIssues(dir);
    if (!cache) throw new HttpError(400, 'Pull issues first');
    const slug = repos.selected.github || repos.selected.name;
    const t0 = Date.now();
    const requestedCount = Math.max(3, Math.min(Number(body.count) || 10, 20));
    const phases = planOps.milestonePhases(m.milestones);
    const candidates = planOps.prioritizeIssues(
      planOps.assignIssuePhases(cache.issues, phases), m.milestones, phases);
    // Open issues arrive in deterministic priority order; closed issues follow so the
    // model can recognize already-completed commitments and avoid proposing duplicates.
    const planningIssues = candidates.concat(cache.issues.filter(issue => issue.st !== 'OPEN'));
    const generated = await llm.planInsights(cfg, {
      issues: planningIssues,
      milestones: m.milestones,
      labels: m.labels,
      planText: planFor(dir),
      count: requestedCount,
      gapCount: 5,
    });
    const gaps = planOps.normalizeGeneratedGaps(generated.gaps, {
      milestones: m.milestones,
      phases,
      issues: cache.issues,
      labels: m.labels,
      ignoredTitles: loadIgnored(slug),
      limit: 5,
      maxPriority: requestedCount,
    });
    const editorial = planOps.mergeRankedGaps(generated.ranked, gaps);
    // Persist only the model's editorial contribution. Dates, milestone membership,
    // completion, fallback entries, and milestone order are derived from GitHub on read.
    const saved = {
      schemaVersion: 2,
      repo: slug, source: 'editorial insights generated by ' + cfg.model,
      capturedAt: new Date().toISOString().slice(0, 10),
      generated: true,
      requestedCount,
      baselineNums: cache.issues.map(i => i.n),
      ranked: editorial,
      gaps,
    };
    try {
      fs.mkdirSync(path.join(CONFIG_DIR, 'plans'), { recursive: true });
      fs.writeFileSync(genFile(slug), JSON.stringify(saved, null, 2), { mode: 0o600 });
    } catch (e) { console.error('  ! could not save plan: ' + e.message); }
    const plan = planOps.hydratePlan(saved, m.milestones, cache.issues);
    return {
      ok: true, plan,
      message: `Built a ${plan.ranked.length}-step plan with ${gaps.length} missing-work insight${gaps.length === 1 ? '' : 's'} from ${phases.length} milestone${phases.length === 1 ? '' : 's'} in ${((Date.now() - t0) / 1000).toFixed(0)}s`,
    };
  }),

  'POST /api/ai/index': async (_q, body) => withRepo(async (dir) => {
    const cfg = requireAi();
    if (!cfg.embedModel) throw new HttpError(400, 'Pick an embedding model first');
    const slug = repos.selected.github || repos.selected.name;
    const t0 = Date.now();
    const r = await buildIndex(dir, slug, cfg, { force: !!body.force });
    return {
      ok: true, embedded: r.embedded, total: r.total, dim: r.idx.dim,
      indexed: Object.keys(r.idx.items).length,
      message: r.embedded
        ? `Embedded ${r.embedded} issue${r.embedded === 1 ? '' : 's'} in ${((Date.now() - t0) / 1000).toFixed(0)}s (${Object.keys(r.idx.items).length} indexed)`
        : `Index already current (${Object.keys(r.idx.items).length} issues)`,
    };
  }),

  /* Both AI actions return PROPOSALS. Nothing is staged or pushed without a click. */
  'POST /api/ai/classify': async (_q, body) => withRepo(async (dir) => {
    const cfg = requireAi();
    const m = await metaFor(dir);
    const cache = cachedIssues(dir);
    if (!cache) throw new HttpError(400, 'Pull issues first');
    let pick = cache.issues.filter(i => i.st === 'OPEN');
    if (!body.includeClassified) pick = pick.filter(i => !i.ms);
    if (Array.isArray(body.numbers) && body.numbers.length) {
      const want = new Set(body.numbers.map(Number));
      pick = cache.issues.filter(i => want.has(i.n));
    }
    pick = pick.slice(0, Math.max(1, Math.min(Number(body.limit) || 40, 200)));
    if (!pick.length) return { ok: true, proposals: [], message: 'Nothing to classify — every open issue already has a milestone' };

    // Retrieval is optional: without an embedding model this behaves exactly as before.
    let corpus = [], retrieved = false;
    if (cfg.embedModel && body.useRetrieval !== false) {
      try {
        const slug = repos.selected.github || repos.selected.name;
        const { idx } = await buildIndex(dir, slug, cfg);
        corpus = corpusFrom(dir, idx);
        pick = pick.map(i => Object.assign({}, i, { vec: idx.items[i.n] && idx.items[i.n].v }));
        retrieved = corpus.length > 0;
      } catch (e) { console.error('  ! retrieval unavailable: ' + e.message); }
    }
    const t0 = Date.now();
    const proposals = await llm.classify(cfg, { issues: pick, milestones: m.milestones, labels: m.labels, corpus });
    const n = proposals.filter(p => p.changed).length;
    return {
      ok: true, proposals, retrieved,
      message: `Classified ${pick.length} issue${pick.length === 1 ? '' : 's'} in ${((Date.now() - t0) / 1000).toFixed(0)}s — ${n} suggested change${n === 1 ? '' : 's'}` +
        (retrieved ? ` · used ${corpus.length} similar issues as precedent` : ''),
    };
  }),

  'POST /api/ai/suggest': async (_q, body) => withRepo(async (dir) => {
    const cfg = requireAi();
    const m = await metaFor(dir);
    const cache = cachedIssues(dir);
    // A planning doc, if the repo has one, is what makes suggestions specific.
    const planText = planFor(dir);
    const slug = repos.selected.github || repos.selected.name;
    const ignored = loadIgnored(slug);
    let corpusVecs = [];
    if (cfg.embedModel) {
      try {
        const { idx } = await buildIndex(dir, slug, cfg);
        corpusVecs = (cache ? cache.issues : [])
          .filter(i => idx.items[i.n])
          .map(i => ({ n: i.n, t: i.t, vec: idx.items[i.n].v }));
        // Ignored titles join the corpus so a rejected idea is not re-proposed in new
        // wording. This is the user's taste, remembered.
        if (ignored.length) {
          try {
            const igVecs = await llm.embed(cfg, ignored.map(g => g.title));
            ignored.forEach((g, k) => corpusVecs.push({ n: -1 - k, t: g.title, vec: igVecs[k] }));
          } catch { /* titles still filter by exact match below */ }
        }
      } catch (e) { console.error('  ! dedupe index unavailable: ' + e.message); }
    }
    const t0 = Date.now();
    const suggestions = await llm.suggest(cfg, {
      issues: cache ? cache.issues : [], milestones: m.milestones, labels: m.labels,
      planText, count: Number(body.count) || 5, corpusVecs,
    });
    const before = suggestions.length;
    const kept = suggestions.filter(x => !ignored.some(g => ignKey(g.title) === ignKey(x.title)));
    const dropped = before - kept.length;
    return {
      ok: true, suggestions: kept, usedPlan: !!planText, ignoredSkipped: dropped,
      message: `Suggested ${kept.length} issue${kept.length === 1 ? '' : 's'} in ${((Date.now() - t0) / 1000).toFixed(0)}s` +
        (dropped ? ` · skipped ${dropped} previously ignored` : ''),
    };
  }),

  'GET /api/dry-log': async () => ({ dryRun: ex.isDryRun(), entries: ex.dryLog() }),
};

/* ── http plumbing ───────────────────────────────────────────────── */

let BOUND_PORT = WANT_PORT;

function guardSource(req) {
  const hostname = String(req.headers.host || '').replace(/:\d+$/, '');
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
    throw new HttpError(403, 'Only loopback hosts are served');
  }
  const origin = req.headers.origin;
  if (origin && origin !== 'http://127.0.0.1:' + BOUND_PORT && origin !== 'http://localhost:' + BOUND_PORT) {
    throw new HttpError(403, 'Cross-origin requests are refused');
  }
}

function guardToken(req) {
  const sent = String(req.headers['x-vibe-git-token'] || '');
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (sent.length !== TOKEN.length ||
      !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(TOKEN))) {
    throw new HttpError(401, 'Bad or missing vibe-git token — reload the page');
  }
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > limit) { reject(new HttpError(413, 'Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); }
      catch { reject(new HttpError(400, 'Body was not valid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(buf);
}

// Only these files are ever served. No path from the request reaches the filesystem.
const STATIC = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
};

function serveStatic(res, entry) {
  let body;
  try { body = fs.readFileSync(path.join(WEB, entry.file), 'utf8'); }
  catch { return sendJson(res, 500, { error: entry.file + ' is missing from ' + WEB }); }
  if (entry.file === 'index.html') {
    const boot = JSON.stringify({ token: TOKEN, port: BOUND_PORT, dryRun: ex.isDryRun() })
      .replace(/</g, '\\u003c');               // cannot break out of the script element
    body = body
      .replace('/*BOOT_NONCE*/', CSP_NONCE)
      .replace('/*BOOT*/', 'window.__VIBE_GIT__=' + boot + ';');
  }
  const buf = Buffer.from(body);
  res.writeHead(200, {
    'Content-Type': entry.type,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      `default-src 'none'; script-src 'self' 'nonce-${CSP_NONCE}'; style-src 'self' 'unsafe-inline'; ` +
      "img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://' + HOST); }
  catch { return sendJson(res, 400, { error: 'Bad request URL' }); }

  try {
    // Check the page itself as well as /api. The page contains the per-run token, so
    // serving it to an attacker-controlled Host would defeat the API token via DNS
    // rebinding even though the server only listens on loopback.
    guardSource(req);
    const stat = STATIC[url.pathname];
    if (stat) {
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      return serveStatic(res, stat);
    }
    if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');

    guardToken(req);
    const handler = routes[req.method + ' ' + url.pathname];
    if (!handler) {
      const wrongMethod = Object.keys(routes).some(k => k.endsWith(' ' + url.pathname));
      throw new HttpError(wrongMethod ? 405 : 404, wrongMethod ? 'Method not allowed' : 'No such endpoint');
    }
    const body = req.method === 'POST' ? await readBody(req) : {};
    const result = await handler(url.searchParams, body);
    if (result && result.message) console.log('  ' + new Date().toLocaleTimeString() + '  ' + result.message);
    return sendJson(res, 200, result);

  } catch (err) {
    const status = (err instanceof HttpError) ? err.status : ((err && err.status) || 500);
    if (status >= 500) console.error('  ! ' + ((err && err.stack) || err));
    return sendJson(res, status, { error: String((err && err.message) || 'Unknown error') });
  }
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});
process.on('unhandledRejection', (e) => console.error('  ! unhandled: ' + ((e && e.message) || e)));

/* ── startup ─────────────────────────────────────────────────────── */

function listen(port) {
  const onError = (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error('\n  Port ' + port + ' is already in use. Try:  node server.js --port ' + (port + 1) + '\n');
      process.exit(1);
    }
    console.error('\n  Could not listen on ' + port + ': ' + e.message + '\n');
    process.exit(1);
  };
  server.removeAllListeners('error');
  server.once('error', onError);
  BOUND_PORT = port;
  server.listen(port, HOST, () => {
    server.removeAllListeners('error');
    server.on('error', (e) => console.error('  ! server error: ' + e.message));
    console.log('\n  ready →  http://' + HOST + ':' + BOUND_PORT + '/\n');
  });
}

(async () => {
  console.log('\n  vibe-git' + (ex.isDryRun() ? '   [DRY RUN — no writes]' : ''));
  try {
    const sel = await repos.autoSelect(opt('repo', null));
    console.log('  found ' + repos.list.length + ' repositor' + (repos.list.length === 1 ? 'y' : 'ies'));
    if (sel) console.log('  open:  ' + sel.name + (sel.github ? '  (' + sel.github + ')' : '  [no github remote]'));
    else console.log('  no repositories found — use --scan <dir> to point at your code');
  } catch (e) {
    console.error('  ! startup: ' + e.message);
  }
  listen(WANT_PORT);
})();
