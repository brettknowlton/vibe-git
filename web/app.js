'use strict';
/*
 * vibe-git front-end.
 *
 * One rule that matters: everything derived from a repo — issue titles, branch names,
 * file paths, commit subjects, logins, and model-authored plan prose — is rendered as
 * text or reconstructed from a tiny formatting allowlist. Untrusted HTML is never put
 * into the document, so it cannot become script in this privileged local origin.
 */

const BOOT = window.__VIBE_GIT__ || {};

/*
 * This file is served fresh on every reload; server.js is not, because Node loaded it once
 * at startup. Editing the front-end therefore takes effect immediately while the API behind
 * it does not, and a new button fails with "No such endpoint" for no visible reason.
 *
 * Must match API_VERSION in server.js. Bump both together when routes change.
 */
const APP_API = 3;
const staleServer = () => Number(BOOT.api || 0) !== APP_API;
let S = null;                 // last server state
let VIEW = 'issues';
let SEL = { issue: null, file: null, commit: null };
const FILTER = { phase: null, milestone: null, label: null, q: '', state: 'open', un: false, ready: false };

/*
 * Search is a layer over the filter, not a replacement for it. When it has hits they
 * constrain and reorder the list; when it does not, the plain substring filter still runs,
 * so typing never leaves you looking at nothing while a request is in flight.
 */
const SEARCH = { q: '', hits: null, mode: null, error: null, busy: false, seq: 0 };
let DEPS = null;              // dependency structure, refreshed with the issue list
let CHECKED = new Set();      // files ticked for the next commit
const COMMIT_DRAFT = { subject: '', body: '' };

/* ── tiny DOM helper ─────────────────────────────────────────────── */
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    /*
     * Custom properties need setProperty. `Object.assign(el.style, {'--c': …})` looks like
     * it works and does nothing at all: CSSStyleDeclaration has no '--c' setter, so the
     * assignment lands on the JS object and never reaches CSS. Every milestone colour in
     * the app is passed this way, so all of them were quietly falling back to their
     * defaults — the plan's rank gutters were all --p0, the milestone dots had no
     * background, and the timeline bands lost their order entirely.
     */
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (val == null) continue;
        if (prop.startsWith('--')) e.style.setProperty(prop, String(val));
        else e.style[prop] = val;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(9)) {
    if (kid == null || kid === false) continue;
    e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

/*
 * append() for a builder that may decline to build anything.
 *
 * The trap is that `el.append(null)` does not skip — it stringifies, so a section that
 * returns null when it has nothing to show prints the word "null" into the page. h()
 * already drops nullish children; this is the same rule for the direct-append path.
 */
function put(parent, ...nodes) {
  for (const node of nodes.flat(9)) {
    if (node == null || node === false) continue;
    parent.append(node);
  }
  return parent;
}

/* Insights may come from a checked-in JSON file or a local model. Preserve the small
   amount of useful emphasis they use without trusting their HTML or attributes. */
function rich(s) {
  const doc = new DOMParser().parseFromString('<body>' + String(s == null ? '' : s) + '</body>', 'text/html');
  const allowed = new Map([
    ['B', 'b'], ['STRONG', 'strong'], ['I', 'i'], ['EM', 'em'], ['CODE', 'code'], ['BR', 'br'],
  ]);
  const copy = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.nodeValue || '');
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    if (['SCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'OBJECT'].includes(node.tagName)) return null;
    const out = document.createElement(allowed.get(node.tagName) || 'span');
    for (const child of node.childNodes) {
      const safe = copy(child); if (safe) out.append(safe);
    }
    return out;
  };
  const out = document.createDocumentFragment();
  for (const child of doc.body.childNodes) {
    const safe = copy(child); if (safe) out.append(safe);
  }
  return out;
}
const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };
const pc = (n) => (n == null ? 'var(--fg-dim)' : 'var(--p' + (((Number(n) % 6) + 6) % 6) + ',var(--fg-dim))');
const $ = (id) => document.getElementById(id);

/* ── api ─────────────────────────────────────────────────────────── */
async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: Object.assign({ 'X-Vibe-Git-Token': BOOT.token || '' },
      body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); }
  catch { throw new Error('Server sent a malformed response (HTTP ' + res.status + ')'); }
  if (!res.ok) throw new Error(data && data.error ? data.error : 'HTTP ' + res.status);
  return data;
}
const led = (cls, title) => { $('led').className = 'led ' + cls; $('led').title = title || cls; };

let toastTimer = null;
function toast(text, kind) {
  const old = document.querySelector('.toast'); if (old) old.remove();
  const t = h('div', { class: 'toast ' + (kind || '') }, text);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), kind === 'bad' ? 8000 : 3400);
}

/* Two-stage confirm: the first click only arms the button. Nothing destructive or
   outward-facing ever happens on a single stray click. */
function arm(btn, label, confirmLabel, fn) {
  let armed = false, timer = null;
  const reset = () => { armed = false; btn.textContent = label; btn.classList.remove('armed'); };
  btn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (!armed) {
      armed = true; btn.textContent = confirmLabel; btn.classList.add('armed');
      clearTimeout(timer); timer = setTimeout(reset, 4500);
      return;
    }
    clearTimeout(timer); armed = false; btn.classList.remove('armed');
    btn.disabled = true; btn.textContent = 'working…';
    try { await fn(); }
    catch (e) { toast(e.message, 'bad'); btn.disabled = false; reset(); }
  });
  return btn;
}

/*
 * How much to refresh after an action:
 *   'queue' — the response already carries the new queue; touch nothing else. No network.
 *   'git'   — reload state (git calls are ~0ms; issues come from cache).
 *   'full'  — reload state and re-pull issues.
 * Staging used to trigger a full reload, which meant ~2.3s of dead air per label toggle.
 */
async function act(fn, refresh) {
  busy(true);
  try {
    const r = await fn();
    if (r && r.message) toast(r.message, r.ok === false ? 'bad' : 'good');
    const mode = refresh || 'git';
    if (mode === 'queue' && r && r.queue) {
      if (r.issues) { S.issues = r.issues; S.issuesLoaded = true; S.issuesAt = r.issuesAt; S.issuesStored = false; stampNow(); }
      if (r.insights) S.insights = r.insights;
      S.queue = r.queue;
      render();
    } else if (mode === 'full') {
      await load();
      await pullIssues();
    } else {
      await load();
    }
    return r;
  } catch (e) { toast(e.message, 'bad'); throw e; }
  finally { busy(false); }
}

/* ── busy tracking ───────────────────────────────────────────────── */
/* A monotonic id per state load. A response from an older load is discarded rather than
   clobbering a newer one — and no load is ever *skipped*, which the old LOADING flag did
   (it silently swallowed an action's refresh and left the UI stale). */
let loadSeq = 0;
let busyCount = 0;
function busy(on) {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  const bar = $('progress');
  if (bar) bar.hidden = busyCount === 0;
  if (busyCount) led('busy', 'working');
}

/* ── load / render ───────────────────────────────────────────────── */
async function load(opts) {
  const mine = ++loadSeq;
  busy(true);
  try {
    const previousPath = S && S.selected ? S.selected.path : null;
    const next = await api('/api/state' + (opts && opts.fresh ? '?fresh=1' : ''));
    if (mine !== loadSeq) return;                  // a newer load already won
    const nextPath = next.selected ? next.selected.path : null;
    if (previousPath && nextPath !== previousPath) resetRepoUi();
    S = next;
    IGNORED_TITLES = S.ignoredTitles || [];
    led('ok', 'connected');
    stampNow();
    render();
    // Only when the server has nothing at all — no memory cache and no stored file. Once a
    // repository has been pulled once, opening it again reads the local copy and waits for
    // the user to ask for a refresh instead of spending seconds on `gh` at every launch.
    if (S.selected && S.selected.github && !S.issuesLoaded && !S.githubError) pullIssues();
  } catch (e) {
    if (mine !== loadSeq) return;
    led('bad', e.message);
    clear($('pane')).append(
      h('div', { class: 'banner' },
        h('b', {}, 'Cannot reach the vibe-git server. '), e.message,
        h('br'), h('br'), 'Start it with ', h('code', {}, 'node server.js'), ' and reload.'));
  } finally { busy(false); }
}

/* Selections and drafts describe one repository. Carrying them across a repo switch is
   confusing at best and could put a commit message or AI proposal beside the wrong repo. */
function resetRepoUi() {
  FILTER.phase = null; FILTER.milestone = null; FILTER.q = ''; FILTER.state = 'open'; FILTER.un = false;
  SEL = { issue: null, file: null, commit: null, pr: null };
  CHECKED.clear(); COMMIT_DRAFT.subject = ''; COMMIT_DRAFT.body = '';
  PRS = []; prLoaded = false;
  PROPOSALS = []; SUGGESTIONS = []; MILESTONES = []; NEW_LABELS = []; DUPES = [];
  PICKED = new Set(); lastPicked = null; DEPS = null;
  SEARCH.q = ''; SEARCH.hits = null; SEARCH.mode = null; SEARCH.error = null; SEARCH.busy = false;
  commitSummaryBusy = false; commitSummarySeq++;
  showHandledGaps = false; showHiddenPlan = false;
  // A conversation is about one repository — its answers would be wrong beside another.
  CHAT = []; CHAT_TRACE = new Map(); CHAT_PROPOSALS = []; chatDraft = '';
  planChoice = false; planBannerOff = false;
  // A milestone or label from the previous repository is not a scope in this one; carrying
  // it over would reject the next plan request as an unknown milestone.
  planScope = { milestone: null, label: null };
  FILTER.label = null;
}

/* Coarse on purpose: the question a cached list raises is "roughly how stale", not "when". */
function ago(iso) {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.round(hours / 24);
  return days + 'd ago';
}

function stampNow() {
  $('stamp').textContent = S && S.issuesAt
    ? 'issues ' + new Date(S.issuesAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';
}

/* The only path that fetches issues. Everything else works from what's already loaded. */
let pulling = false;
async function pullIssues() {
  if (pulling || !S || !S.selected || !S.selected.github) return;
  pulling = true; busy(true);
  renderNav();
  try {
    const r = await api('/api/issues/pull', {});
    S.issues = r.issues; S.truncated = r.truncated;
    S.issuesLoaded = true; S.issuesAt = r.issuesAt; S.issuesStored = false;
    if (r.insights) S.insights = r.insights;
    stampNow(); render();
    loadDeps().then(() => { if (VIEW === 'issues') renderIssueList(); });
    toast(r.message, 'good');
  } catch (e) { toast(e.message, 'bad'); }
  finally { pulling = false; busy(false); renderNav(); }
}

function render() {
  if (!S) return;
  renderTop(); renderNav(); renderSide(); renderPane();
  if (railOpen) renderRail();
}

/* ── top bar ─────────────────────────────────────────────────────── */
function renderTop() {
  $('dry-badge').hidden = !S.dryRun;
  /* Remote sessions look identical to local ones, and they are not: this window can push
     to GitHub as you from a device that is not this machine. Say so, permanently. */
  const remote = $('remote-badge');
  if (remote) {
    remote.hidden = BOOT.scope !== 'tailnet';
    remote.textContent = BOOT.user ? 'tailnet · ' + BOOT.user : 'tailnet';
    remote.title = 'Reached over Tailscale, not from this machine. Pushes still act as your GitHub account.';
  }
  const sel = S.selected;
  clear($('tb-repo-v')).append(sel ? sel.name : 'No repository',
    sel && sel.github ? h('small', {}, sel.github) : (sel ? h('small', {}, 'local only') : null));

  const g = S.git;
  clear($('tb-branch-v')).append(g && g.status.branch ? g.status.branch : (g ? 'detached HEAD' : '—'));
  $('tb-branch').disabled = !g;

  const st = g && g.status;
  $('tb-sync-k').textContent = !st ? 'Sync' : (st.behind ? 'Pull origin' : (st.ahead ? 'Push origin' : 'Fetch origin'));
  const v = clear($('tb-sync-v'));
  if (!st) v.append('—');
  else if (st.ahead || st.behind) {
    v.append(h('span', { class: 'abbadge' },
      st.behind ? h('span', { class: 'down' }, '↓ ' + st.behind) : null,
      st.ahead ? h('span', { class: 'up' }, '↑ ' + st.ahead) : null));
  } else v.append(st.upstream ? 'up to date' : 'no upstream');
  $('tb-sync').disabled = !g;
}

/* ── nav ─────────────────────────────────────────────────────────── */
function renderNav() {
  const open = S.issues.filter(i => i.st === 'OPEN').length;
  $('c-issues').textContent = pulling ? '…' : (S.issuesLoaded ? open : '—');
  const plan = $('c-plan');
  plan.textContent = S.insights ? S.insights.ranked.length : '—';
  plan.classList.toggle('stale', !!(S.planStatus && S.planStatus.stale));
  plan.title = S.planStatus && S.planStatus.stale ? driftText(S.planStatus) : '';
  $('c-changes').textContent = S.git ? S.git.status.files.length : '—';
  $('c-history').textContent = S.git ? S.git.log.length : '—';
  const cp = $('c-prs'); if (cp) cp.textContent = prLoaded ? PRS.length : '—';
  const q = $('c-staged');
  q.textContent = S.queue.length;
  q.classList.toggle('hot', S.queue.length > 0);
  const pip = $('ai-pip');
  if (pip) pip.className = (aiBusy || chatBusy || commitSummaryBusy) ? 'busy'
    : (!AI || !AI.ok) ? 'bad'
    : (AI.config && AI.config.enabled && AI.config.model) ? 'on' : '';

  $('nav').querySelectorAll('button').forEach(b => {
    b.setAttribute('aria-current', String(b.dataset.view === VIEW));
    if (b.dataset.view === 'plan') b.disabled = !S.insights;
  });
}

/* ── sidebar ─────────────────────────────────────────────────────── */
function renderSide() {
  const body = clear($('side-body'));
  const foot = clear($('side-foot'));

  if (!S.selected) {
    body.append(h('div', { class: 'empty' }, 'No repository selected.\nUse the menu above to add one.'));
    return;
  }

  if (VIEW === 'issues') return sideIssues(body, foot);
  if (VIEW === 'plan') return sidePlan(body, foot);
  if (VIEW === 'changes') return sideChanges(body, foot);
  if (VIEW === 'history') return sideHistory(body, foot);
  if (VIEW === 'prs') return sidePrs(body, foot);
  if (VIEW === 'staged') return sideStaged(body, foot);
}

function visibleIssues() {
  const ranked = SEARCH.hits && SEARCH.q === FILTER.q ? SEARCH.hits : null;
  const readySet = FILTER.ready && DEPS ? new Set(DEPS.ready) : null;
  const rows = S.issues.filter(i => {
    if (FILTER.state === 'open' && i.st !== 'OPEN') return false;
    if (FILTER.state === 'closed' && i.st !== 'CLOSED') return false;
    if (FILTER.phase !== null && i.p !== FILTER.phase) return false;
    if (FILTER.milestone === '__none__' && i.ms) return false;
    if (FILTER.milestone && FILTER.milestone !== '__none__' && i.ms !== FILTER.milestone) return false;
    if (FILTER.label === '__none__' && i.l.length) return false;
    if (FILTER.label && FILTER.label !== '__none__' && !i.l.includes(FILTER.label)) return false;
    if (FILTER.un && i.a.length) return false;
    if (readySet && !readySet.has(i.n)) return false;
    if (!FILTER.q) return true;
    // With search results in hand, membership is the search's call; otherwise substring.
    if (ranked) return ranked.has(i.n);
    return i.t.toLowerCase().includes(FILTER.q) || String(i.n).includes(FILTER.q);
  });
  // Relevance order while searching, newest-first otherwise.
  return ranked
    ? rows.sort((a, b) => (ranked.get(b.n).score - ranked.get(a.n).score) || b.n - a.n)
    : rows.sort((a, b) => b.n - a.n);
}

/*
 * Searching happens on the server because that is where the embeddings live. It is
 * debounced and sequenced: a slow reply for "che" must never overwrite the results for
 * "chest", and the box you are typing into is never re-rendered out from under you.
 */
let searchTimer = null;
function queueSearch(query) {
  clearTimeout(searchTimer);
  const q = String(query || '').trim();
  if (q.length < 2) {
    SEARCH.q = ''; SEARCH.hits = null; SEARCH.mode = null; SEARCH.error = null; SEARCH.busy = false;
    renderIssueList();
    return;
  }
  SEARCH.busy = true;
  renderIssueList();
  searchTimer = setTimeout(async () => {
    const mine = ++SEARCH.seq;
    try {
      const r = await api('/api/issues/search', { q, state: FILTER.state, limit: 60 });
      if (mine !== SEARCH.seq) return;
      SEARCH.q = q.toLowerCase();
      SEARCH.hits = new Map(r.hits.map(h => [h.number, h]));
      SEARCH.mode = r.mode;
      SEARCH.error = r.embedError || null;
    } catch (e) {
      if (mine !== SEARCH.seq) return;
      SEARCH.hits = null; SEARCH.error = e.message;
    } finally {
      if (mine === SEARCH.seq) { SEARCH.busy = false; renderIssueList(); }
    }
  }, 220);
}

async function loadDeps() {
  if (!S || !S.issuesLoaded) return;
  try { DEPS = await api('/api/issues/dependencies'); }
  catch { DEPS = null; }
}

function sideIssues(body, foot) {
  /*
   * The filter bar is built ONCE and never re-rendered. Rebuilding it on every keystroke
   * destroyed the <input> the user was typing into, so focus and caret were lost after
   * each character. Only the list below it redraws.
   */
  const bar = h('div', { style: { padding: '10px 11px', borderBottom: '1px solid var(--line-soft)' } },
    h('div', { class: 'filters' },
      (() => {
        const inp = h('input', {
          type: 'search', id: 'issue-search', placeholder: 'Search issues by meaning…', value: FILTER.q,
          title: 'Plain words match text; a phrase like "shop and house share a wall" matches meaning',
          style: { flex: '1 1 100%', maxWidth: 'none' },
        });
        inp.addEventListener('input', () => {
          FILTER.q = inp.value.toLowerCase().trim();
          queueSearch(inp.value);               // list only — the input keeps focus
          renderIssueList();
        });
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { inp.value = ''; FILTER.q = ''; queueSearch(''); renderIssueList(); }
        });
        return inp;
      })(),
      (() => {
        const sel = h('select', { style: { flex: '1 1 auto' } },
          ...[['open', 'Open'], ['closed', 'Closed'], ['all', 'All']].map(([v, t]) =>
            h('option', { value: v, selected: FILTER.state === v }, t)));
        sel.addEventListener('change', () => { FILTER.state = sel.value; renderIssueList(); });
        return sel;
      })(),
      (() => {
        const milestones = [...new Set([
          ...((S.github && S.github.milestones) || []).map(m => m.title),
          ...S.issues.map(i => i.ms).filter(Boolean),
        ])].sort((a, b) => a.localeCompare(b));
        const sel = h('select', { title: 'Filter by milestone', style: { flex: '1 1 100%' } },
          h('option', { value: '', selected: FILTER.milestone === null }, 'All milestones'),
          h('option', { value: '__none__', selected: FILTER.milestone === '__none__' }, 'No milestone'),
          ...milestones.map(ms => h('option', {
            value: ms, selected: FILTER.milestone === ms,
          }, ms)));
        sel.addEventListener('change', () => {
          FILTER.milestone = sel.value || null;
          renderIssueList();
        });
        return sel;
      })(),
      /*
       * Labels, counted over the issues actually loaded rather than over the repository's
       * label list — a tracker usually defines far more labels than it uses, and a
       * dropdown of forty names that mostly select nothing is worse than no dropdown.
       */
      (() => {
        const used = new Map();
        S.issues.forEach(i => i.l.forEach(name => used.set(name, (used.get(name) || 0) + 1)));
        const names = [...used.keys()].sort((a, b) => a.localeCompare(b));
        const sel = h('select', { title: 'Filter by label', style: { flex: '1 1 100%' } },
          h('option', { value: '', selected: FILTER.label === null }, 'All labels'),
          h('option', { value: '__none__', selected: FILTER.label === '__none__' }, 'No label'),
          ...names.map(name => h('option', {
            value: name, selected: FILTER.label === name,
          }, name + '  (' + used.get(name) + ')')));
        sel.addEventListener('change', () => {
          FILTER.label = sel.value || null;
          renderIssueList();
        });
        return sel;
      })(),
      (() => {
        const b = h('button', { class: 'btn sm', 'aria-pressed': String(FILTER.un) }, 'Unassigned');
        b.addEventListener('click', () => {
          FILTER.un = !FILTER.un;
          b.setAttribute('aria-pressed', String(FILTER.un));
          renderIssueList();
        });
        return b;
      })(),
      /* The question a tracker should be able to answer and normally cannot: what can I
         actually start right now, given what everything else is waiting on. */
      (() => {
        const b = h('button', {
          class: 'btn sm', 'aria-pressed': String(FILTER.ready),
          title: 'Open issues that are not waiting on another open issue',
        }, 'Ready');
        b.addEventListener('click', async () => {
          FILTER.ready = !FILTER.ready;
          b.setAttribute('aria-pressed', String(FILTER.ready));
          if (FILTER.ready && !DEPS) await loadDeps();
          renderIssueList();
        });
        return b;
      })()));
  body.append(bar);

  body.append(h('div', { class: 'bulk-bar', id: 'bulk-bar', hidden: true }));
  const list = h('div', { id: 'issue-list' });
  body.append(list);

  const staged = S.queue.length;
  foot.append(h('div', { style: { display: 'flex', gap: '7px' } },
    h('button', { class: 'btn wide', disabled: pulling || !S.selected.github, onclick: () => pullIssues() },
      pulling ? 'Pulling…' : 'Pull issues'),
    h('button', { class: 'btn primary wide', onclick: () => { SEL.issue = 'new'; renderPane(); } }, '+ New issue')));
  foot.append(h('button', {
    class: 'btn wide' + (staged ? ' primary' : ''), disabled: !staged,
    onclick: () => act(() => api('/api/queue/push', {}), 'queue'),
  }, staged
      ? (S.dryRun ? 'Dry-run push ' : 'Push ') + staged + ' issue change' + (staged === 1 ? '' : 's')
      : 'No issue changes staged'));
  foot.append(h('span', { class: 'lab', id: 'issue-count' }, ''));
  // Last, not before the footer is built: renderIssueList writes into #issue-count, and
  // running it first meant the count line stayed blank until some later re-render
  // happened to fill it in.
  renderIssueList();
}

/* Redraws only the rows, so the filter input above keeps focus and caret position. */
function renderIssueList() {
  const list = $('issue-list');
  if (!list) return;
  clear(list);
  const stagedFor = new Set(S.queue.filter(c => c.payload && c.payload.number).map(c => c.payload.number));
  const rows = visibleIssues();
  const ranked = SEARCH.hits && SEARCH.q === FILTER.q ? SEARCH.hits : null;
  const blocked = DEPS ? new Map(DEPS.blocked.map(b => [b.number, b.waitingOn])) : null;
  if (!rows.length) {
    list.append(h('div', { class: 'empty' },
      pulling ? 'Pulling issues…'
        : SEARCH.busy ? 'Searching…'
          : (S.issuesLoaded ? 'No issues match those filters.' : 'Issues not pulled yet.')));
  }
  rows.forEach(i => {
    const hit = ranked && ranked.get(i.n);
    const waits = blocked && blocked.get(i.n);
    list.append(h('div', {
      class: 'irow' + (i.st === 'CLOSED' ? ' closed' : '') + (isPicked(i.n) ? ' picked' : ''),
      'aria-selected': String(SEL.issue === i.n),
      style: { '--c': pc(i.p), gridTemplateColumns: '52px 1fr auto' },
      onclick: (e) => {
        // Modifier-clicks build a selection; a plain click still just opens the issue.
        if (e.shiftKey || e.ctrlKey || e.metaKey) { togglePick(i.n, e.shiftKey); return; }
        SEL.issue = i.n; renderIssueList(); renderPane();
      },
    },
      h('span', { class: 'n' }, '#' + i.n),
      h('span', { class: 't' }, i.t,
        h('span', { class: 'sub' }, (i.ms || 'no milestone') + (i.a.length ? ' · ' + i.a[0] : '') +
          (waits && waits.length ? ' · waiting on ' + waits.map(n => '#' + n).join(' ') : ''))),
      h('span', { class: 'meta' },
        hit && hit.why === 'similar meaning'
          ? h('span', { class: 'why-chip', title: 'matched by meaning, not words' }, '≈') : null,
        waits && waits.length ? h('span', { class: 'why-chip blocked', title: 'blocked' }, '⛔') : null,
        stagedFor.has(i.n) ? h('span', { class: 'staged-pip', title: 'has staged changes' }) : null,
        i.p != null ? h('span', { class: 'dot', style: { '--c': pc(i.p) }, title: i.ms }) : null)));
  });
  const c = $('issue-count');
  if (c) {
    const bits = [rows.length + ' shown', S.issues.length + ' loaded'];
    if (SEARCH.busy) bits.push('searching…');
    else if (ranked) bits.push(SEARCH.mode === 'hybrid' ? 'text + meaning' : 'text only');
    if (SEARCH.error) bits.push(SEARCH.error);
    if (!S.issuesLoaded) bits.push('not pulled yet');
    // A list restored from disk is real but not current; say which it is and how old.
    else if (S.issuesStored) bits.push('from local cache' + (S.issuesAt ? ' · ' + ago(S.issuesAt) : ''));
    if (PICKED.size) bits.push(PICKED.size + ' selected');
    c.textContent = bits.join(' · ');
  }
  renderBulkBar();
}

/* ── bulk selection ──────────────────────────────────────────────── */
/*
 * Triaging 64 issues one click at a time is the actual cost of an issue tracker, and it is
 * the thing every GUI for GitHub makes you do. Selection here is ordinary list behaviour —
 * ctrl-click one, shift-click a range — and every bulk action produces ordinary staged
 * changes, so a bad sweep is removed from the queue rather than undone on GitHub.
 */
let PICKED = new Set();
let lastPicked = null;

const isPicked = (n) => PICKED.has(n);

function togglePick(number, range) {
  if (range && lastPicked != null) {
    const order = visibleIssues().map(i => i.n);
    const from = order.indexOf(lastPicked), to = order.indexOf(number);
    if (from > -1 && to > -1) {
      const [lo, hi] = from < to ? [from, to] : [to, from];
      for (let k = lo; k <= hi; k++) PICKED.add(order[k]);
    }
  } else if (PICKED.has(number)) {
    PICKED.delete(number);
  } else {
    PICKED.add(number);
  }
  lastPicked = number;
  renderIssueList();
}

function clearPicked() { PICKED = new Set(); lastPicked = null; renderIssueList(); }

/* Staging N changes means N validations; one failure must not abandon the rest. */
async function bulkStage(build, describe) {
  const numbers = [...PICKED];
  if (!numbers.length) return;
  busy(true);
  let staged = 0; const failures = [];
  try {
    for (const number of numbers) {
      const payload = build(number);
      if (!payload) continue;
      try { await api('/api/queue/add', { kind: 'edit', payload }); staged++; }
      catch (e) { failures.push('#' + number + ': ' + e.message); }
    }
    await load();
    clearPicked();
    toast(staged
      ? `Staged ${describe} on ${staged} issue${staged === 1 ? '' : 's'}` +
        (failures.length ? ` · ${failures.length} skipped` : '')
      : 'Nothing to stage — ' + (failures[0] || 'they already look like that'),
    staged ? 'good' : 'bad');
    if (failures.length) console.warn('bulk staging skipped:\n' + failures.join('\n'));
  } finally { busy(false); }
}

function renderBulkBar() {
  const host = $('bulk-bar');
  if (!host) return;
  clear(host);
  host.hidden = PICKED.size === 0;
  if (!PICKED.size) return;
  const gh = S.github || { milestones: [], labels: [], assignable: [] };
  const picked = S.issues.filter(i => PICKED.has(i.n));

  const menu = (label, items, onPick) => {
    const sel = h('select', { class: 'bulk-select' },
      h('option', { value: '' }, label),
      ...items.map(v => h('option', { value: v }, v)));
    sel.addEventListener('change', () => { if (sel.value) { onPick(sel.value); sel.value = ''; } });
    return sel;
  };

  host.append(
    h('span', { class: 'lab' }, PICKED.size + ' selected'),
    menu('Set milestone…', gh.milestones.map(m => m.title),
      (v) => bulkStage(n => {
        const issue = S.issues.find(i => i.n === n);
        return issue && issue.ms === v ? null : { number: n, milestone: v };
      }, 'milestone → ' + v)),
    menu('Add label…', gh.labels.map(l => l.name),
      (v) => bulkStage(n => {
        const issue = S.issues.find(i => i.n === n);
        return issue && issue.l.includes(v) ? null : { number: n, addLabels: [v] };
      }, '+' + v)),
    menu('Remove label…', gh.labels.map(l => l.name),
      (v) => bulkStage(n => {
        const issue = S.issues.find(i => i.n === n);
        return issue && issue.l.includes(v) ? { number: n, removeLabels: [v] } : null;
      }, '−' + v)),
    gh.assignable.length ? menu('Assign…', gh.assignable.slice(0, 24),
      (v) => bulkStage(n => {
        const issue = S.issues.find(i => i.n === n);
        return issue && issue.a.includes(v) ? null : { number: n, addAssignees: [v] };
      }, 'assign ' + v)) : null,
    h('button', {
      class: 'btn sm', title: 'Stage a close for every selected issue',
      onclick: async () => {
        const open = picked.filter(i => i.st === 'OPEN');
        if (!open.length) return toast('None of those are open', 'bad');
        busy(true);
        let n = 0;
        try {
          for (const issue of open) {
            try { await api('/api/queue/add', { kind: 'close', payload: { number: issue.n, reason: 'completed' } }); n++; }
            catch { /* already staged, most likely */ }
          }
          await load(); clearPicked();
          toast('Staged ' + n + ' close' + (n === 1 ? '' : 's'), n ? 'good' : 'bad');
        } finally { busy(false); }
      },
    }, 'Stage close'),
    h('button', { class: 'btn sm', onclick: () => clearPicked() }, 'Clear'));
}

function sidePlan(body, foot) {
  const ins = S.insights;
  if (!ins) return body.append(h('div', { class: 'empty' }, 'No plan is available for this repository.'));
  body.append(h('div', { style: { padding: '11px' } },
    h('span', { class: 'lab' }, 'Milestones'),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px', marginTop: '7px' } },
      h('button', {
        class: 'btn wide', onclick: () => { FILTER.phase = null; render(); },
        style: FILTER.phase === null ? { background: 'var(--fill)', color: 'var(--fill-fg)', borderColor: 'var(--fill)' } : {},
      }, 'All milestones'),
      ...ins.phases.map(p => h('button', {
        class: 'btn wide', style: Object.assign({ borderLeft: '3px solid ' + pc(p.n) },
          FILTER.phase === p.n ? { background: 'var(--fill)', color: 'var(--fill-fg)' } : {}),
        onclick: () => { FILTER.phase = FILTER.phase === p.n ? null : p.n; render(); },
      }, p.name)))));
  foot.append(h('span', { class: 'lab' }, ins.source));
}

/*
 * Stashes, listed whether or not the tree is dirty.
 *
 * Pop used to sit below the file list, so a clean tree — the one state in which a stash is
 * the only thing you could possibly want to restore — offered no way to get at it. Each
 * stash is named and popped or dropped individually rather than assuming stash@{0}.
 */
function stashBlock() {
  const stashes = (S.git && S.git.stashes) || [];
  if (!stashes.length) return null;
  const box = h('div', { class: 'stashes' },
    h('span', { class: 'lab' }, stashes.length + ' stash' + (stashes.length === 1 ? '' : 'es')));
  stashes.forEach(s => box.append(h('div', { class: 'srow' },
    h('span', { class: 't', title: s.subject }, s.subject),
    h('div', { class: 'acts' },
      h('button', {
        class: 'btn sm primary', title: 'Restore ' + s.id + ' into the working tree',
        onclick: () => act(() => api('/api/git/stash', { action: 'pop', ref: s.id }), 'git'),
      }, 'Pop'),
      arm(h('button', { class: 'btn sm danger' }, 'Drop'),
        'Drop', 'Confirm — cannot be undone',
        () => act(() => api('/api/git/stash', { action: 'drop', ref: s.id }), 'git'))))));
  return box;
}

function sideChanges(body, foot) {
  const files = S.git ? S.git.status.files : [];
  if (!files.length) {
    body.append(h('div', { class: 'empty' }, 'No local changes.'));
    put(body, stashBlock());
    // A clean tree is the usual moment to open a pull request, so the button has to be
    // here too — not only on the branch that still has uncommitted work in it.
    if (S.selected.github) foot.append(newPrButton());
    return;
  }
  const allOn = files.every(f => CHECKED.has(f.path));
  body.append(h('label', {
    class: 'frow', style: { borderBottom: '1px solid var(--line)', background: 'var(--surface2)' },
  },
    h('input', {
      type: 'checkbox', checked: allOn,
      onchange: (e) => {
        if (e.target.checked) files.forEach(f => CHECKED.add(f.path)); else CHECKED.clear();
        renderSide(); renderPane();
      },
    }),
    h('span', { class: 'p', style: { direction: 'ltr', fontWeight: '600' } },
      files.length + ' changed file' + (files.length === 1 ? '' : 's'))));

  files.forEach(f => {
    body.append(h('div', {
      class: 'frow', 'aria-selected': String(SEL.file === f.path),
      onclick: (e) => { if (e.target.type !== 'checkbox') { SEL.file = f.path; renderSide(); renderPane(); } },
    },
      h('input', {
        type: 'checkbox', checked: CHECKED.has(f.path),
        onchange: (e) => { e.target.checked ? CHECKED.add(f.path) : CHECKED.delete(f.path); renderSide(); },
      }),
      h('span', { class: 'p', title: f.path }, f.path),
      h('span', { class: 's ' + f.status, title: f.status }, f.status.slice(0, 4))));
  });

  const st = S.git.status;
  const extras = h('div', { class: 'acts', style: { marginBottom: '4px' } },
    h('button', {
      class: 'btn sm', title: 'Move HEAD back one commit and keep the changes',
      onclick: () => act(() => api('/api/git/undo', {}), 'git'),
    }, 'Undo last commit'),
    h('button', {
      class: 'btn sm', disabled: st.clean, title: 'Set the changes aside',
      onclick: () => act(() => api('/api/git/stash', { action: 'push' }), 'git'),
    }, 'Stash'));
  foot.append(extras);
  // Popping is per-stash in stashBlock, so it is the same control in both states.
  put(foot, stashBlock());

  const n = CHECKED.size;
  const subjectInput = h('input', {
    type: 'text', id: 'ci-subject', value: COMMIT_DRAFT.subject,
    placeholder: n ? 'Summary (required)' : 'Summary (for amend, or tick files)',
    oninput: (e) => { COMMIT_DRAFT.subject = e.target.value; },
  });
  const bodyInput = h('textarea', {
    id: 'ci-body', placeholder: 'Description',
    oninput: (e) => { COMMIT_DRAFT.body = e.target.value; },
  }, COMMIT_DRAFT.body);
  const box = h('div', { class: 'commitbox' },
    subjectInput,
    bodyInput,
    assistantAvailable() ? (commitSummaryBusy
      ? h('button', {
        class: 'btn wide danger', title: 'Stop the model',
        onclick: () => { const j = COMMIT_JOB; if (j) api('/api/ai/cancel', { jobId: j }).catch(() => {}); },
      }, h('span', { class: 'spin' }), 'Summarizing — cancel')
      : h('button', {
        class: 'btn wide', disabled: !n,
        title: n ? 'Draft an editable commit message from the selected changes' : 'Select files first',
        onclick: () => runCommitSummary([...CHECKED]),
      }, 'Draft commit message')) : null,
    h('button', {
      class: 'btn primary wide', disabled: !n,
      onclick: async () => {
        const subject = $('ci-subject').value.trim();
        if (!subject) return toast('A commit needs a summary', 'bad');
        await act(() => api('/api/git/commit', {
          paths: [...CHECKED], subject, body: $('ci-body').value.trim(),
        }));
        COMMIT_DRAFT.subject = ''; COMMIT_DRAFT.body = '';
        CHECKED.clear();
        renderSide();
      },
    }, n ? 'Commit ' + n + ' file' + (n === 1 ? '' : 's') : 'Commit'),
    h('button', {
      class: 'btn wide', title: 'Rewrite the last commit message',
      onclick: async () => {
        const subject = $('ci-subject').value.trim();
        if (!subject) return toast('Type the new message first', 'bad');
        await act(() => api('/api/git/amend', { subject, body: $('ci-body').value.trim() }), 'git');
      },
    }, 'Amend last commit message'));
  foot.append(box);
  // Committing and then opening a pull request is one continuous action, so the button for
  // the second half belongs next to the first rather than three views away.
  if (S.selected.github) foot.append(newPrButton());
  if (n) {
    foot.append(arm(h('button', { class: 'btn danger wide' }, 'Discard ' + n + ' file' + (n === 1 ? '' : 's')),
      'Discard ' + n + ' file' + (n === 1 ? '' : 's'), 'Confirm — cannot be undone',
      async () => { await act(() => api('/api/git/discard', { paths: [...CHECKED] })); CHECKED.clear(); }));
  }
}

function sideHistory(body, foot) {
  const log = S.git ? S.git.log : [];
  if (!log.length) return body.append(h('div', { class: 'empty' }, 'No commits.'));
  log.forEach(c => body.append(h('div', {
    class: 'irow', 'aria-selected': String(SEL.commit === c.sha),
    style: { gridTemplateColumns: '1fr' },
    onclick: () => { SEL.commit = c.sha; renderSide(); renderPane(); },
  },
    h('span', { class: 't' }, c.subject,
      h('span', { class: 'sub' }, c.short + ' · ' + c.author + ' · ' +
        new Date(c.date).toLocaleDateString([], { day: 'numeric', month: 'short' }))))));
  foot.append(h('span', { class: 'lab' }, log.length + ' recent commits'));
}

function sideStaged(body, foot) {
  if (!S.queue.length) {
    body.append(h('div', { class: 'empty' }, 'Nothing staged.\nIssue edits collect here until you push.'));
    return;
  }
  body.append(h('div', { style: { padding: '11px' } },
    h('span', { class: 'lab' }, S.queue.length + ' change' + (S.queue.length === 1 ? '' : 's') + ' waiting')));
  foot.append(h('button', {
    class: 'btn primary wide',
    onclick: () => act(() => api('/api/queue/push', {}), 'queue'),
  }, (S.dryRun ? 'Dry-run push ' : 'Push ') + S.queue.length + ' change' + (S.queue.length === 1 ? '' : 's')));
  foot.append(arm(h('button', { class: 'btn wide' }, 'Discard all'), 'Discard all', 'Confirm discard all',
    () => act(() => api('/api/queue/clear', {}), 'queue')));
}

/* ── main pane ───────────────────────────────────────────────────── */
function renderPane() {
  const p = clear($('pane'));
  if (staleServer()) {
    p.append(h('div', { class: 'banner' },
      h('b', {}, 'The server is running older code than this page. '),
      'It was started before the current ', h('code', {}, 'server.js'), ', so anything new here will ' +
      'fail with “No such endpoint”. Stop it and run ', h('code', {}, 'node server.js'), ' again.'));
  }
  if (!S.selected) {
    return p.append(h('div', { class: 'empty' }, 'No repository selected. Pick one from the top-left.'));
  }
  if (S.githubError && (VIEW === 'issues' || VIEW === 'plan')) {
    p.append(h('div', { class: 'banner' }, h('b', {}, 'GitHub unavailable. '), S.githubError));
  }
  if (S.truncated) {
    p.append(h('div', { class: 'banner warn' }, h('b', {}, 'Issue list truncated. '),
      'This repo has more issues than the fetch limit, so counts below are partial.'));
  }
  if (VIEW === 'issues') return paneIssue(p);
  if (VIEW === 'plan') return panePlan(p);
  if (VIEW === 'changes') return paneDiff(p);
  if (VIEW === 'history') return paneHistory(p);
  if (VIEW === 'prs') return panePrs(p);
  if (VIEW === 'staged') return paneStaged(p);
}

/* ── issue detail + editor ───────────────────────────────────────── */
function stage(kind, payload) {
  return act(() => api('/api/queue/add', { kind, payload }), 'queue');
}

function paneIssue(p) {
  if (SEL.issue === 'new') return paneNewIssue(p);
  const i = S.issues.find(x => x.n === SEL.issue);
  if (!i) return p.append(h('div', { class: 'empty' }, 'Select an issue on the left.'));
  const gh = S.github || { milestones: [], labels: [], assignable: [] };
  const staged = S.queue.filter(c => c.payload && c.payload.number === i.n);

  const wrap = h('div', { class: 'detail pane-narrow' });
  wrap.append(h('div', { class: 'head' },
    h('div', { class: 'tags' },
      h('span', { class: 'chip solid', style: { '--c': i.st === 'OPEN' ? 'var(--ok)' : 'var(--fg-dim)' } },
        i.st === 'OPEN' ? 'open' : 'closed'),
      h('span', { class: 'chip' }, '#' + i.n),
      i.p != null ? h('span', { class: 'chip ph', style: { '--c': pc(i.p) } }, i.ms) : null,
      // Clicking a label filters the list to it — the "show me only these" question is
      // asked from the issue you are already looking at, not from the dropdown.
      ...i.l.map(l => h('button', {
        class: 'chip tap', title: FILTER.label === l ? 'Clear the label filter' : 'Show only issues labelled ' + l,
        'aria-pressed': String(FILTER.label === l),
        onclick: () => { FILTER.label = FILTER.label === l ? null : l; render(); },
      }, l)),
      ...i.a.map(a => h('span', { class: 'chip' }, '@' + a)),
      i.bx[1] ? h('span', { class: 'chip' }, i.bx[0] + '/' + i.bx[1] + ' done') : null),
    h('div', { class: 't' }, i.t),
    h('div', { class: 'acts' },
      i.st === 'OPEN'
        ? h('button', { class: 'btn', onclick: () => stage('close', { number: i.n, reason: 'completed' }) }, 'Stage close')
        : h('button', { class: 'btn', onclick: () => stage('reopen', { number: i.n }) }, 'Stage reopen'),
      i.st === 'OPEN'
        ? h('button', { class: 'btn', onclick: () => stage('close', { number: i.n, reason: 'not planned' }) }, 'Stage close · not planned')
        : null,
      i.url ? h('a', { class: 'btn', href: i.url, target: '_blank', rel: 'noreferrer noopener' }, 'Open on GitHub ↗') : null)));

  if (staged.length) {
    wrap.append(h('div', { class: 'banner warn' },
      h('b', {}, staged.length + ' staged change' + (staged.length === 1 ? '' : 's') + ' for this issue. '),
      'They apply when you push. ',
      h('button', { class: 'btn sm', onclick: () => { VIEW = 'staged'; render(); } }, 'Review')));
  }

  /* editors — each stages, none writes */
  const title = h('input', { type: 'text', value: i.t });
  wrap.append(h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Title'), title,
    h('button', {
      class: 'btn', style: { alignSelf: 'flex-start' },
      onclick: () => {
        const v = title.value.trim();
        if (!v || v === i.t) return toast('Title unchanged', 'bad');
        stage('edit', { number: i.n, title: v });
      },
    }, 'Stage title change')));

  const msSel = h('select', {},
    h('option', { value: '' }, '— no milestone —'),
    ...gh.milestones.map(m => h('option', { value: m.title, selected: m.title === i.ms }, m.title)));
  wrap.append(h('div', { class: 'grid2' },
    h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Milestone'), msSel,
      h('button', {
        class: 'btn', style: { alignSelf: 'flex-start' },
        onclick: () => {
          const v = msSel.value;
          if ((v || null) === (i.ms || null)) return toast('Milestone unchanged', 'bad');
          stage('edit', { number: i.n, milestone: v === '' ? null : v });
        },
      }, 'Stage milestone')),
    h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Assignees'),
      h('div', { class: 'picker' }, ...gh.assignable.slice(0, 24).map(who => {
        const on = i.a.includes(who);
        return h('button', {
          class: 'pick', 'aria-pressed': String(on),
          onclick: () => stage('edit', Object.assign({ number: i.n },
            on ? { removeAssignees: [who] } : { addAssignees: [who] })),
        }, who);
      })))));

  wrap.append(h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Labels'),
    h('div', { class: 'picker' }, ...gh.labels.map(l => {
      const on = i.l.includes(l.name);
      return h('button', {
        class: 'pick', 'aria-pressed': String(on),
        onclick: () => stage('edit', Object.assign({ number: i.n },
          on ? { removeLabels: [l.name] } : { addLabels: [l.name] })),
      }, l.name);
    }))));

  const cmt = h('textarea', { placeholder: 'Write a comment…' });
  wrap.append(h('div', { class: 'field' }, h('span', { class: 'lab' }, 'New comment'), cmt,
    h('button', {
      class: 'btn', style: { alignSelf: 'flex-start' },
      onclick: () => {
        const v = cmt.value.trim();
        if (!v) return toast('Comment is empty', 'bad');
        stage('comment', { number: i.n, body: v }).then(() => { cmt.value = ''; });
      },
    }, 'Stage comment')));

  wrap.append(h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Body'),
    h('div', { class: 'body-md' }, i.body || '(empty)')));

  /* Dependency context, straight from the reference edges the pull now keeps. */
  const waiting = (i.bk || []).filter(n => S.issues.some(x => x.n === n && x.st === 'OPEN'));
  const waiters = (DEPS && (DEPS.unblocks.find(u => u.number === i.n) || {}).waiters) || [];
  if (waiting.length || waiters.length || (i.bl || []).length) {
    const link = (n) => {
      const other = S.issues.find(x => x.n === n);
      return h('button', {
        class: 'btn sm', title: other ? other.t : '',
        onclick: () => { SEL.issue = n; render(); },
      }, '#' + n + (other ? ' ' + (other.t.length > 40 ? other.t.slice(0, 40) + '…' : other.t) : ''));
    };
    const rows = [];
    if (waiting.length) rows.push(h('div', { class: 'relrow' },
      h('span', { class: 'lab' }, 'waiting on'), ...waiting.map(link)));
    if (waiters.length) rows.push(h('div', { class: 'relrow' },
      h('span', { class: 'lab' }, 'unblocks'), ...waiters.map(link)));
    const mentions = (i.bl || []).filter(n => !waiters.includes(n));
    if (mentions.length) rows.push(h('div', { class: 'relrow' },
      h('span', { class: 'lab' }, "ref'd by"), ...mentions.map(link)));
    wrap.append(h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Dependencies'), ...rows));
  }

  /* Semantically similar issues — the duplicate you were about to file, before you file it. */
  const relatedBox = h('div', { class: 'field' },
    h('span', { class: 'lab' }, 'Related issues'),
    h('div', { class: 'lab', id: 'related-note' }, 'looking…'));
  wrap.append(relatedBox);
  p.append(wrap);
  loadRelated(i.n, relatedBox);
}

async function loadRelated(number, box) {
  try {
    const r = await api('/api/issues/related?number=' + encodeURIComponent(number));
    if (SEL.issue !== number) return;              // the user moved on while we asked
    const note = box.querySelector('#related-note');
    if (!note) return;
    if (!r.related.length) {
      note.textContent = 'nothing similar in this tracker';
      return;
    }
    note.remove();
    r.related.forEach(rel => box.append(h('div', {
      class: 'relhit' + (rel.state === 'OPEN' ? '' : ' closed'),
      onclick: () => { SEL.issue = rel.number; render(); },
    },
      h('span', { class: 'n' }, '#' + rel.number),
      h('span', { class: 't' }, rel.title),
      h('span', { class: 'sim', title: 'cosine similarity' }, Math.round(rel.score * 100) + '%'))));
  } catch {
    const note = box.querySelector('#related-note');
    if (note) note.textContent = 'similarity needs an embedding model and a built index';
  }
}

function paneNewIssue(p) {
  const gh = S.github || { milestones: [], labels: [], assignable: [] };
  const title = h('input', { type: 'text', placeholder: 'Issue title' });
  const body = h('textarea', { placeholder: 'Description (markdown)' , style: { minHeight: '190px' } });
  const ms = h('select', {}, h('option', { value: '' }, '— no milestone —'),
    ...gh.milestones.map(m => h('option', { value: m.title }, m.title)));
  const labels = new Set(), assignees = new Set();

  p.append(h('div', { class: 'detail pane-narrow' },
    h('div', { class: 'head' }, h('div', { class: 't' }, 'New issue'),
      h('span', { class: 'lab' }, 'staged like everything else — nothing is filed until you push')),
    h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Title'), title),
    h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Body'), body),
    h('div', { class: 'grid2' },
      h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Milestone'), ms),
      h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Assignees'),
        h('div', { class: 'picker' }, ...gh.assignable.slice(0, 24).map(w =>
          h('button', {
            class: 'pick', 'aria-pressed': 'false',
            onclick: (e) => {
              assignees.has(w) ? assignees.delete(w) : assignees.add(w);
              e.currentTarget.setAttribute('aria-pressed', String(assignees.has(w)));
            },
          }, w))))),
    h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Labels'),
      h('div', { class: 'picker' }, ...gh.labels.map(l =>
        h('button', {
          class: 'pick', 'aria-pressed': 'false',
          onclick: (e) => {
            labels.has(l.name) ? labels.delete(l.name) : labels.add(l.name);
            e.currentTarget.setAttribute('aria-pressed', String(labels.has(l.name)));
          },
        }, l.name)))),
    h('div', { class: 'acts' },
      h('button', {
        class: 'btn primary',
        onclick: () => {
          const t = title.value.trim();
          if (!t) return toast('Give the issue a title', 'bad');
          stage('create', {
            title: t, body: body.value, milestone: ms.value || null,
            labels: [...labels], assignees: [...assignees],
          }).then(() => { SEL.issue = null; renderPane(); });
        },
      }, 'Stage new issue'),
      h('button', { class: 'btn', onclick: () => { SEL.issue = null; renderPane(); } }, 'Cancel'))));
}

/* ── plan view (per-repo insights) ───────────────────────────────── */
function panePlan(p) {
  const ins = S.insights;
  if (!ins) return p.append(h('div', { class: 'empty' }, 'No plan is available for this repository.'));
  const open = S.issues.filter(i => i.st === 'OPEN');
  const byNum = Object.fromEntries(S.issues.map(i => [i.n, i]));
  const baseNums = new Set(ins.baselineNums || []);
  const phaseLabel = (n) => {
    const phase = (ins.phases || []).find(x => x.n === n);
    return phase ? (phase.name || phase.title) : 'No milestone';
  };
  const DAY = 864e5, now = new Date();
  const daysTo = (d) => {
    const value = d && new Date(d + 'T00:00:00');
    return value && !Number.isNaN(value.getTime())
      ? Math.max(0, Math.ceil((value - now) / DAY))
      : null;
  };

  /*
   * A gap counts as handled if an issue was filed for it, if a create is already staged
   * for it, or if the user ignored it. All three mean "stop showing me this".
   */
  const STOP = new Set('a an the and or of for to in on with now not that this from by is are it its no new'.split(' '));
  const stem = (w) => w.replace(/(ies)$/, 'y').replace(/(sses|shes|ches)$/, '').replace(/s$/, '');
  const toks = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)).map(stem));
  const sim = (a, b) => { let hit = 0; a.forEach(w => { if (b.has(w)) hit++; });
    return hit / new Set([...a, ...b]).size; };

  const matchGap = (titleText) => {
    const g = toks(titleText); if (!g.size) return null;
    let best = null, score = 0;
    S.issues.forEach(i => {
      if (baseNums.has(i.n)) return;                     // only issues filed after the snapshot
      const j = sim(g, toks(i.t));
      if (j > score) { score = j; best = i; }
    });
    return score >= 0.42 ? best : null;
  };
  const stagedFor = (titleText) => {
    const g = toks(titleText); if (!g.size) return null;
    return (S.queue || []).find(c => c.kind === 'create' && sim(g, toks(c.payload.title)) >= 0.5) || null;
  };
  const ignoredFor = (titleText) => {
    const g = toks(titleText); if (!g.size) return false;
    return (IGNORED_TITLES || []).some(t => sim(g, toks(t)) >= 0.5);
  };

  const dBeta = daysTo(ins.beta);
  const wrap = h('div', { class: 'pane-narrow' });
  wrap.append(h('h1', {}, 'What to build ', h('em', {}, 'next')),
    h('p', { style: { color: 'var(--fg-mid)', margin: '0 0 16px', maxWidth: '62ch' } },
      'Ranked against ', h('i', {}, ins.source), '. Actions here stage changes — nothing reaches GitHub until you push.'));

  /* A scoped plan answers for a slice of the tracker. Saying which one is not decoration:
     the ranking below is complete for that slice and silent about everything else, and a
     reader who assumes otherwise concludes the rest of the project has nothing left. */
  if (ins.scopeText) {
    wrap.append(h('div', { class: 'banner', style: { marginBottom: '16px' } },
      h('b', {}, 'Scoped plan. '),
      'This covers ' + ins.scopeText + ' — ' + ins.scopeOpen + ' open issue' +
        (ins.scopeOpen === 1 ? '' : 's') + '. Work outside it is not ranked here.',
      h('div', { class: 'acts', style: { marginTop: '8px' } },
        h('button', {
          class: 'btn sm', disabled: aiBusy || !assistantAvailable(),
          title: 'Generate a plan across every milestone and label',
          onclick: () => { planScope = { milestone: null, label: null }; runPlan('new'); },
        }, 'Plan the whole tracker'))));
  }

  /* The plan ranks the issues that existed when it was made. Say so the moment that stops
     being true, rather than letting a confident-looking order quietly go stale. */
  const drift = (S.planStatus && S.planStatus.stale && !planBannerOff) ? S.planStatus : null;
  if (drift) {
    wrap.append(h('div', { class: 'banner warn', style: { marginBottom: '16px' } },
      h('b', {}, 'The tracker moved on. '), driftText(drift), ' ',
      h('div', { class: 'acts', style: { marginTop: '8px' } },
        h('button', {
          class: 'btn sm primary', disabled: aiBusy || !assistantAvailable(),
          title: assistantAvailable() ? 'Keep what is still right; place what changed' : 'Turn the assistant on to update the plan',
          onclick: () => runPlan('update'),
        }, aiBusy ? 'Working…' : 'Update plan'),
        h('button', {
          class: 'btn sm', disabled: aiBusy || !assistantAvailable(),
          onclick: () => runPlan('new'),
        }, 'Generate new'),
        h('button', { class: 'btn sm', onclick: () => { planBannerOff = true; renderPane(); } }, 'Dismiss'))));
  }

  const p0 = ins.phases[0];
  const stats = [
    p0 ? h('div', { class: 'stat hot' }, h('span', { class: 'lab' }, 'Next milestone due'),
      h('span', { class: 'v' }, daysTo(p0.e) == null ? 'not dated' : daysTo(p0.e) + ' days')) : null,
    h('div', { class: 'stat' }, h('span', { class: 'lab' }, 'Final due date'),
      h('span', { class: 'v' }, dBeta == null ? 'not dated' : dBeta + ' days')),
    ins.hoursPerWeek && dBeta != null
      ? h('div', { class: 'stat' }, h('span', { class: 'lab' }, 'Est. hours left'),
        h('span', { class: 'v' }, '~' + Math.round(dBeta / 7 * ins.hoursPerWeek / 5) * 5))
      : null,
    h('div', { class: 'stat' },
      h('span', { class: 'lab' }, ins.scopeText ? 'Open in scope' : 'Open'),
      h('span', { class: 'v num' }, ins.scopeText ? ins.scopeOpen : open.length)),
    h('div', { class: 'stat' }, h('span', { class: 'lab' }, 'Missing issues'),
      h('span', { class: 'v num' },
        ins.gaps.filter(g => !matchGap(g.t) && !stagedFor(g.t) && !ignoredFor(g.t)).length)),
  ];
  wrap.append(h('div', { class: 'stats', style: { marginBottom: '18px' } }, ...stats));

  /* timeline */
  const tl = h('div', { class: 'tl' });
  ins.phases.forEach(ph => {
    const start = ph.s && new Date(ph.s + 'T00:00:00');
    const end = ph.e && new Date(ph.e + 'T00:00:00');
    const len = start && end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())
      ? Math.max(1, (end - start) / DAY + 1)
      : 1;
    const dates = ph.s && ph.e ? fmtD(ph.s) + ' – ' + fmtD(ph.e)
      : (ph.e ? 'Due ' + fmtD(ph.e) : 'No due date');
    tl.append(h('button', {
      class: 'band', 'aria-pressed': String(FILTER.phase === ph.n), title: 'Gate: ' + ph.gate,
      style: { '--c': pc(ph.n), flex: len + ' 1 0' },
      onclick: () => { FILTER.phase = FILTER.phase === ph.n ? null : ph.n; render(); },
    },
      h('span', { class: 'bt' }, ph.name),
      h('span', { class: 'bd' }, dates),
      h('span', { class: 'bn' }, open.filter(i => i.p === ph.n).length + ' open')));
  });
  if (ins.phases.length) {
    const t0 = ins.phases[0].s ? +new Date(ins.phases[0].s + 'T00:00:00') : NaN;
    const lastDue = ins.phases[ins.phases.length - 1].e;
    const span = lastDue ? +new Date(lastDue + 'T00:00:00') - t0 : NaN;
    if (Number.isFinite(t0) && span > 0) {
      tl.append(h('div', { class: 'today', style: { left: Math.min(100, Math.max(0, (now - t0) / span * 100)) + '%' } },
        h('span', {}, 'TODAY')));
    }
    wrap.append(h('div', { class: 'tl-outer', style: { marginBottom: '26px' } }, tl));
  }

  /* ranked */
  const hiddenToggle = h('button', {
    class: 'btn sm', onclick: () => { showHiddenPlan = !showHiddenPlan; renderPane(); },
  }, 'Show hidden');
  wrap.append(h('div', { class: 'sec-head' }, h('h2', {}, 'Recommended order'), hiddenToggle));
  const queue = h('div', { class: 'queue', style: { marginTop: '12px' } });
  let rank = 0, shown = 0, hidden = 0, outsidePhase = 0;
  ins.ranked.forEach(r => {
    let head = [], bits = [], c, done = false, openNums = [], closedNums = [], gapHit = null;
    let gapPending = null, gapIgnored = false;
    let itemPhases = [];
    if (r.gap) {
      gapHit = matchGap(r.gap);
      gapPending = gapHit ? null : stagedFor(r.gap);
      gapIgnored = !gapHit && !gapPending && ignoredFor(r.gap);
      done = (!!gapHit && gapHit.st === 'CLOSED') || !!gapPending || gapIgnored;
      c = gapIgnored ? 'var(--fg-dim)' : (done ? 'var(--ok)' : 'var(--alarm)');
      head = [h('span', { class: 'iss' }, gapHit ? '#' + gapHit.n : (gapPending ? 'staged' : 'no issue')),
        h('span', { class: 'ttl' }, r.gap)];
      bits = [h('span', { class: gapIgnored ? 'chip' : (done ? 'chip ok' : (gapHit ? 'chip' : 'chip new')) },
        gapIgnored ? 'ignored' : (gapPending ? 'staged' : (done ? 'closed' : (gapHit ? 'filed' : 'create this')))),
      h('span', { class: r.risk && !done ? 'chip risk' : 'chip' }, r.tag)];
      if (gapHit) (gapHit.st === 'OPEN' ? openNums : closedNums).push(gapHit.n);
      itemPhases = [gapHit && gapHit.p != null ? gapHit.p : r.p].filter(x => x != null);
    } else {
      const known = (r.ns || []).filter(n => byNum[n]);
      if (!known.length) return;
      const first = byNum[known[0]]; c = pc(first.p);
      done = known.every(n => byNum[n].st === 'CLOSED');
      head = [...known.map(n => h('span', { class: 'iss' }, '#' + n)),
      h('span', { class: 'ttl' }, known.map(n => byNum[n].t).join(' · '))];
      bits = [h('span', { class: 'chip solid', style: { '--c': pc(first.p) } }, phaseLabel(first.p)),
      first.a.length ? h('span', { class: 'chip' }, first.a[0]) : h('span', { class: 'chip risk' }, 'unassigned'),
      first.bl.length ? h('span', { class: 'chip' }, "ref'd by " + first.bl.map(b => '#' + b).join(' ')) : null,
      h('span', { class: done ? 'chip ok' : 'chip' }, done ? 'closed' : r.tag)].filter(Boolean);
      if (first.bx[1] && !done) {
        bits.push(h('span', { class: 'prog', style: { '--c': c } },
          h('span', { class: 'pbar' }, h('i', { style: { width: (first.bx[0] / first.bx[1] * 100) + '%' } })),
          first.bx[0] + '/' + first.bx[1]));
      }
      known.forEach(n => (byNum[n].st === 'OPEN' ? openNums : closedNums).push(n));
      itemPhases = [...new Set(known.map(n => byNum[n].p).filter(x => x != null))];
    }
    if (!done) rank++;
    if (done && !showHiddenPlan) { hidden++; return; }
    if (FILTER.phase !== null && !itemPhases.includes(FILTER.phase)) { outsidePhase++; return; }
    shown++;

    const acts = h('div', { class: 'acts' });
    openNums.forEach(n => acts.append(h('button', {
      class: 'btn sm', onclick: () => stage('close', { number: n, reason: 'completed' }),
    }, 'Stage close #' + n)));
    closedNums.forEach(n => acts.append(h('button', {
      class: 'btn sm', onclick: () => stage('reopen', { number: n }),
    }, 'Stage reopen #' + n)));
    if (r.gap && !gapHit && !gapPending && !gapIgnored) {
      const g = ins.gaps.find(x => x.t === r.gap);
      if (g) acts.append(h('button', { class: 'btn sm primary', onclick: () => stageGap(g, ins) }, 'Stage create'));
    }
    [...openNums, ...closedNums].forEach(n => {
      if (!byNum[n]) return;
      acts.append(h('button', {
        class: 'btn sm', onclick: () => openIssueFromPlan(n),
      }, 'Edit #' + n));
      if (byNum[n].url) acts.append(h('a', {
        class: 'btn sm', href: byNum[n].url, target: '_blank', rel: 'noreferrer noopener',
      }, 'GitHub ↗'));
    });

    queue.append(h('div', {
      class: 'card' + (done ? ' done' : ''), style: { '--c': c },
    },
      h('div', { class: 'rank num' }, done ? '✓' : String(rank)),
      h('div', { class: 'cbody' },
        h('div', { class: 'row1' }, ...head),
        h('p', { class: 'why' }, rich(r.why)),
        h('div', { class: 'tags' }, ...bits),
        acts.children.length ? acts : null)));
  });

  hiddenToggle.textContent = showHiddenPlan ? 'Hide finished' : 'Show hidden (' + hidden + ')';
  hiddenToggle.disabled = hidden === 0 && !showHiddenPlan;

  if (FILTER.phase !== null) {
    queue.prepend(h('div', { class: 'qfilter', style: { '--c': pc(FILTER.phase) } },
      h('b', {}, shown + ' shown'), ' for ' + phaseLabel(FILTER.phase) +
      (outsidePhase ? ' · ' + outsidePhase + ' from other milestones hidden' : ''),
      h('button', { class: 'btn sm', onclick: () => { FILTER.phase = null; render(); } }, 'Show all')));
  }
  if (!shown) {
    queue.append(h('div', { class: 'empty' }, FILTER.phase === null
      ? 'No unfinished recommended work remains.'
      : 'No recommended work is assigned to this milestone.'));
  }
  wrap.append(queue);

  /* gaps */
  const gapHead = h('div', { class: 'sec-head', style: { marginTop: '34px' } },
    h('h2', {}, 'Issues that should exist'),
    h('p', {}, 'Commitments the schedule makes in writing that nothing in the tracker holds.'));
  wrap.append(gapHead);
  const gapsEl = h('div', { class: 'gaps', style: { marginTop: '12px' } });
  let handled = 0;
  ins.gaps.forEach(g => {
    if (FILTER.phase !== null && g.p !== FILTER.phase) return;
    const hit = matchGap(g.t);
    const pending = hit ? null : stagedFor(g.t);
    const ign = (hit || pending) ? false : ignoredFor(g.t);
    // Filed, staged or ignored — all three mean it is dealt with, so it drops out of the list.
    if (hit || pending || ign) { handled++; if (!showHandledGaps) return; }

    const c = g.p == null ? 'var(--fg-dim)' : pc(g.p);
    const card = h('div', { class: 'gap' + (hit || pending ? ' filled' : ''), style: { '--c': c } });
    if (hit) card.append(h('div', { class: 'filled-banner' }, 'Filed — #' + hit.n + ' ' + hit.t + ' · verify it covers this'));
    else if (pending) card.append(h('div', { class: 'filled-banner' }, 'Staged — pushes as “' + pending.payload.title + '”'));
    else if (ign) card.append(h('div', { class: 'filled-banner', style: { color: 'var(--fg-dim)', borderColor: 'var(--fg-dim)' } }, 'Ignored'));

    const acts = h('div', { class: 'acts' });
    if (!hit && !pending && !ign) {
      acts.append(h('button', { class: 'btn primary sm', onclick: () => stageGap(g, ins) }, 'Stage create'));
      acts.append(h('button', {
        class: 'btn sm', title: 'Never suggest this again',
        onclick: async () => {
          try {
            const r = await api('/api/ai/ignore', { title: g.t, reason: g.why });
            IGNORED = r.ignored; IGNORED_TITLES = r.ignored.map(x => x.title);
            toast(r.message, 'good'); await load();
          } catch (e) { toast(e.message, 'bad'); }
        },
      }, 'Ignore'));
    } else if (ign) {
      acts.append(h('button', {
        class: 'btn sm', title: 'Remove it from the ignore list so it can be suggested again',
        onclick: () => forgetIgnored(g.t, false),
      }, 'Un-ignore'));
    }
    if (hit) {
      acts.append(h('button', { class: 'btn sm', onclick: () => openIssueFromPlan(hit.n) }, 'Edit #' + hit.n));
      if (hit.url) acts.append(h('a', {
        class: 'btn sm', href: hit.url, target: '_blank', rel: 'noreferrer noopener',
      }, 'GitHub ↗'));
    }
    card.append(h('div', { class: 'gap-top' },
      h('div', { class: 'tags' },
        g.p != null ? h('span', { class: 'chip solid', style: { '--c': c } }, phaseLabel(g.p)) : h('span', { class: 'chip' }, 'no milestone'),
        h('span', { class: g.risk ? 'chip risk' : 'chip' }, g.when),
        g.who ? h('span', { class: 'chip' }, g.who) : null,
        g.lbl ? h('span', { class: 'chip' }, g.lbl) : null),
      h('h3', {}, g.t),
      h('p', {}, rich(g.why)),
      h('div', { class: 'ev' }, h('b', {}, 'Why it matters'), rich(g.ev)),
      acts));
    const det = h('details', {}, h('summary', {}, 'Issue body'), h('div', { class: 'draft' }, h('pre', {}, g.body)));
    card.append(det);
    gapsEl.append(card);
  });
  if (handled) {
    gapHead.append(h('div', { class: 'acts', style: { marginTop: '6px' } },
      h('span', { class: 'lab' }, handled + ' handled (filed, staged or ignored)'),
      h('button', {
        class: 'btn sm',
        onclick: () => { showHandledGaps = !showHandledGaps; renderPane(); },
      }, showHandledGaps ? 'Hide handled' : 'Show handled')));
  }
  if (!gapsEl.children.length) {
    gapsEl.append(h('div', { class: 'empty' }, FILTER.phase === null
      ? 'Every gap is filed, staged or ignored.'
      : 'No unhandled missing issues are assigned to this milestone.'));
  }
  wrap.append(gapsEl);
  p.append(wrap);
}

function openIssueFromPlan(number) {
  SEL.issue = number;
  VIEW = 'issues';
  render();
}

function stageGap(g, ins) {
  const phase = g.p == null ? null : ins.phases.find(p => p.n === g.p);
  const msTitle = phase && S.github
    ? (S.github.milestones.find(m => m.title === phase.title) || {}).title || null
    : null;
  return stage('create', {
    title: g.t, body: g.body, milestone: msTitle,
    labels: g.lbl ? [g.lbl] : [], assignees: g.who ? [g.who] : [],
  });
}
const fmtD = (d) => d
  ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  : 'not dated';

/* ── diff / history / staged panes ───────────────────────────────── */
async function paneDiff(p) {
  if (!SEL.file) return p.append(h('div', { class: 'empty' }, 'Select a file to see its diff.'));
  p.append(h('div', { class: 'empty' }, 'Loading diff…'));
  try {
    const d = await api('/api/git/diff?file=' + encodeURIComponent(SEL.file));
    clear(p);
    p.append(diffBlock(d.patch, d.path + (d.untracked ? '  (new file)' : '  vs HEAD')));
  } catch (e) {
    clear(p).append(h('div', { class: 'banner' }, h('b', {}, 'Could not load diff. '), e.message));
  }
}

async function paneHistory(p) {
  if (!SEL.commit) {
    const log = S.git ? S.git.log : [];
    const list = h('div', { class: 'commits' });
    log.forEach(c => list.append(h('div', {
      class: 'crow', style: { cursor: 'pointer' },
      onclick: () => { SEL.commit = c.sha; renderPane(); },
    },
      h('span', { class: 'sha' }, c.short),
      h('span', { class: 's', title: c.subject }, c.subject),
      h('span', { class: 'w' }, c.author + ' · ' + new Date(c.date).toLocaleDateString([], { day: 'numeric', month: 'short' })))));
    p.append(h('div', { class: 'pane-narrow' },
      h('div', { class: 'sec-head', style: { marginBottom: '12px' } }, h('h2', {}, 'History'),
        h('p', {}, 'Last ' + log.length + ' commits on ' + ((S.git && S.git.status.branch) || 'HEAD') + '. Click one to see what changed.')),
      list));
    return;
  }
  p.append(h('div', { class: 'empty' }, 'Loading commit…'));
  try {
    const c = await api('/api/git/show?sha=' + encodeURIComponent(SEL.commit));
    clear(p);
    p.append(h('div', { class: 'pane-narrow detail' },
      h('div', { class: 'head' },
        h('div', { class: 'tags' }, h('span', { class: 'chip' }, c.short),
          h('span', { class: 'chip' }, c.author),
          h('span', { class: 'chip' }, new Date(c.date).toLocaleString())),
        h('div', { class: 't' }, c.subject),
        h('div', { class: 'acts' },
          h('button', { class: 'btn sm', onclick: () => { SEL.commit = null; renderPane(); } }, '← Back to history'))),
      c.body ? h('div', { class: 'body-md' }, c.body) : null,
      h('pre', {}, c.stat),
      diffBlock(c.patch, c.short)));
  } catch (e) {
    clear(p).append(h('div', { class: 'banner' }, h('b', {}, 'Could not load commit. '), e.message));
  }
}

function paneStaged(p) {
  const wrap = h('div', { class: 'pane-narrow' });
  wrap.append(h('div', { class: 'sec-head', style: { marginBottom: '14px' } },
    h('h2', {}, 'Staged issue changes'),
    h('p', {}, 'Edits collect here the way file changes collect before a commit. They go to GitHub in this order when you push; if one fails, the rest stay staged.')));
  if (!S.queue.length) {
    wrap.append(h('div', { class: 'empty' }, 'Nothing staged yet.'));
    return p.append(wrap);
  }
  const list = h('div', { class: 'staged' });
  S.queue.forEach((c, idx) => {
    const row = h('div', { class: 'srow' + (EDITING === c.id ? ' editing' : '') },
      h('div', { class: 'movebtns' },
        h('button', { class: 'btn sm', disabled: idx === 0, title: 'Move earlier',
          onclick: () => act(() => api('/api/queue/move', { id: c.id, delta: -1 }), 'queue') }, '▲'),
        h('button', { class: 'btn sm', disabled: idx === S.queue.length - 1, title: 'Move later',
          onclick: () => act(() => api('/api/queue/move', { id: c.id, delta: 1 }), 'queue') }, '▼')),
      h('span', { class: 'sum' },
        h('span', { class: 'kind' }, c.kind), ' ', c.summary,
        h('code', {}, 'gh ' + c.argv.join(' '))),
      h('div', { class: 'acts' },
        h('button', {
          class: 'btn sm', onclick: () => { EDITING = EDITING === c.id ? null : c.id; renderPane(); },
        }, EDITING === c.id ? 'Close' : 'Edit'),
        h('button', { class: 'btn sm', onclick: () => act(() => api('/api/queue/remove', { id: c.id }), 'queue') }, 'Remove')));
    list.append(row);
    if (EDITING === c.id) list.append(stagedEditor(c));
  });
  wrap.append(list);
  p.append(wrap);
}

/* ── assistant ───────────────────────────────────────────────────── */
let AI = null;              // /api/ai/status result
let PROPOSALS = [];         // classification proposals awaiting a click
let SUGGESTIONS = [];       // suggested new issues awaiting a click
let aiBusy = false;
let commitSummaryBusy = false;
let commitSummarySeq = 0;
let COMMIT_JOB = null;

function assistantAvailable() {
  const cfg = AI && AI.config;
  return !!(AI && AI.ok && cfg && cfg.enabled && cfg.model);
}

async function runCommitSummary(paths) {
  if (!paths.length || commitSummaryBusy || !assistantAvailable()) return;
  const repoPath = S && S.selected && S.selected.path;
  const requestSeq = ++commitSummarySeq;
  commitSummaryBusy = true;
  COMMIT_JOB = newJobId();
  renderSide();
  try {
    const result = await api('/api/ai/commit-summary', { paths, jobId: COMMIT_JOB });
    if (!S || !S.selected || S.selected.path !== repoPath) return;
    if (result.cancelled) { toast(result.message, ''); return; }
    COMMIT_DRAFT.subject = result.subject;
    COMMIT_DRAFT.body = result.body || '';
    toast(result.message, 'good');
  } catch (error) {
    if (requestSeq === commitSummarySeq && S && S.selected && S.selected.path === repoPath) {
      toast(error.message, 'bad');
    }
  } finally {
    if (requestSeq !== commitSummarySeq) return;
    commitSummaryBusy = false;
    COMMIT_JOB = null;
    if (VIEW === 'changes' && S && S.selected && S.selected.path === repoPath) renderSide();
  }
}

async function aiStatus() {
  try { AI = await api('/api/ai/status'); }
  catch (e) { AI = { ok: false, error: e.message, models: [], loaded: [], config: {} }; }
  renderNav();
  if (VIEW === 'changes') renderSide();
  if (VIEW === 'plan') renderPane();
  return AI;
}

async function aiSave(patch) {
  busy(true);
  try {
    const r = await api('/api/ai/config', Object.assign({}, AI && AI.config, patch));
    AI = r;
    if (r.message) toast(r.message, 'good');
    renderNav(); renderRail();
    if (VIEW === 'changes') renderSide();
    return r;
  } finally { busy(false); }
}

function confChip(c) {
  if (c == null) return null;
  const cls = c >= 0.8 ? 'hi' : c >= 0.55 ? 'mid' : 'lo';
  return h('span', { class: 'conf ' + cls }, Math.round(c * 100) + '%');
}

let railOpen = false;
let RAIL_TAB = 'run';          // 'run' | 'chat' | 'settings'
let MILESTONES = [];           // proposed new milestones
let NEW_LABELS = [];           // labels the classifier nominated
let DUPES = [];                // near-duplicate clusters awaiting a decision
let DUPE_SCALE = null;         // this repo's similarity distribution, for honest labelling
let dupeClosed = true;         // a duplicate of a CLOSED issue is the most useful kind
let IGNORED = [];              // suggestions previously dismissed
let showIgnored = false;
let showHandledGaps = false;
let showHiddenPlan = false;
let PRS = [], prState = 'open', prLoaded = false, EDITING = null;
let IGNORED_TITLES = [];   // titles only, for gap matching

/* Assistant work is cancellable, so each run carries an id the browser mints up front —
   waiting for the server to name the job would leave its slowest part uncancellable. */
let AI_JOB = null;             // rail action in flight
let CHAT_JOB = null;           // conversation turn in flight
const newJobId = () => (window.crypto && window.crypto.randomUUID
  ? window.crypto.randomUUID()
  : 'job-' + Math.random().toString(36).slice(2) + Date.now().toString(36));

let CHAT = [];                 // the conversation, held only in this tab
let CHAT_TRACE = new Map();    // message index → the lookups that produced it
let CHAT_PROPOSALS = [];       // propose_* results awaiting a Stage click
let chatBusy = false;
let chatDraft = '';
let planChoice = false;        // the generate / update / cancel prompt is showing
let planBannerOff = false;
/*
 * How many entries the next generated plan should hold. It used to be hardwired to 10,
 * which on a tracker with 60-odd open issues produced a plan that stopped at the first
 * milestone and looked like the whole recommendation. The server caps it at 50.
 */
let planCount = 15;
/*
 * What the next plan should be about. Null on both means the whole tracker.
 *
 * The point is a shared tracker: scoping to a milestone or a label gives each person a
 * plan about their own work instead of one plan mostly about someone else's.
 */
let planScope = { milestone: null, label: null };

/*
 * One place that owns the busy flag, the job id and the cancelled case, so every assistant
 * action behaves the same: buttons disable, a Cancel appears, and a cancel is reported as
 * a normal outcome rather than an error.
 */
async function runAi(fn) {
  if (aiBusy) return null;
  AI_JOB = newJobId();
  aiBusy = true; busy(true); renderRail(); renderNav();
  try {
    const r = await fn(AI_JOB);
    if (r && r.cancelled) { toast(r.message || 'Cancelled', ''); return null; }
    if (r && r.message) toast(r.message, 'good');
    return r;
  } catch (e) { toast(e.message, 'bad'); return null; }
  finally { AI_JOB = null; aiBusy = false; busy(false); renderRail(); renderNav(); }
}

async function cancelAi(which) {
  const jobId = which === 'chat' ? CHAT_JOB : AI_JOB;
  if (!jobId) return;
  try { await api('/api/ai/cancel', { jobId }); }
  catch (e) { toast(e.message, 'bad'); }
}

function toggleRail(on) {
  railOpen = on === undefined ? !railOpen : !!on;
  $('ai-panel').hidden = !railOpen;
  document.querySelector('.main').classList.toggle('with-rail', railOpen);
  $('btn-ai').setAttribute('aria-expanded', String(railOpen));
  if (railOpen) { if (!AI) aiStatus().then(renderRail); else renderRail(); }
}

function renderRail() {
  const body = clear($('ai-body'));
  const foot = clear($('ai-foot'));
  const cfg = (AI && AI.config) || {};
  $('ai-tab-run').setAttribute('aria-selected', String(RAIL_TAB === 'run'));
  $('ai-tab-chat').setAttribute('aria-selected', String(RAIL_TAB === 'chat'));
  $('ai-tab-set').setAttribute('aria-selected', String(RAIL_TAB === 'settings'));
  $('ai-state').textContent = !AI ? 'checking…'
    : !AI.ok ? 'unreachable'
    : (aiBusy || chatBusy) ? 'working…'
    : (cfg.enabled && cfg.model ? cfg.model.split('/').pop().slice(0, 22) : 'not set up');

  if (!AI) { body.append(h('div', { class: 'empty' }, 'Checking endpoint…')); return; }
  if (RAIL_TAB === 'settings') return railSettings(body, foot, cfg);
  if (RAIL_TAB === 'chat') return railChat(body, foot, cfg);
  return railRun(body, foot, cfg);
}

/* ── Chat tab ────────────────────────────────────────────────────── */
/*
 * The open-ended half of the assistant. The transcript lives here in the tab and is sent
 * whole with each turn, so there is no session on the server: switching repository or
 * pressing Clear really does end the conversation.
 *
 * Everything the model says is inserted as TEXT, never markup — the same rule the rest of
 * this file follows for repository content, and it applies doubly to a model that has just
 * been reading issue bodies other people wrote.
 */
function railChat(body, foot, cfg) {
  if (!cfg.enabled || !cfg.model) {
    body.append(h('div', { class: 'banner warn' },
      cfg.enabled ? 'Pick a chat model in Settings.' : 'Assistant is off — turn it on in Settings.'));
    return;
  }

  const log = h('div', { class: 'chat' });
  if (!CHAT.length) {
    log.append(h('div', { class: 'empty' },
      'Ask about this repository.\n\nIt can read issues, milestones, labels,\nthe plan and recent commits — and\npropose issues for you to stage.'));
  }
  CHAT.forEach((m, idx) => {
    if (m.role === 'user') return log.append(h('div', { class: 'msg me' }, m.content));
    const trace = CHAT_TRACE.get(idx);
    if (trace && trace.length) {
      log.append(h('div', { class: 'steps' },
        ...trace.map(t => h('span', { class: 'step' + (t.error ? ' bad' : ''), title: t.error || t.label }, t.label))));
    }
    log.append(h('div', { class: 'msg ai' }, m.content));
  });
  if (chatBusy) {
    log.append(h('div', { class: 'msg ai' }, h('span', { class: 'spin' }), 'thinking — it may run a few lookups…'));
  }
  body.append(log);

  if (CHAT_PROPOSALS.length) {
    body.append(h('h3', {}, 'Proposals from this conversation'),
      h('div', { class: 'lab', style: { marginBottom: '7px' } }, 'nothing is filed until you stage and push'));
    CHAT_PROPOSALS.forEach(p => body.append(chatProposalCard(p)));
  }

  if (S && !S.issuesLoaded) {
    body.append(h('div', { class: 'banner warn' }, 'Issues are not pulled yet, so it cannot see them.'));
  }

  const ta = h('textarea', {
    class: 'chat-in', rows: '3', placeholder: 'Ask about this repository…',
    'aria-label': 'Message the assistant',
  });
  ta.value = chatDraft;
  ta.addEventListener('input', () => { chatDraft = ta.value; });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  foot.append(ta, h('div', { class: 'acts' },
    chatBusy
      ? h('button', { class: 'btn sm danger', onclick: () => cancelAi('chat') }, 'Cancel')
      : h('button', { class: 'btn sm primary', onclick: () => sendChat() }, 'Send'),
    h('button', {
      class: 'btn sm', disabled: !CHAT.length || chatBusy,
      onclick: () => { CHAT = []; CHAT_TRACE = new Map(); CHAT_PROPOSALS = []; renderRail(); },
    }, 'Clear'),
    h('span', { class: 'lab' }, 'enter sends')));

  // Follow the conversation, the way every chat panel does.
  const scroller = $('ai-body');
  if (scroller) requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
}

function editSummary(p) {
  const bits = [];
  if (p.milestone) bits.push('milestone → ' + p.milestone);
  if (p.addLabels && p.addLabels.length) bits.push('+' + p.addLabels.join(', +'));
  if (p.removeLabels && p.removeLabels.length) bits.push('−' + p.removeLabels.join(', −'));
  return bits.join(' · ');
}

function chatProposalCard(p) {
  const payload = p.payload || {};
  return h('div', { class: 'prop', style: { '--c': 'var(--p2)' } },
    h('div', { class: 'h' }, h('span', { class: 'lab' }, p.type), h('span', { class: 't' }, p.title)),
    p.kind === 'edit' ? h('div', { class: 'move' }, editSummary(payload)) : null,
    p.kind === 'create'
      ? h('div', { class: 'move' }, (payload.milestone || 'no milestone') +
        (payload.labels && payload.labels.length ? ' · ' + payload.labels.join(', ') : ''))
      : null,
    p.rationale ? h('p', { class: 'r' }, p.rationale) : null,
    ...(p.notes || []).map(n => h('div', { class: 'move' }, n)),
    payload.body || payload.description
      ? h('details', {}, h('summary', {}, payload.body ? 'Body' : 'Description'),
        h('div', { class: 'draft' }, h('pre', {}, payload.body || payload.description)))
      : null,
    h('div', { class: 'acts' },
      h('button', {
        class: 'btn sm primary',
        onclick: async () => {
          await stage(p.kind, payload);
          CHAT_PROPOSALS = CHAT_PROPOSALS.filter(x => x !== p); renderRail();
        },
      }, 'Stage'),
      h('button', {
        class: 'btn sm',
        onclick: () => { CHAT_PROPOSALS = CHAT_PROPOSALS.filter(x => x !== p); renderRail(); },
      }, 'Skip')));
}

async function sendChat() {
  const text = String(chatDraft || '').trim();
  if (!text || chatBusy) return;
  CHAT.push({ role: 'user', content: text });
  chatDraft = '';
  chatBusy = true; CHAT_JOB = newJobId();
  busy(true); renderRail(); renderNav();
  try {
    const r = await api('/api/ai/chat', {
      messages: CHAT.map(m => ({ role: m.role, content: m.content })),
      jobId: CHAT_JOB,
    });
    if (r.cancelled) {
      CHAT.push({ role: 'assistant', content: '(cancelled)' });
      toast(r.message, '');
    } else {
      const at = CHAT.length;
      CHAT.push({ role: 'assistant', content: r.reply || '(the model returned nothing)' });
      if (r.trace && r.trace.length) CHAT_TRACE.set(at, r.trace);
      if (r.proposals && r.proposals.length) CHAT_PROPOSALS = CHAT_PROPOSALS.concat(r.proposals);
      if (r.truncated) toast('Stopped at the lookup limit — ask something narrower to go further', '');
    }
  } catch (e) {
    CHAT.push({ role: 'assistant', content: '⚠ ' + e.message });
    toast(e.message, 'bad');
  } finally {
    chatBusy = false; CHAT_JOB = null;
    busy(false); renderRail(); renderNav();
    const box = document.querySelector('.chat-in');
    if (box) box.focus();
  }
}

/* ── Settings tab ────────────────────────────────────────────────── */
function railSettings(body, foot, cfg) {
  if (!AI.ok) {
    body.append(h('div', { class: 'banner' }, h('b', {}, 'Endpoint unreachable. '), AI.error || '',
      h('br'), h('br'), 'Start it with ', h('code', {}, 'ollama serve'), '.'));
  }
  body.append(h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
    h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Endpoint'),
      (() => { const i = h('input', { type: 'text', value: cfg.endpoint || 'http://127.0.0.1:11434' });
        i.addEventListener('change', () => aiSave({ endpoint: i.value.trim() }).catch(e => toast(e.message, 'bad')));
        return i; })()),
    h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Chat model'),
      modelSelect(cfg.model, (v) => aiSave({ model: v }), false)),
    h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Embedding model'),
      modelSelect(cfg.embedModel, (v) => aiSave({ embedModel: v }), true),
      h('span', { class: 'lab', style: { textTransform: 'none', letterSpacing: '0' } },
        'Optional — enables precedent retrieval and semantic duplicate detection.')),
    h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Parallel requests'),
      (() => { const i = h('input', { type: 'number', min: '1', max: '8', value: String(cfg.concurrency || 2) });
        i.addEventListener('change', () => aiSave({ concurrency: Number(i.value) }).catch(e => toast(e.message, 'bad')));
        return i; })()),
    h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Context tokens'),
      (() => { const i = h('input', { type: 'number', min: '2048', step: '2048', value: String(cfg.numCtx || 8192) });
        i.addEventListener('change', () => aiSave({ numCtx: Number(i.value) }).catch(e => toast(e.message, 'bad')));
        return i; })(),
      h('span', { class: 'lab', style: { textTransform: 'none', letterSpacing: '0' } },
        'Chat always asks for at least 16k, since tool results have to fit alongside the conversation.'))));

  if (AI.loaded && AI.loaded.length) {
    body.append(h('h3', {}, 'Loaded in memory'),
      ...AI.loaded.map(m => h('div', { class: 'move' },
        m.name.split('/').pop().slice(0, 26), ' · ',
        h('b', { style: { color: m.gpu > 50 ? 'var(--ok)' : 'var(--alarm)' } }, m.gpu + '% GPU'))),
      h('button', {
        class: 'btn sm', style: { marginTop: '7px' },
        onclick: async () => {
          try { const r = await api('/api/ai/unload', {}); AI = r; toast(r.message, 'good'); renderRail(); }
          catch (e) { toast(e.message, 'bad'); }
        },
      }, 'Unload all models'));
    const cpu = AI.loaded.filter(m => m.gpu === 0);
    if (cpu.length) {
      body.append(h('div', { class: 'gpuwarn', style: { marginTop: '11px' } },
        h('b', {}, 'Running on CPU. '),
        h('code', {}, 'sudo pacman -Syu ollama && sudo systemctl restart ollama')));
    }
  }

  body.append(h('h3', {}, 'GitHub account'), authLine());

  foot.append(h('button', {
    class: 'btn wide' + (cfg.enabled ? '' : ' primary'),
    onclick: () => aiSave({ enabled: !cfg.enabled }).catch(e => toast(e.message, 'bad')),
  }, cfg.enabled ? 'Turn assistant off' : 'Turn assistant on'));
  foot.append(h('button', { class: 'btn wide', onclick: () => aiStatus().then(renderRail) }, 'Re-check endpoint'));
}

/* The app holds no credentials — it inherits whatever `gh` is signed in as on this box. */
function authLine() {
  const a = S && S.auth;
  if (!a) return h('span', { class: 'lab' }, 'checking…');
  if (!a.authed) {
    return h('div', { class: 'banner' },
      h('b', {}, 'Not signed in. '), a.error || '',
      h('br'), h('br'), 'Run ', h('code', {}, 'gh auth login'), ' then press Refresh.');
  }
  return h('div', { class: 'acct' },
    h('span', { class: 'led ok' }), 'signed in as ', h('span', { class: 'who' }, a.login),
    a.scopes ? h('span', { class: 'lab', style: { textTransform: 'none' } }, ' · ' + a.scopes) : null);
}

/* ── Run tab ─────────────────────────────────────────────────────── */
function railRun(body, foot, cfg) {
  if (!cfg.enabled || !cfg.model) {
    body.append(h('div', { class: 'banner warn' },
      cfg.enabled ? 'Pick a chat model in Settings.' : 'Assistant is off — turn it on in Settings.'));
    return;
  }
  if (S && S.auth && !S.auth.authed) body.append(authLine());

  const unclassified = S && S.issues ? S.issues.filter(i => i.st === 'OPEN' && !i.ms).length : 0;
  const ready = !aiBusy && S && S.issuesLoaded;
  const acts = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
    h('button', { class: 'btn wide primary', disabled: !ready, onclick: () => runClassify(false) },
      aiBusy ? h('span', { class: 'spin' }) : null, 'Classify ' + unclassified + ' unassigned'),
    h('button', { class: 'btn wide', disabled: !ready, onclick: () => runClassify(true) }, 'Re-check all open'),
    h('button', { class: 'btn wide', disabled: aiBusy, onclick: () => runSuggest() }, 'Suggest missing issues'),
    h('button', { class: 'btn wide', disabled: !ready, onclick: () => runMilestones() }, 'Suggest milestones'),
    planButtonRow(ready));
  if (cfg.embedModel) {
    acts.append(h('button', {
      class: 'btn wide', disabled: !ready,
      onclick: () => runAi(jobId => api('/api/ai/index', { jobId })),
    }, 'Build / refresh index'));
    /* Pure cosine over vectors that already exist — no inference, so it is instant. */
    acts.append(h('button', {
      class: 'btn wide', disabled: !ready,
      title: 'Compare every issue against every other. No model call — uses the cached index.',
      onclick: async () => {
        busy(true);
        try {
          const r = await api('/api/issues/duplicates', { includeClosed: dupeClosed });
          DUPES = r.clusters; DUPE_SCALE = r.scale || null;
          toast(r.message, r.clusters.length ? 'good' : '');
          renderRail();
        } catch (e) { toast(e.message, 'bad'); }
        finally { busy(false); }
      },
    }, 'Find duplicates'));
    acts.append(h('label', { class: 'inline-check' },
      (() => {
        const box = h('input', { type: 'checkbox', checked: dupeClosed });
        box.addEventListener('change', () => { dupeClosed = box.checked; });
        return box;
      })(),
      h('span', { class: 'lab' }, 'compare against closed issues too')));
  }
  if (aiBusy) {
    acts.append(h('button', {
      class: 'btn wide danger', onclick: () => cancelAi('run'),
      title: 'Stop the model. Nothing has been staged, so nothing is left half-done.',
    }, 'Cancel'));
  }
  body.append(acts);
  if (planChoice) body.append(planChoiceBox());
  body.append(h('div', { class: 'lab', style: { marginTop: '9px', textTransform: 'none', letterSpacing: '0' } },
    'Plan generation saves a local editorial plan and proposes missing issues. Live repository data supplies its dates, milestones, and status.'));

  if (!S || !S.issuesLoaded) {
    body.append(h('div', { class: 'banner warn', style: { marginTop: '11px' } }, 'Pull issues first.'));
  }

  const nothing = !PROPOSALS.length && !SUGGESTIONS.length && !MILESTONES.length &&
    !NEW_LABELS.length && !DUPES.length;

  if (DUPES.length) {
    body.append(h('h3', {}, 'Possible duplicates'),
      h('div', { class: 'lab', style: { marginBottom: '7px' } },
        DUPE_SCALE && DUPE_SCALE.calibrated
          ? `above ${DUPE_SCALE.p99.toFixed(2)} similarity, where this repo averages ${DUPE_SCALE.median.toFixed(2)}`
          : 'the oldest issue keeps the history — closing points at it'));
    DUPES.forEach(cluster => body.append(dupeCard(cluster)));
  }

  if (MILESTONES.length) {
    body.append(h('h3', {}, 'Proposed milestones'));
    MILESTONES.forEach(ms => body.append(milestoneCard(ms)));
  }
  if (NEW_LABELS.length) {
    body.append(h('h3', {}, 'Nominated labels'),
      h('div', { class: 'lab', style: { marginBottom: '7px' } },
        'patterns the existing labels cannot express'));
    NEW_LABELS.forEach(l => body.append(labelCard(l)));
  }
  if (PROPOSALS.length) {
    const changed = PROPOSALS.filter(x => x.changed && !x.error);
    body.append(h('h3', {}, 'Proposed classifications'),
      h('div', { class: 'lab', style: { marginBottom: '7px' } },
        changed.length + ' of ' + PROPOSALS.length + ' would change something'));
    if (changed.length) {
      body.append(h('div', { class: 'acts', style: { marginBottom: '9px' } },
        h('button', {
          class: 'btn sm primary', onclick: async () => {
            let n = 0;
            for (const x of changed) { try { await stageProposal(x, true); n++; } catch { /* keep going */ } }
            PROPOSALS = []; await load(); toast('Staged ' + n, 'good');
          },
        }, 'Stage all ' + changed.length),
        h('button', { class: 'btn sm', onclick: () => { PROPOSALS = []; renderRail(); } }, 'Dismiss')));
    }
    PROPOSALS.forEach(x => body.append(propCard(x)));
  }
  if (SUGGESTIONS.length) {
    body.append(h('h3', {}, 'Suggested new issues'),
      h('div', { class: 'lab', style: { marginBottom: '7px' } }, 'read before staging'));
    SUGGESTIONS.forEach(sg => body.append(suggestCard(sg)));
  }
  if (nothing) body.append(h('div', { class: 'empty' }, 'Run something above.\nOutput lands here.'));

  /* ignored suggestions — hidden until asked for, restorable */
  const ignCount = (S && S.ignoredCount) || IGNORED.length;
  if (ignCount || showIgnored) {
    foot.append(h('button', {
      class: 'btn wide',
      onclick: async () => {
        showIgnored = !showIgnored;
        if (showIgnored) {
          try { const r = await api('/api/ai/ignored'); IGNORED = r.ignored; } catch (e) { toast(e.message, 'bad'); }
        }
        renderRail();
      },
    }, (showIgnored ? 'Hide' : 'Show') + ' ignored (' + ignCount + ')'));
    if (showIgnored) {
      const box = h('div', { style: { maxHeight: '190px', overflowY: 'auto' } });
      if (!IGNORED.length) box.append(h('div', { class: 'lab' }, 'nothing ignored yet'));
      IGNORED.forEach(g => box.append(h('div', { class: 'ign' },
        h('span', { class: 't', title: (g.reason ? g.title + ' — ' + g.reason : g.title) }, g.title),
        h('button', {
          class: 'btn sm', title: 'Forget this entry. The idea can be suggested again.',
          onclick: () => forgetIgnored(g.title),
        }, 'Delete'))));
      foot.append(box);
      if (IGNORED.length) {
        foot.append(arm(h('button', { class: 'btn wide danger' }, 'Delete all ' + IGNORED.length),
          'Delete all ' + IGNORED.length, 'Confirm — the list is emptied',
          async () => {
            try {
              const r = await api('/api/ai/ignored/clear', {});
              IGNORED = r.ignored; toast(r.message, 'good'); await load(); renderRail();
            } catch (e) { toast(e.message, 'bad'); }
          }));
      }
    }
  }
}

/*
 * Deleting an ignored suggestion and un-ignoring one are the same edit — the entry leaves
 * the list and the idea becomes proposable again. The two names exist because in the plan
 * view you are un-hiding one specific gap, and here you are pruning a list.
 */
async function forgetIgnored(title, forget) {
  try {
    const r = await api('/api/ai/unignore', { title, forget: forget !== false });
    IGNORED = r.ignored; IGNORED_TITLES = r.ignored.map(x => x.title);
    toast(r.message, 'good');
    await load();
    if (railOpen) renderRail();
  } catch (e) { toast(e.message, 'bad'); }
}

/* ── plan freshness ──────────────────────────────────────────────── */
/*
 * A plan describes the tracker as it was when it was generated. File a couple of issues or
 * close a couple, and it is quietly out of date while still looking authoritative — so the
 * button that made it says so, and offers to update rather than only to start over.
 */
function driftText(st) {
  if (!st || !st.hasPlan) return 'No plan has been generated for this repository yet.';
  // A scoped plan only counts drift inside its slice, so say which slice it is speaking for.
  const where = st.scopeText ? ' in ' + st.scopeText : '';
  if (!st.stale) return 'The plan still matches the issues' + where + ' it was generated from.';
  const bits = [];
  if (st.added.length) bits.push(st.added.length + ' issue' + (st.added.length === 1 ? '' : 's') + ' filed');
  if (st.closed.length) bits.push(st.closed.length + ' closed');
  return bits.join(' and ') + where +
    (st.capturedAt ? ' since the plan of ' + st.capturedAt : ' since the plan was generated') + '.';
}

function planButtonRow(ready) {
  const st = (S && S.planStatus) || {};
  const btn = h('button', {
    class: 'btn wide', disabled: !ready,
    onclick: () => { planChoice = st.hasPlan ? !planChoice : false; if (st.hasPlan) renderRail(); else runPlan('new'); },
  }, st.hasPlan ? 'Regenerate plan…' : 'Generate plan + insights');
  return h('div', {}, h('div', { class: 'planrow' }, btn,
    st.stale ? h('span', { class: 'drift', title: driftText(st), 'aria-label': driftText(st) }) : null),
    planScopeRow(), planSizeRow());
}

/* How many open issues the current scope actually contains — the number that decides
   whether a plan length is generous or nowhere near enough. */
function planScopeCount() {
  if (!S || !S.issues) return 0;
  return S.issues.filter(i => i.st === 'OPEN'
    && (!planScope.milestone || i.ms === planScope.milestone)
    && (!planScope.label || i.l.includes(planScope.label))).length;
}

/*
 * What the next plan should be about. Two dropdowns rather than a free-text box: both are
 * validated against live repository metadata server-side, and a typo that produced an
 * empty plan would read as "there is nothing to do".
 */
function planScopeRow() {
  const milestones = ((S.github && S.github.milestones) || []).map(m => m.title);
  const used = new Map();
  (S.issues || []).forEach(i => i.l.forEach(n => used.set(n, (used.get(n) || 0) + 1)));
  const labels = [...used.keys()].sort((a, b) => a.localeCompare(b));

  const ms = h('select', { title: 'Restrict the plan to one milestone', style: { width: '100%' } },
    h('option', { value: '', selected: !planScope.milestone }, 'Every milestone'),
    ...milestones.map(t => h('option', { value: t, selected: planScope.milestone === t }, t)));
  ms.addEventListener('change', () => { planScope.milestone = ms.value || null; renderRail(); });

  const lb = h('select', { title: 'Restrict the plan to one label', style: { width: '100%' } },
    h('option', { value: '', selected: !planScope.label }, 'Every label'),
    ...labels.map(n => h('option', { value: n, selected: planScope.label === n }, n + '  (' + used.get(n) + ')')));
  lb.addEventListener('change', () => { planScope.label = lb.value || null; renderRail(); });

  const box = h('div', { class: 'planscope' }, ms, lb);
  const scoped = !!(planScope.milestone || planScope.label);
  if (scoped) {
    const n = planScopeCount();
    box.append(h('div', { class: 'acts' },
      h('span', { class: 'lab' }, n + ' open issue' + (n === 1 ? '' : 's') + ' in scope'),
      h('button', {
        class: 'btn sm',
        onclick: () => { planScope = { milestone: null, label: null }; renderRail(); },
      }, 'Whole tracker')));
  }
  return box;
}

/* How long the next plan should be. Offered next to the button that makes it, because the
   right answer depends on how many issues are in scope — which is right there. */
function planSizeRow() {
  const open = planScopeCount();
  const sel = h('select', {}, ...[10, 15, 20, 30, 40, 50].map(n =>
    h('option', { value: String(n), selected: n === planCount }, n + ' entries')));
  sel.addEventListener('change', () => { planCount = Number(sel.value) || 15; renderRail(); });
  return h('label', { class: 'inline-check', style: { marginTop: '6px' } }, sel,
    h('span', { class: 'lab' }, open ? 'of ' + open + ' open' : 'plan length'));
}

function planChoiceBox() {
  const st = (S && S.planStatus) || {};
  const want = planScope.milestone || planScope.label
    ? [planScope.milestone, planScope.label && 'labelled ' + planScope.label].filter(Boolean).join(' · ')
    : 'the whole tracker';
  // Scope is a property of the plan, so an update keeps the one it was built with. Only
  // "Generate new" adopts what the dropdowns currently say — spell out which is which.
  const differs = (st.scopeText || 'the whole tracker') !== want;
  return h('div', { class: 'choice' },
    h('span', { class: 'lab' }, 'A plan already exists'),
    h('p', {}, driftText(st)),
    differs ? h('p', {}, 'Updating keeps it scoped to ' +
      (st.scopeText || 'the whole tracker') + '. Generating new switches it to ' + want + '.') : null,
    h('div', { class: 'acts' },
      h('button', {
        class: 'btn sm primary',
        title: 'Keep the entries that are still right; place what changed',
        onclick: () => { planChoice = false; runPlan('update'); },
      }, 'Update current plan'),
      h('button', {
        class: 'btn sm', title: 'Start over from the current issues',
        onclick: () => { planChoice = false; runPlan('new'); },
      }, 'Generate new'),
      h('button', { class: 'btn sm', onclick: () => { planChoice = false; renderRail(); } }, 'Cancel')));
}

/*
 * A duplicate group. The action offered is deliberately conservative: close the newer ones
 * with a comment pointing at the oldest, which keeps the discussion in one place and is
 * reversible from the staged queue right up until the push.
 */
function dupeCard(cluster) {
  const keep = cluster.members.find(m => m.number === cluster.keep) || cluster.members[0];
  const others = cluster.members.filter(m => m.number !== keep.number);
  const row = (m, isKeep) => h('div', { class: 'move' + (m.state === 'OPEN' ? '' : ' closed') },
    h('button', {
      class: 'linkish', onclick: () => { SEL.issue = m.number; VIEW = 'issues'; render(); },
    }, '#' + m.number),
    ' ', m.title,
    isKeep ? h('span', { class: 'chip ok' }, 'keep') : null,
    m.state === 'OPEN' ? null : h('span', { class: 'chip' }, 'closed'),
    m.comments ? h('span', { class: 'chip' }, m.comments + ' comment' + (m.comments === 1 ? '' : 's')) : null);

  return h('div', { class: 'prop', style: { '--c': 'var(--warn)' } },
    h('div', { class: 'h' },
      h('span', { class: 't' }, cluster.members.length + ' issues look like the same work'),
      h('span', { class: 'conf ' + (cluster.score >= 0.85 ? 'hi' : 'mid') }, Math.round(cluster.score * 100) + '%')),
    cluster.series
      ? h('div', { class: 'move' }, h('b', {}, 'Careful: '),
        'these read like parallel tasks in one series, which is not the same as one task filed twice.')
      : null,
    row(keep, true),
    ...others.map(m => row(m, false)),
    h('div', { class: 'acts' },
      h('button', {
        class: 'btn sm primary',
        disabled: !others.some(m => m.state === 'OPEN'),
        title: 'Stage a close on the newer ones, each commenting with a pointer to #' + keep.number,
        onclick: async () => {
          busy(true);
          let n = 0;
          try {
            for (const m of others.filter(x => x.state === 'OPEN')) {
              try {
                await api('/api/queue/add', {
                  kind: 'close',
                  payload: {
                    number: m.number, reason: 'not planned',
                    comment: 'Duplicate of #' + keep.number + ' — continuing there.',
                  },
                });
                n++;
              } catch { /* already staged */ }
            }
            DUPES = DUPES.filter(c => c !== cluster);
            await load(); renderRail();
            toast('Staged ' + n + ' close' + (n === 1 ? '' : 's') + ' pointing at #' + keep.number, n ? 'good' : 'bad');
          } finally { busy(false); }
        },
      }, 'Stage close as duplicate'),
      h('button', {
        class: 'btn sm', onclick: () => { DUPES = DUPES.filter(c => c !== cluster); renderRail(); },
      }, 'Not duplicates')));
}

function labelCard(l) {
  return h('div', { class: 'prop', style: { '--c': 'var(--p4)' } },
    h('div', { class: 'h' }, h('span', { class: 't' }, l.name),
      h('span', { class: 'lab' }, l.issues.length + ' issue' + (l.issues.length === 1 ? '' : 's'))),
    h('div', { class: 'move' }, 'from ', h('b', {}, l.issues.map(n => '#' + n).join(' '))),
    l.description ? h('p', { class: 'r' }, l.description) : null,
    l.why ? h('p', { class: 'r' }, l.why) : null,
    h('div', { class: 'acts' },
      h('button', {
        class: 'btn sm primary',
        onclick: async () => {
          await stage('label', { name: l.name, description: l.description || null });
          NEW_LABELS = NEW_LABELS.filter(y => y !== l); renderRail();
        },
      }, 'Stage label'),
      h('button', { class: 'btn sm', onclick: () => { NEW_LABELS = NEW_LABELS.filter(y => y !== l); renderRail(); } }, 'Skip')));
}

function milestoneCard(ms) {
  return h('div', { class: 'prop', style: { '--c': 'var(--p3)' } },
    h('div', { class: 'h' }, h('span', { class: 't' }, ms.title)),
    ms.coversIssues && ms.coversIssues.length
      ? h('div', { class: 'move' }, 'would hold ', h('b', {}, ms.coversIssues.map(n => '#' + n).join(' '))) : null,
    h('p', { class: 'r' }, ms.rationale),
    h('details', {}, h('summary', {}, 'Description'), h('div', { class: 'draft' }, h('pre', {}, ms.description))),
    h('div', { class: 'acts' },
      h('button', {
        class: 'btn sm primary',
        onclick: async () => {
          await stage('milestone', { title: ms.title, description: ms.description });
          MILESTONES = MILESTONES.filter(y => y !== ms); renderRail();
        },
      }, 'Stage milestone'),
      h('button', { class: 'btn sm', onclick: () => { MILESTONES = MILESTONES.filter(y => y !== ms); renderRail(); } }, 'Skip')));
}

async function runMilestones() {
  const r = await runAi(jobId => api('/api/ai/milestones', { jobId }));
  if (r) { MILESTONES = r.milestones; renderRail(); }
}

async function runPlan(mode) {
  const r = await runAi(jobId => api('/api/ai/plan', {
    count: planCount, mode: mode || 'new', jobId,
    // An update reuses the scope already saved with the plan; the server ignores these.
    milestone: planScope.milestone, label: planScope.label,
  }));
  if (!r) return;
  planBannerOff = false;
  await load();
  VIEW = 'plan'; render();
}

/* Embedding models are small and named for it; surface them separately so the two
   dropdowns don't offer each other's models as the obvious choice. */
const looksEmbedding = (m) => /embed|bge|gte|minilm|e5[-_]/i.test(m.name) || (m.sizeGb != null && m.sizeGb < 1.5);

function modelSelect(current, onPick, wantEmbedding) {
  const all = (AI && AI.models) || [];
  const primary = all.filter(m => wantEmbedding ? looksEmbedding(m) : !looksEmbedding(m));
  const rest = all.filter(m => !primary.includes(m));
  const sel = h('select', {},
    h('option', { value: '' }, wantEmbedding ? '— none (retrieval off) —' : '— pick a model —'),
    ...primary.map(m => h('option', { value: m.name, selected: m.name === current },
      m.name.split('/').pop() + (m.sizeGb ? '  (' + m.sizeGb + 'GB)' : ''))),
    ...(rest.length ? [h('option', { value: '', disabled: true }, '──────────')] : []),
    ...rest.map(m => h('option', { value: m.name, selected: m.name === current },
      m.name.split('/').pop() + (m.sizeGb ? '  (' + m.sizeGb + 'GB)' : ''))));
  sel.addEventListener('change', () => onPick(sel.value || null).catch(e => toast(e.message, 'bad')));
  return sel;
}

function propCard(x) {
  if (x.error) {
    return h('div', { class: 'prop skip' },
      h('div', { class: 'h' }, h('span', { class: 'n' }, '#' + x.number)),
      h('p', { class: 'r' }, 'Failed: ' + x.error));
  }
  const c = x.milestone ? pc(phaseFromTitle(x.milestone)) : 'var(--fg-dim)';
  return h('div', { class: 'prop' + (x.changed ? '' : ' skip'), style: { '--c': c } },
    h('div', { class: 'h' }, h('span', { class: 'n' }, '#' + x.number),
      h('span', { class: 't' }, x.title), confChip(x.confidence)),
    x.milestone && x.milestone !== x.current.milestone
      ? h('div', { class: 'move' }, (x.current.milestone || 'none'), ' → ', h('b', {}, x.milestone))
      : h('div', { class: 'move' }, 'milestone unchanged' +
          (x.milestoneRejected ? ' (model invented "' + x.milestoneRejected + '")' : '')),
    x.addLabels.length ? h('div', { class: 'move' }, '+labels: ', h('b', {}, x.addLabels.join(', '))) : null,
    h('p', { class: 'r' }, x.reason),
    x.changed ? h('div', { class: 'acts' },
      h('button', { class: 'btn sm primary', onclick: () => stageProposal(x) }, 'Stage'),
      h('button', { class: 'btn sm', onclick: () => { PROPOSALS = PROPOSALS.filter(y => y !== x); renderRail(); } }, 'Skip')) : null);
}

function suggestCard(sg) {
  const c = sg.milestone ? pc(phaseFromTitle(sg.milestone)) : 'var(--fg-dim)';
  return h('div', { class: 'prop', style: { '--c': c } },
    h('div', { class: 'h' }, h('span', { class: 't' }, sg.title), confChip(sg.confidence)),
    h('div', { class: 'move' }, sg.milestone || 'no milestone',
      sg.labels.length ? ' · ' + sg.labels.join(', ') : ''),
    h('p', { class: 'r' }, sg.rationale),
    h('details', {}, h('summary', {}, 'Body'), h('div', { class: 'draft' }, h('pre', {}, sg.body))),
    h('div', { class: 'acts' },
      h('button', {
        class: 'btn sm primary',
        onclick: async () => {
          await stage('create', { title: sg.title, body: sg.body, milestone: sg.milestone, labels: sg.labels, assignees: [] });
          SUGGESTIONS = SUGGESTIONS.filter(y => y !== sg); renderRail();
        },
      }, 'Stage create'),
      h('button', { class: 'btn sm', onclick: () => { SUGGESTIONS = SUGGESTIONS.filter(y => y !== sg); renderRail(); } }, 'Skip'),
      h('button', {
        class: 'btn sm', title: 'Never suggest this again',
        onclick: async () => {
          try {
            const r = await api('/api/ai/ignore', { title: sg.title, reason: sg.rationale });
            IGNORED = r.ignored; toast(r.message, 'good');
            SUGGESTIONS = SUGGESTIONS.filter(y => y !== sg);
            await load(); renderRail();
          } catch (e) { toast(e.message, 'bad'); }
        },
      }, 'Ignore')));
}

const phaseFromTitle = (t) => {
  const title = String(t || '').trim();
  const planned = S && S.insights && (S.insights.phases || [])
    .find(p => p.title === title || p.name === title);
  if (planned) return planned.n;
  const liveIndex = S && S.github
    ? (S.github.milestones || []).findIndex(m => m.title === title)
    : -1;
  if (liveIndex >= 0) return liveIndex;
  const legacy = /^\s*Phase\s+(\d+)\b/i.exec(title);
  return legacy ? Number(legacy[1]) : null;
};

function stageProposal(x, quiet) {
  const payload = { number: x.number };
  if (x.milestone && x.milestone !== x.current.milestone) payload.milestone = x.milestone;
  if (x.addLabels.length) payload.addLabels = x.addLabels;
  if (quiet) return api('/api/queue/add', { kind: 'edit', payload });
  return stage('edit', payload).then(() => {
    PROPOSALS = PROPOSALS.filter(y => y !== x); renderRail();
  });
}

async function runClassify(includeClassified) {
  const r = await runAi(jobId => api('/api/ai/classify', { includeClassified, limit: 40, jobId }));
  if (!r) return;
  PROPOSALS = r.proposals; SUGGESTIONS = [];
  /* Categories the model had to invent to place something are proposals in their own
     right, and share the milestone card the dedicated suggester already uses. */
  MILESTONES = (r.newMilestones || []).map(m => ({
    title: m.title, description: m.description,
    rationale: m.why, coversIssues: m.issues,
  }));
  NEW_LABELS = r.newLabels || [];
  renderRail();
}

async function runSuggest() {
  const r = await runAi(jobId => api('/api/ai/suggest', { count: 6, jobId }));
  if (!r) return;
  SUGGESTIONS = r.suggestions; PROPOSALS = [];
  renderRail();
}


/* ── shared diff renderer ────────────────────────────────────────── */
function diffBlock(patch, label) {
  const pre = h('pre', {});
  const lines = String(patch || '').split('\n');
  lines.slice(0, 4000).forEach(l => {
    let cls = '';
    if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ')) cls = 'meta';
    else if (l.startsWith('@@')) cls = 'hunk';
    else if (l.startsWith('+')) cls = 'add';
    else if (l.startsWith('-')) cls = 'del';
    pre.append(h('span', { class: 'dl ' + cls }, l || ' '));
  });
  return h('div', { class: 'diff' },
    h('div', { class: 'diff-head' }, h('span', {}, label || ''),
      h('span', { class: 'lab' }, lines.length > 4000 ? 'truncated at 4000 lines' : lines.length + ' lines')),
    pre);
}

/*
 * Edit a change that is already staged. Only the fields that make sense for its kind are
 * shown; the server re-validates and rebuilds the argv, so the command in the row always
 * matches what will actually run.
 */
function stagedEditor(c) {
  const gh = S.github || { milestones: [], labels: [] };
  const box = h('div', { class: 'editbox' });
  const fields = {};
  const P = c.payload || {};

  const addText = (key, label, value, area) => {
    const el = area ? h('textarea', { placeholder: label }) : h('input', { type: 'text', placeholder: label });
    el.value = value == null ? '' : String(value);
    fields[key] = () => el.value;
    box.append(h('div', { class: 'field' }, h('span', { class: 'lab' }, label), el));
  };

  if (c.kind === 'create' || c.kind === 'milestone') addText('title', 'Title', P.title);
  if (c.kind === 'create') addText('body', 'Body', P.body, true);
  if (c.kind === 'milestone') { addText('description', 'Description', P.description, true); addText('dueOn', 'Due date (YYYY-MM-DD)', P.dueOn); }
  if (c.kind === 'label') { addText('name', 'Name', P.name); addText('description', 'Description', P.description); }
  if (c.kind === 'comment') addText('body', 'Comment', P.body, true);
  if (c.kind === 'edit' && P.title != null) addText('title', 'New title', P.title);
  if (c.kind === 'close') addText('comment', 'Closing comment (optional)', P.comment, true);

  if (c.kind === 'create' || (c.kind === 'edit' && (P.milestone || P.removeMilestone))) {
    const sel = h('select', {}, h('option', { value: '' }, '— none —'),
      ...gh.milestones.map(m => h('option', { value: m.title, selected: m.title === P.milestone }, m.title)),
      ...S.queue.filter(x => x.kind === 'milestone' && !gh.milestones.some(m => m.title === x.payload.title))
        .map(x => h('option', { value: x.payload.title, selected: x.payload.title === P.milestone },
          x.payload.title + '  (staged)')));
    fields.milestone = () => sel.value;
    box.append(h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Milestone'), sel));
  }
  if (c.kind === 'close') {
    const sel = h('select', {}, ...['completed', 'not planned'].map(r =>
      h('option', { value: r, selected: r === P.reason }, r)));
    fields.reason = () => sel.value;
    box.append(h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Reason'), sel));
  }
  if (c.kind === 'create' || c.kind === 'edit') {
    const chosen = new Set(c.kind === 'create' ? (P.labels || []) : (P.addLabels || []));
    const picker = h('div', { class: 'picker' }, ...gh.labels.map(l =>
      h('button', {
        class: 'pick', 'aria-pressed': String(chosen.has(l.name)),
        onclick: (e) => {
          chosen.has(l.name) ? chosen.delete(l.name) : chosen.add(l.name);
          e.currentTarget.setAttribute('aria-pressed', String(chosen.has(l.name)));
        },
      }, l.name)));
    fields.labels = () => [...chosen];
    box.append(h('div', { class: 'field' },
      h('span', { class: 'lab' }, c.kind === 'create' ? 'Labels' : 'Labels to add'), picker));
  }

  box.append(h('div', { class: 'acts' },
    h('button', {
      class: 'btn primary sm',
      onclick: async () => {
        const payload = {};
        if (fields.title) payload.title = fields.title();
        if (fields.name) payload.name = fields.name();
        if (fields.body) payload.body = fields.body();
        if (fields.description) payload.description = fields.description();
        if (fields.dueOn) payload.dueOn = fields.dueOn() || null;
        if (fields.reason) payload.reason = fields.reason();
        if (fields.comment) payload.comment = fields.comment() || null;
        if (fields.milestone) {
          const v = fields.milestone();
          if (c.kind === 'create') payload.milestone = v || null; else if (v) payload.milestone = v;
        }
        if (fields.labels) {
          const v = fields.labels();
          if (c.kind === 'create') payload.labels = v; else payload.addLabels = v;
        }
        try { await act(() => api('/api/queue/update', { id: c.id, payload }), 'queue'); EDITING = null; renderPane(); }
        catch { /* act() surfaced it; leave the editor open so nothing is lost */ }
      },
    }, 'Save change'),
    h('button', { class: 'btn sm', onclick: () => { EDITING = null; renderPane(); } }, 'Cancel')));
  return box;
}

/* ── pull requests ───────────────────────────────────────────────── */
async function loadPrs() {
  if (!S || !S.selected || !S.selected.github) return;
  busy(true);
  try { const r = await api('/api/pr/list?state=' + encodeURIComponent(prState)); PRS = r.prs; prLoaded = true; render(); }
  catch (e) { toast(e.message, 'bad'); }
  finally { busy(false); }
}

function sidePrs(body, foot) {
  if (!S.selected.github) return body.append(h('div', { class: 'empty' }, 'No GitHub remote.'));
  body.append(h('div', { style: { padding: '10px 11px', borderBottom: '1px solid var(--line-soft)' } },
    (() => {
      const sel = h('select', { style: { width: '100%' } },
        ...[['open', 'Open'], ['merged', 'Merged'], ['closed', 'Closed'], ['all', 'All']].map(([v, t]) =>
          h('option', { value: v, selected: prState === v }, t)));
      sel.addEventListener('change', () => { prState = sel.value; prLoaded = false; loadPrs(); });
      return sel;
    })()));
  if (!prLoaded) body.append(h('div', { class: 'empty' }, 'Loading…'));
  else if (!PRS.length) body.append(h('div', { class: 'empty' }, 'No ' + prState + ' pull requests.'));
  else PRS.forEach(pr => body.append(h('div', {
    class: 'prrow', 'aria-selected': String(SEL.pr === pr.n),
    onclick: () => { SEL.pr = pr.n; render(); },
  },
    h('span', { class: 'n' }, '#' + pr.n),
    h('span', { class: 't' }, pr.t,
      h('span', { class: 'sub' }, pr.head + ' → ' + pr.base + (pr.author ? ' · ' + pr.author : ''))),
    h('span', { class: 'st-' + (pr.draft ? 'draft' : pr.st.toLowerCase()) }, pr.draft ? 'draft' : pr.st.toLowerCase()))));
  foot.append(h('button', { class: 'btn wide', onclick: () => { prLoaded = false; loadPrs(); } }, 'Refresh'));
  foot.append(newPrButton());
}

/*
 * "Open a pull request from this branch" — the GitHub Desktop affordance.
 *
 * A branch with no upstream is not a dead end: it is a branch that needs publishing, and
 * the form says so and offers to do it. Disabling the button and leaving the user to find
 * the push control themselves was the wrong half of the answer.
 */
function newPrButton(wide = true) {
  const st = S.git && S.git.status;
  const existing = S.branchPr;
  const cls = 'btn primary' + (wide ? ' wide' : ' sm');
  if (existing && existing.st === 'OPEN') {
    return h('a', { class: cls, href: existing.url, target: '_blank', rel: 'noreferrer noopener' },
      'View PR #' + existing.n + ' ↗');
  }
  const can = !!(st && st.branch && !st.detached && S.selected && S.selected.github);
  return h('button', {
    class: cls, disabled: !can,
    title: can ? 'Open a pull request from ' + st.branch : 'Needs a branch and a GitHub remote',
    onclick: () => { SEL.pr = 'new'; VIEW = 'prs'; render(); },
  }, 'Create pull request');
}

/*
 * Every branch a pull request could be merged into: the local ones, plus branches that
 * exist only on the remote. Listing local branches alone hid the common case — merging
 * into a long-lived branch this clone has never checked out.
 */
function baseBranchOptions() {
  const st = S.git.status;
  const local = (S.git.branches.local || []).map(b => b.name);
  const remoteOnly = S.git.branches.remoteOnly || [];
  const seen = new Set();
  return [...local, ...remoteOnly].filter(name =>
    name && name !== st.branch && !seen.has(name) && seen.add(name));
}

/* The repository's own default branch, not a guess at what it might be called. */
function defaultBaseBranch(names) {
  const dflt = S.github && S.github.defaultBranch;
  if (dflt && names.includes(dflt)) return dflt;
  return names.find(n => /^(main|master|develop|development)$/i.test(n)) || names[0] || null;
}

async function panePrs(p) {
  if (SEL.pr === 'new') return paneNewPr(p);
  if (!SEL.pr) return p.append(h('div', { class: 'empty' }, 'Select a pull request.'));
  p.append(h('div', { class: 'empty' }, 'Loading #' + SEL.pr + '…'));
  try {
    const pr = await api('/api/pr/view?number=' + encodeURIComponent(SEL.pr));
    clear(p);
    const wrap = h('div', { class: 'pane-narrow detail' });
    wrap.append(h('div', { class: 'head' },
      h('div', { class: 'tags' },
        h('span', { class: 'chip solid', style: { '--c': pr.draft ? 'var(--fg-dim)' : (pr.st === 'OPEN' ? 'var(--ok)' : pr.st === 'MERGED' ? 'var(--p5)' : 'var(--alarm)') } },
          pr.draft ? 'draft' : pr.st.toLowerCase()),
        h('span', { class: 'chip' }, '#' + pr.n),
        h('span', { class: 'chip' }, pr.head + ' → ' + pr.base),
        pr.review ? h('span', { class: 'chip' }, String(pr.review).toLowerCase().replace(/_/g, ' ')) : null,
        pr.mergeable === 'CONFLICTING' ? h('span', { class: 'chip risk' }, 'conflicts') : null),
      h('div', { class: 't' }, pr.t),
      h('div', { class: 'acts' },
        h('span', { class: 'adds' }, '+' + pr.adds), h('span', { class: 'dels' }, '−' + pr.dels),
        h('span', { class: 'lab' }, pr.files + ' files'),
        h('a', { class: 'btn sm', href: pr.url, target: '_blank', rel: 'noreferrer noopener' }, 'Open on GitHub ↗'))));
    /* The description is editable in place. Unlike an issue edit this is not staged —
       it matches PR creation, which is also a direct write behind a confirm. */
    const desc = h('textarea', { placeholder: 'No description', style: { minHeight: '150px' } });
    desc.value = pr.body || '';
    const saveDesc = arm(h('button', { class: 'btn sm' }, 'Save description'),
      'Save description', 'Confirm — this is public',
      async () => {
        await act(() => api('/api/pr/edit', { number: pr.n, body: desc.value }), 'git');
        renderPane();
      });
    wrap.append(h('div', { class: 'field' },
      h('span', { class: 'lab' }, 'Description'), desc,
      h('div', { class: 'acts' }, saveDesc,
        h('button', { class: 'btn sm', onclick: () => { desc.value = pr.body || ''; } }, 'Revert'))));
    if (pr.commits.length) {
      wrap.append(h('h3', {}, pr.commits.length + ' commits'));
      const list = h('div', { class: 'commits' });
      pr.commits.forEach(c => list.append(h('div', { class: 'crow' },
        h('span', { class: 'sha' }, c.sha), h('span', { class: 's' }, c.subject), h('span', { class: 'w' }, c.author || ''))));
      wrap.append(list);
    }
    if (pr.diff) wrap.append(h('h3', {}, 'Diff'), diffBlock(pr.diff, pr.head));
    p.append(wrap);
  } catch (e) { clear(p).append(h('div', { class: 'banner' }, h('b', {}, 'Could not load. '), e.message)); }
}

function paneNewPr(p) {
  const st = S.git.status;
  const names = baseBranchOptions();
  const chosen = defaultBaseBranch(names);
  const title = h('input', { type: 'text', placeholder: 'Pull request title' });
  title.value = (S.git.log && S.git.log[0] && S.git.log[0].subject) || '';
  const body = h('textarea', { placeholder: 'Description', style: { minHeight: '150px' } });
  const base = h('select', {}, ...names.map(n => h('option', { value: n, selected: n === chosen },
    n + (n === (S.github && S.github.defaultBranch) ? '  (default)' : '') +
    ((S.git.branches.remoteOnly || []).includes(n) ? '  (remote only)' : ''))));
  const draft = h('input', { type: 'checkbox' });
  const route = h('span', { class: 'chip' }, st.branch + ' → ' + (chosen || '?'));
  base.addEventListener('change', () => { route.textContent = st.branch + ' → ' + base.value; });
  const wrap = h('div', { class: 'pane-narrow detail' },
    h('div', { class: 'head' }, h('div', { class: 't' }, 'New pull request'),
      h('div', { class: 'tags' }, route,
        st.ahead ? h('span', { class: 'chip' }, st.ahead + ' ahead') : null)));

  if (!names.length) {
    wrap.append(h('div', { class: 'banner warn' },
      'There is no other branch to merge into. Create one, or fetch the remote first.'));
  }

  /* A branch that only exists locally has nothing for GitHub to compare, so the form says
     what is missing and does that one step rather than refusing the whole action. */
  if (!st.upstream) {
    wrap.append(h('div', { class: 'banner warn' },
      h('b', {}, st.branch + ' is not on GitHub yet. '),
      'A pull request needs the branch pushed first.',
      h('div', { class: 'acts', style: { marginTop: '8px' } },
        h('button', {
          class: 'btn sm primary',
          onclick: () => act(() => api('/api/git/sync', { action: 'push' }), 'git'),
        }, 'Publish ' + st.branch))));
  }

  const submit = arm(h('button', { class: 'btn primary', disabled: !names.length || !st.upstream },
    'Create pull request'),
  'Create pull request', 'Confirm — this is public',
  async () => {
    const r = await act(() => api('/api/pr/create', {
      title: title.value.trim(), body: body.value, base: base.value, head: st.branch, draft: draft.checked,
    }), 'git');
    SEL.pr = (r && r.number) || null; prLoaded = false; loadPrs();
  });

  wrap.append(
    h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Title'), title),
    h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Merge into'), base),
    h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Description'), body),
    h('label', { class: 'acts' }, draft, h('span', { class: 'lab' }, 'Open as a draft')),
    h('div', { class: 'acts' }, submit,
      h('button', { class: 'btn', onclick: () => { SEL.pr = null; renderPane(); } }, 'Cancel')));
  p.append(wrap);
}

/* ── popovers ────────────────────────────────────────────────────── */
let openPop = null;
function closePop() {
  if (!openPop) return;
  openPop.el.remove();
  openPop.btn.setAttribute('aria-expanded', 'false');
  openPop = null;
}
function popover(btn, title, build) {
  if (openPop && openPop.btn === btn) return closePop();
  closePop();
  const el = h('div', { class: 'pop' }, h('h4', {}, title));
  const body = h('div', { class: 'pop-body' });
  el.append(body);
  build(body, el);
  document.body.append(el);
  const r = btn.getBoundingClientRect();
  el.style.top = r.bottom + 'px';
  el.style.left = Math.min(r.left, window.innerWidth - el.offsetWidth - 10) + 'px';
  btn.setAttribute('aria-expanded', 'true');
  openPop = { btn, el };
}
document.addEventListener('click', (e) => {
  if (openPop && !openPop.el.contains(e.target) && !openPop.btn.contains(e.target)) closePop();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });

$('tb-repo').addEventListener('click', () => popover($('tb-repo'), 'Select a repository', (body, el) => {
  if (!S.repos.length) body.append(h('div', { class: 'empty' }, 'No repositories tracked yet.'));
  S.repos.forEach(r => {
    const select = h('button', {
      class: 'pop-row', 'aria-current': String(S.selected && S.selected.path === r.path),
      onclick: async () => { closePop(); await act(() => api('/api/repos/select', { path: r.path }), 'git'); },
    }, h('span', { class: 't' }, r.name), h('span', { class: 'sub' }, r.github || r.path));
    const remove = arm(h('button', {
      class: 'btn sm repo-remove',
      title: 'Stop tracking this repository. Its local folder and files will remain untouched.',
      'aria-label': 'Stop tracking ' + r.name,
    }, 'Remove'), 'Remove', 'Confirm — files stay', async () => {
      closePop();
      await act(() => api('/api/repos/remove', { path: r.path }), 'git');
    });
    body.append(h('div', { class: 'repo-entry' }, select, remove));
  });
  const url = h('input', { type: 'text', placeholder: 'Clone: github.com/owner/name or owner/name' });
  const cloneBtn = h('button', { class: 'btn primary' }, 'Clone');
  cloneBtn.addEventListener('click', async () => {
    const v = url.value.trim();
    if (!v) return toast('Paste a repository URL or owner/name', 'bad');
    cloneBtn.disabled = true; cloneBtn.textContent = 'cloning…';
    closePop();
    try { await act(() => api('/api/repos/clone', { url: v }), 'full'); }
    catch { /* act() already surfaced it */ }
  });
  const folder = h('input', { type: 'text', placeholder: 'Path to a repo, or a folder of repos…' });
  el.append(h('div', { class: 'pop-foot' }, url, cloneBtn));
  el.append(h('div', { class: 'pop-foot' },
    folder,
    h('button', {
      class: 'btn', onclick: async () => {
        const v = folder.value.trim(); if (!v) return;
        closePop(); await act(() => api('/api/repos/add', { path: v }));
      },
    }, 'Add'),
    h('button', { class: 'btn', onclick: async () => { closePop(); await act(() => api('/api/repos/refresh', {})); } }, 'Recheck')));
}));

$('tb-branch').addEventListener('click', () => popover($('tb-branch'), 'Branches', (body, el) => {
  const g = S.git;
  g.branches.local.forEach(b => body.append(h('button', {
    class: 'pop-row', 'aria-current': String(b.current),
    onclick: async () => { closePop(); await act(() => api('/api/git/checkout', { branch: b.name })); },
  }, h('span', { class: 't' }, b.name),
    h('span', { class: 'sub' }, (b.upstream ? b.upstream + ' · ' : 'local only · ') + b.sha + ' · ' + b.subject))));
  if (g.branches.remoteOnly.length) {
    body.append(h('div', { class: 'lab', style: { padding: '9px 11px 4px' } }, 'On the remote only'));
    g.branches.remoteOnly.forEach(n => body.append(h('button', {
      class: 'pop-row',
      onclick: async () => { closePop(); await act(() => api('/api/git/checkout', { branch: n })); },
    }, h('span', { class: 't' }, n), h('span', { class: 'sub' }, 'check out a local copy'))));
  }
  // Merge/delete act on OTHER branches, so they hang off each row rather than the footer.
  body.querySelectorAll('.pop-row').forEach((row, k) => {
    const b = g.branches.local[k];
    if (!b || b.current) return;
    const tools = h('div', { style: { display: 'flex', gap: '3px', padding: '0 11px 6px' } },
      h('button', {
        class: 'btn sm', title: 'Merge ' + b.name + ' into ' + g.branches.current,
        onclick: async (e) => { e.stopPropagation(); closePop(); await act(() => api('/api/git/merge', { branch: b.name }), 'git'); },
      }, 'Merge in'),
      arm(h('button', { class: 'btn sm danger' }, 'Delete'), 'Delete', 'Confirm delete',
        async () => { closePop(); await act(() => api('/api/git/branch-delete', { branch: b.name }), 'git'); }));
    if (row.parentNode) row.parentNode.insertBefore(tools, row.nextSibling);
  });

  const input = h('input', { type: 'text', placeholder: 'New branch name…' });
  el.append(h('div', { class: 'pop-foot' }, input,
    h('button', {
      class: 'btn primary', onclick: async () => {
        const v = input.value.trim(); if (!v) return;
        closePop(); await act(() => api('/api/git/checkout', { branch: v, create: true }));
      },
    }, 'Create')));
}));

$('tb-sync').addEventListener('click', () => popover($('tb-sync'), 'Sync with origin', (body) => {
  const st = S.git.status;
  const row = (t, sub, action) => h('button', {
    class: 'pop-row',
    onclick: async () => { closePop(); await act(() => api('/api/git/sync', { action })); },
  }, h('span', { class: 't' }, t), h('span', { class: 'sub' }, sub));
  body.append(row('Fetch origin', 'Update remote refs, change nothing locally', 'fetch'));
  body.append(row('Pull' + (st.behind ? ' (' + st.behind + ' behind)' : ''),
    st.upstream ? 'Fast-forward only — never rewrites your work' : 'No upstream set', 'pull'));
  body.append(row('Push' + (st.ahead ? ' (' + st.ahead + ' ahead)' : ''),
    st.upstream ? 'Send commits to ' + st.upstream : 'Sets upstream to origin/' + (st.branch || '?'), 'push'));
}));

/* ── command palette ─────────────────────────────────────────────── */
/*
 * Ctrl-K. One box that reaches everything: views, repositories, branches, assistant
 * actions, and every issue in the tracker by meaning rather than by exact title.
 *
 * The issue search runs through the same hybrid endpoint the sidebar uses, so typing
 * "the thing about chests" finds the issue even when it never says "chest".
 */
let paletteOpen = false;
let paletteSeq = 0;

function paletteActions() {
  const out = [];
  const add = (group, name, hint, run, enabled = true) => out.push({ group, name, hint, run, enabled });

  add('Go', 'Issues', 'issue list', () => { VIEW = 'issues'; render(); });
  add('Go', 'Plan', 'recommended order', () => { VIEW = 'plan'; render(); }, !!(S && S.insights));
  add('Go', 'Changes', 'working tree', () => { VIEW = 'changes'; render(); refreshGit(); });
  add('Go', 'History', 'recent commits', () => { VIEW = 'history'; render(); refreshGit(); });
  add('Go', 'Pull requests', '', () => { VIEW = 'prs'; render(); if (!prLoaded) loadPrs(); });
  add('Go', 'Staged changes', (S ? S.queue.length : 0) + ' waiting', () => { VIEW = 'staged'; render(); });

  add('Do', 'Pull issues from GitHub', '', () => pullIssues(), !!(S && S.selected && S.selected.github));
  add('Do', 'Refresh everything', '', () => $('btn-refresh').click());
  add('Do', 'New issue', 'staged, not filed', () => { VIEW = 'issues'; SEL.issue = 'new'; render(); });
  add('Do', 'Create pull request', S && S.git && S.git.status.branch ? 'from ' + S.git.status.branch : '',
    () => { SEL.pr = 'new'; VIEW = 'prs'; render(); },
    !!(S && S.selected && S.selected.github && S.git && S.git.status.branch && !S.git.status.detached));
  if (S && S.queue.length) {
    add('Do', 'Push ' + S.queue.length + ' staged change' + (S.queue.length === 1 ? '' : 's'),
      S.dryRun ? 'dry run' : 'writes to GitHub', () => act(() => api('/api/queue/push', {}), 'queue'));
  }
  add('Do', 'Toggle assistant panel', '', () => toggleRail());

  add('Assistant', 'Chat', 'ask about this repo', () => { toggleRail(true); RAIL_TAB = 'chat'; renderRail(); });
  add('Assistant', 'Classify unassigned issues', '', () => { toggleRail(true); RAIL_TAB = 'run'; renderRail(); runClassify(false); },
    assistantAvailable());
  add('Assistant', 'Suggest missing issues', '', () => { toggleRail(true); RAIL_TAB = 'run'; renderRail(); runSuggest(); },
    assistantAvailable());
  add('Assistant', (S && S.planStatus && S.planStatus.hasPlan) ? 'Update the plan' : 'Generate a plan',
    (S && S.planStatus && S.planStatus.stale) ? 'the tracker moved on' : '',
    () => { toggleRail(true); RAIL_TAB = 'run'; renderRail(); runPlan(S && S.planStatus && S.planStatus.hasPlan ? 'update' : 'new'); },
    assistantAvailable());
  add('Assistant', 'Find duplicate issues', 'no model call', async () => {
    toggleRail(true); RAIL_TAB = 'run';
    try {
      const r = await api('/api/issues/duplicates', { includeClosed: dupeClosed });
      DUPES = r.clusters; DUPE_SCALE = r.scale || null; toast(r.message, r.clusters.length ? 'good' : '');
    } catch (e) { toast(e.message, 'bad'); }
    renderRail();
  });
  if (aiBusy || chatBusy) add('Assistant', 'Cancel what the model is doing', '', () => { cancelAi('run'); cancelAi('chat'); });

  (S ? S.repos : []).forEach(r => {
    if (S.selected && S.selected.path === r.path) return;
    add('Repository', r.name, r.github || r.path,
      () => act(() => api('/api/repos/select', { path: r.path }), 'git'));
  });
  if (S && S.git) {
    S.git.branches.local.forEach(b => {
      if (b.current) return;
      add('Branch', b.name, 'check out', () => act(() => api('/api/git/checkout', { branch: b.name })));
    });
  }
  return out.filter(x => x.enabled);
}

/* Subsequence match, the way every command palette works: "gp" finds "Generate a plan". */
function fuzzy(needle, haystack) {
  const n = needle.toLowerCase(), h = haystack.toLowerCase();
  if (!n) return 0.5;
  if (h.includes(n)) return 1 - (h.indexOf(n) / (h.length + 1)) * 0.3;
  let at = 0, hits = 0;
  for (const ch of n) {
    const found = h.indexOf(ch, at);
    if (found < 0) return 0;
    if (found === at) hits += 0.5;
    at = found + 1;
  }
  return 0.35 + (hits / n.length) * 0.2;
}

function openPalette() {
  if (paletteOpen) return closePalette();
  paletteOpen = true;
  const input = h('input', {
    type: 'text', class: 'pal-input', placeholder: 'Jump to an issue, or run a command…',
    'aria-label': 'Command palette',
  });
  const list = h('div', { class: 'pal-list', role: 'listbox' });
  const overlay = h('div', { class: 'pal-overlay', id: 'palette' },
    h('div', { class: 'pal', role: 'dialog', 'aria-label': 'Command palette' },
      input, list,
      h('div', { class: 'pal-foot' },
        h('span', { class: 'lab' }, '↑↓ move · enter run · esc close'))));
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closePalette(); });
  document.body.append(overlay);

  let rows = [], cursor = 0;

  const draw = () => {
    clear(list);
    if (!rows.length) {
      list.append(h('div', { class: 'empty' }, 'Nothing matches.'));
      return;
    }
    rows.forEach((row, idx) => {
      const el = h('div', {
        class: 'pal-row' + (idx === cursor ? ' on' : ''), role: 'option',
        'aria-selected': String(idx === cursor),
        onmousemove: () => { if (cursor !== idx) { cursor = idx; draw(); } },
        onclick: () => { closePalette(); row.run(); },
      },
        h('span', { class: 'g' }, row.group),
        h('span', { class: 't' }, row.name),
        row.hint ? h('span', { class: 'hint' }, row.hint) : null);
      list.append(el);
      if (idx === cursor) el.scrollIntoView({ block: 'nearest' });
    });
  };

  const recompute = async (raw) => {
    const q = raw.trim();
    const mine = ++paletteSeq;
    const actions = paletteActions()
      .map(a => ({ ...a, score: Math.max(fuzzy(q, a.name), fuzzy(q, a.group + ' ' + a.name) * 0.9) }))
      .filter(a => a.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, q ? 8 : 12);
    rows = actions;
    cursor = 0;
    draw();
    if (q.length < 2 || !S || !S.issuesLoaded) return;

    // Issues are searched server-side so meaning counts, and folded in beneath the actions.
    try {
      const r = await api('/api/issues/search', { q, state: 'all', limit: 8 });
      if (mine !== paletteSeq || !paletteOpen) return;
      const byNum = new Map(S.issues.map(i => [i.n, i]));
      const issueRows = r.hits.map(hit => {
        const issue = byNum.get(hit.number);
        if (!issue) return null;
        return {
          group: '#' + issue.n,
          name: issue.t,
          hint: (issue.st === 'OPEN' ? '' : 'closed · ') + (hit.why || ''),
          run: () => { VIEW = 'issues'; SEL.issue = issue.n; render(); },
        };
      }).filter(Boolean);
      rows = actions.slice(0, 5).concat(issueRows);
      cursor = Math.min(cursor, Math.max(0, rows.length - 1));
      draw();
    } catch { /* the action list is still useful on its own */ }
  };

  input.addEventListener('input', () => recompute(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(cursor + 1, rows.length - 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(cursor - 1, 0); draw(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[cursor];
      if (row) { closePalette(); row.run(); }
    } else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  });
  recompute('');
  input.focus();
}

function closePalette() {
  paletteOpen = false;
  paletteSeq++;
  const el = $('palette');
  if (el) el.remove();
}

/* ── keyboard ────────────────────────────────────────────────────── */
/*
 * Shortcuts only fire when you are not typing. Checking the event target rather than a
 * global "modal open" flag means a text field anywhere — including ones added later —
 * keeps its keys without anything having to know about it.
 */
const typingIn = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
  el.tagName === 'SELECT' || el.isContentEditable);

function moveIssueCursor(delta) {
  const rows = visibleIssues();
  if (!rows.length) return;
  const at = rows.findIndex(i => i.n === SEL.issue);
  const next = at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + delta));
  SEL.issue = rows[next].n;
  renderIssueList(); renderPane();
  const el = document.querySelector('#issue-list .irow[aria-selected="true"]');
  if (el) el.scrollIntoView({ block: 'nearest' });
}

document.addEventListener('keydown', (e) => {
  if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    return openPalette();
  }
  // Escape closes the palette from anywhere, not only from its input. Clicking a row or
  // the scrollbar moves focus, and a dialog you cannot dismiss is worse than no dialog.
  if (e.key === 'Escape' && paletteOpen) { e.preventDefault(); return closePalette(); }
  if (paletteOpen || typingIn(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;

  if (e.key === '/') { e.preventDefault(); const box = $('issue-search'); if (box) { box.focus(); box.select(); } return; }
  if (e.key === '?') { e.preventDefault(); return openPalette(); }
  if (VIEW !== 'issues') return;

  if (e.key === 'j') { e.preventDefault(); moveIssueCursor(1); }
  else if (e.key === 'k') { e.preventDefault(); moveIssueCursor(-1); }
  else if (e.key === 'x') {
    e.preventDefault();
    if (SEL.issue != null && SEL.issue !== 'new') togglePick(SEL.issue, false);
  } else if (e.key === 'Escape' && PICKED.size) { e.preventDefault(); clearPicked(); }
});

/* ── wiring ──────────────────────────────────────────────────────── */
$('nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (!b || b.disabled) return;
  VIEW = b.dataset.view;
  render();
  // Opening Changes or History should show the tree as it is NOW, not as it was when the
  // page last loaded. Git calls are ~0ms, so this is free.
  if (VIEW === 'changes' || VIEW === 'history') refreshGit();
  // Plan and Changes both offer assistant actions, so they need to know whether it is up.
  if ((VIEW === 'changes' || VIEW === 'plan') && !AI) aiStatus();
  if (VIEW === 'prs' && !prLoaded) loadPrs();
});

/*
 * Edits made in an editor while this tab sat in the background would otherwise never
 * appear. Re-check git whenever the window comes back, and poll gently while Changes is
 * open. Only git is re-read — issues stay cached, so nothing costs a GitHub round trip.
 */
async function refreshGit() {
  if (!S || !S.selected) return;
  try {
    const next = await api('/api/state');
    if (!S) return;
    const before = JSON.stringify(S.git && S.git.status.files);
    S.git = next.git; S.queue = next.queue; S.auth = next.auth;
    // Drop ticks for files that are no longer changed, so a stale path can't be committed.
    const live = new Set(next.git.status.files.map(f => f.path));
    [...CHECKED].forEach(p => { if (!live.has(p)) CHECKED.delete(p); });
    // Do not replace the Changes DOM on every poll. Besides doing needless diff work,
    // that destroyed the active commit input and its caret while the user was typing.
    if (JSON.stringify(next.git.status.files) !== before) render();
    else { renderTop(); renderNav(); }
  } catch { /* the banner in load() covers a real outage */ }
}

window.addEventListener('focus', () => refreshGit());
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshGit(); });
setInterval(() => { if (VIEW === 'changes' && !document.hidden) refreshGit(); }, 4000);
$('btn-refresh').addEventListener('click', async () => {
  await load({ fresh: true });
  // The explicit top-bar refresh means everything, including the issue fields used by
  // Plan cards. Background git polling remains local-only and keeps the issue cache.
  if (S && S.selected && S.selected.github && !S.githubError) await pullIssues();
});
$('btn-ai').addEventListener('click', () => toggleRail());
$('ai-close').addEventListener('click', () => toggleRail(false));
$('ai-tab-run').addEventListener('click', () => { RAIL_TAB = 'run'; renderRail(); });
$('ai-tab-chat').addEventListener('click', () => {
  RAIL_TAB = 'chat'; renderRail();
  const box = document.querySelector('.chat-in');
  if (box) box.focus();
});
$('ai-tab-set').addEventListener('click', () => { RAIL_TAB = 'settings'; renderRail(); });

load();
