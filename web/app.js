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
const APP_API = 9;
const staleServer = () => Number(BOOT.api || 0) !== APP_API;
let S = null;                 // last server state
let VIEW = 'issues';
let SEL = { issue: null, file: null, commit: null };
const FILTER = {
  phase: null, milestone: null, label: null, q: '', state: 'open', un: false, ready: false,
  // A login, or the literal '__me__' — resolved late so it survives a change of gh account.
  assignee: null,
};

/*
 * Search is a layer over the filter, not a replacement for it. When it has hits they
 * constrain and reorder the list; when it does not, the plain substring filter still runs,
 * so typing never leaves you looking at nothing while a request is in flight.
 */
const SEARCH = { q: '', hits: null, mode: null, error: null, busy: false, seq: 0 };
let DEPS = null;              // dependency structure, refreshed with the issue list
let CHECKED = new Set();      // files ticked for the next commit
const COMMIT_DRAFT = { subject: '', body: '' };

/*
 * Conflict state, held here rather than fetched per render.
 *
 * The Conflicts view redraws on every decision, and re-fetching inside the renderer would
 * mean a request per repaint and a visible flash on each one. So the loaders own the network
 * and the renderers are pure functions of these three values.
 */
let CONFLICTS = null;         // /api/git/conflicts — the file list and the operation
let CONFLICT_DETAIL = null;   // /api/git/conflict?file= — the selected file, parsed
let conflictsLoading = false;
let conflictDetailFor = null; // { file, promise } while a detail fetch is in flight
/*
 * Why a failure is remembered rather than just reported.
 *
 * The renderers fetch when they find nothing cached, and re-render when the fetch lands. If a
 * fetch that FAILS leaves the cache empty, that pair is an infinite loop — render, fetch,
 * fail, render — hammering the server for as long as the view is open. Holding the error
 * turns the retry into a button.
 */
let conflictsError = null;
let conflictDetailError = null;
const CONFLICT_AI = new Map();   // "path index" -> the model's suggestion for that conflict
let conflictAiBusy = false;
let CONFLICT_JOB = null;
let conflictRaw = false;         // hand-editing the whole file
let conflictRawDraft = '';
let CONFLICT_HAND = new Set();   // conflicts whose per-hunk editor is open
const CONFLICT_IMAGES = new Map(); // path -> the three rendered versions, or { error }
let conflictImagesFor = null;      // path whose images are in flight

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
  if (!res.ok) {
    const err = new Error(data && data.error ? data.error : 'HTTP ' + res.status);
    // Some failures ship the way out of themselves (lib/git.js RecoverableError). Carry it
    // through rather than flattening the response to its message — a toast that says "you
    // have uncommitted changes" and a panel that offers to stash them are different products.
    if (data && data.recovery) err.recovery = data.recovery;
    throw err;
  }
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
  } catch (e) {
    if (e.recovery) showRecovery(e.message, e.recovery); else toast(e.message, 'bad');
    throw e;
  }
  finally { busy(false); }
}

/*
 * A failure with a way out gets a panel rather than a toast, for two reasons: a toast
 * disappears while you are still reading the second of three steps, and a toast cannot hold
 * the button that performs them.
 */
function showRecovery(message, recovery) {
  const old = document.querySelector('.recovery'); if (old) old.remove();
  const box = h('div', { class: 'recovery', role: 'alertdialog', 'aria-label': recovery.title || 'Recovery' },
    h('div', { class: 'h' },
      h('span', { class: 'lab' }, recovery.title || 'What to do'),
      h('button', { class: 'btn sm', onclick: () => box.remove() }, '✕')),
    h('div', { class: 'why' }, message),
    h('ol', { class: 'steps' }, ...(recovery.steps || []).map(step => h('li', {}, step))),
    recovery.note ? h('div', { class: 'lab note' }, recovery.note) : null);

  if (recovery.action) {
    const run = h('button', { class: 'btn primary' }, recovery.title);
    run.addEventListener('click', async () => {
      run.disabled = true; run.textContent = 'working…';
      try {
        const endpoint = recovery.action === 'merge-abort' ? '/api/git/merge-abort' : '/api/git/recover';
        const r = await api(endpoint, { action: recovery.action });
        toast(r.message, r.ok === false ? 'bad' : 'good');
        if (r.detail) console.info(r.detail);
        box.remove();
        await load();
      } catch (e) {
        toast(e.message, 'bad');
        run.disabled = false; run.textContent = recovery.title;
      }
    });
    box.append(h('div', { class: 'acts' }, run));
  }
  document.body.append(box);
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
  SEL = { issue: null, file: null, commit: null, pr: null, conflict: null };
  CHECKED.clear(); COMMIT_DRAFT.subject = ''; COMMIT_DRAFT.body = '';
  CONFLICTS = null; CONFLICT_DETAIL = null; CONFLICT_AI.clear(); CONFLICT_HAND.clear();
  conflictRaw = false; conflictRawDraft = ''; conflictAiBusy = false; CONFLICT_JOB = null;
  conflictsError = null; conflictDetailError = null; conflictDetailFor = null;
  CONFLICT_IMAGES.clear(); conflictImagesFor = null;
  PRS = []; prLoaded = false;
  PROPOSALS = []; SUGGESTIONS = []; MILESTONES = []; NEW_LABELS = []; DUPES = [];
  PICKED = new Set(); lastPicked = null; DEPS = null;
  SEARCH.q = ''; SEARCH.hits = null; SEARCH.mode = null; SEARCH.error = null; SEARCH.busy = false;
  commitSummaryBusy = false; commitSummarySeq++;
  showHandledGaps = false; showHiddenPlan = false;
  showDonePhases = false; showRefusedDeps = false;
  // A conversation is about one repository — its answers would be wrong beside another.
  CHAT = []; CHAT_TRACE = new Map(); CHAT_PROPOSALS = []; chatDraft = '';
  planChoice = false; planBannerOff = false;
  // A milestone or label from the previous repository is not a scope in this one; carrying
  // it over would reject the next plan request as an unknown milestone.
  planScope = { milestone: null, label: null };
  FILTER.label = null;
  FILTER.assignee = null;
  // A draft belongs to the tracker it was written for, and its milestone, labels and
  // assignees would all be wrong in the next one. The templates likewise come from a
  // particular working tree.
  issueDraft = null;
  TEMPLATES = null; templatesFor = null;
  HISTORY_MODE = 'commits';
  digestOff = false;
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

/*
 * How old the issue list is, said plainly rather than as a clock time.
 *
 * "issues 14:32" is a fact you have to do arithmetic on, and the arithmetic is easy to skip —
 * so a list pulled yesterday read exactly like one pulled a minute ago, and every view in
 * the app rests on it being current. Past the threshold it says the age instead and turns
 * warn-coloured, because at that point the number IS the news.
 */
const STALE_AFTER_MIN = 90;

function stampNow() {
  const el = $('stamp');
  if (!el) return;
  if (!S || !S.issuesAt) { el.textContent = ''; el.className = 'lab'; el.title = ''; return; }
  const mins = Math.max(0, Math.round((Date.now() - new Date(S.issuesAt)) / 60000));
  const stale = mins >= STALE_AFTER_MIN;
  const clock = new Date(S.issuesAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.textContent = stale ? 'issues ' + ago(S.issuesAt) : 'issues ' + clock;
  el.className = 'lab' + (stale ? ' stale' : '');
  el.title = stale
    ? 'The issue list was pulled at ' + clock + '. Everything in the Issues and Plan views is ' +
      'that old, including what looks closed and what looks ready. Pull issues to refresh it.'
    : 'Issue list pulled at ' + clock;
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
  /*
   * Conflicts is the only nav entry that comes and goes. It has no meaning outside a
   * half-finished merge, and a permanent "Conflicts 0" would be one more thing to read past
   * on every other day of the year. When it appears it takes precedence over everything.
   */
  const conflicted = (S.git && S.git.status.conflicted) || 0;
  const mergingNow = !!(S.git && S.git.merge && S.git.merge.inProgress);
  const cbtn = $('nav-conflicts');
  if (cbtn) {
    const show = conflicted > 0 || mergingNow;
    cbtn.hidden = !show;
    $('c-conflicts').textContent = conflicted || (mergingNow ? '✓' : '0');
    $('c-conflicts').classList.toggle('hot', conflicted > 0);
    // Nothing to resolve any more, but the view is open: fall back rather than stranding
    // the user on a pane that can only say "nothing here".
    if (!show && VIEW === 'conflicts') { VIEW = 'changes'; SEL.conflict = null; }
  }
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
  if (VIEW === 'conflicts') return sideConflicts(body, foot);
  if (VIEW === 'history') return sideHistory(body, foot);
  if (VIEW === 'prs') return sidePrs(body, foot);
  if (VIEW === 'staged') return sideStaged(body, foot);
}

/* Who this machine's gh is signed in as. Everything "mine" hangs off this one value, and it
   can legitimately be absent — an unauthenticated gh still reads a public tracker. */
const myLogin = () => (S && S.github && S.github.login) || (S && S.auth && S.auth.login) || null;

function assignedToMe(issue) {
  const me = myLogin();
  return !!me && (issue.a || []).some(a => a.toLowerCase() === me.toLowerCase());
}

/*
 * Is somebody waiting on ME?
 *
 * The signal is SOMETHING WAS SAID that you may not have seen — never assignment on its own.
 * That distinction is the whole difference between a useful marker and a decoration: on a
 * solo tracker, or any repository with one maintainer, you are assigned to everything, so a
 * flag that fires on assignment fires on every row and stops carrying information. Measured
 * on a real 55-issue tracker where it lit up all 55.
 *
 * So both cases require a comment by someone else: a reply after you last spoke, or
 * discussion on an issue that is yours. GitHub answers this with a notifications inbox this
 * app has no access to, so it is reconstructed from comment authors — and only from the
 * comments a pull kept, which is why it says "worth a look" and never "unread".
 */
function needsMe(issue) {
  const me = myLogin();
  if (!me || issue.st !== 'OPEN') return null;
  const low = me.toLowerCase();
  const thread = issue.cm || [];
  if (!thread.length) return null;
  const authors = thread.map(c => String(c.who || '').toLowerCase());
  const mineIdx = authors.lastIndexOf(low);
  if (mineIdx >= 0) {
    const after = thread.length - 1 - mineIdx;
    // Replies after your own last word, by anybody but you.
    const others = authors.slice(mineIdx + 1).filter(a => a !== low).length;
    if (after > 0 && others > 0) {
      return others === 1 ? 'someone replied after your comment' : others + ' replies since your comment';
    }
    return null;
  }
  if (!assignedToMe(issue)) return null;
  const others = authors.filter(a => a !== low).length;
  return others ? 'assigned to you, ' + others + ' comment' + (others === 1 ? '' : 's') + ' you have not answered' : null;
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
    /* "__me__" resolves at filter time rather than being stored as a login, so the filter
       keeps meaning the right thing if the machine's gh account changes under it. */
    if (FILTER.assignee === '__me__' && !assignedToMe(i)) return false;
    if (FILTER.assignee && FILTER.assignee !== '__me__' && !i.a.includes(FILTER.assignee)) return false;
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

/*
 * Pull, file, push — the three issue actions, wherever issues are being worked on.
 *
 * These used to belong to the Issues view alone, which was wrong the moment the Plan view
 * grew buttons that stage things. Reading the plan is where you decide what is finished, so
 * it is where closes get staged — and then the only way to apply them was to leave for
 * another view, whose sidebar looks nothing like the one you were reading. Same three
 * buttons, one definition, so the two can never drift apart.
 *
 * `+ New issue` sets the view as well as the selection: from the Plan view, selecting the
 * draft without switching would leave you looking at the plan wondering what the button did.
 */
function issueActions(foot) {
  const staged = S.queue.length;
  foot.append(h('div', { style: { display: 'flex', gap: '7px' } },
    h('button', {
      class: 'btn wide', disabled: pulling || !S.selected.github,
      title: 'Re-read every issue, milestone and label from GitHub. Nothing staged is lost.',
      onclick: () => pullIssues(),
    }, pulling ? 'Pulling…' : 'Pull issues'),
    h('button', {
      class: 'btn primary wide', title: 'Draft a new issue. It is staged, not filed.',
      onclick: () => { VIEW = 'issues'; SEL.issue = 'new'; render(); },
    }, '+ New issue')));
  foot.append(h('button', {
    class: 'btn wide' + (staged ? ' primary' : ''), disabled: !staged,
    title: staged
      ? 'Apply every staged issue change to GitHub. Review them in the Staged view first.'
      : 'Nothing is waiting to be pushed.',
    onclick: () => act(() => api('/api/queue/push', {}), 'queue'),
  }, staged
      ? (S.dryRun ? 'Dry-run push ' : 'Push ') + staged + ' issue change' + (staged === 1 ? '' : 's')
      : 'No issue changes staged'));
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
      /*
       * Who it belongs to. On any repository with more than one person this is the most-used
       * filter on github.com, and the app had only an Unassigned toggle — so "what is on my
       * plate" was the one question the issue list could not answer.
       *
       * Built from assignees actually present on the loaded issues, for the same reason the
       * label dropdown is: a repository can have far more collaborators than contributors,
       * and forty names that select nothing is worse than no dropdown.
       */
      (() => {
        const me = myLogin();
        const used = new Map();
        S.issues.forEach(i => i.a.forEach(a => used.set(a, (used.get(a) || 0) + 1)));
        const names = [...used.keys()].sort((a, b) => a.localeCompare(b));
        if (!names.length) return null;
        const sel = h('select', { title: 'Filter by assignee', style: { flex: '1 1 100%' } },
          h('option', { value: '', selected: !FILTER.assignee }, 'Anyone assigned'),
          me && used.has(me)
            ? h('option', { value: '__me__', selected: FILTER.assignee === '__me__' },
              'Assigned to me  (' + used.get(me) + ')')
            : null,
          ...names.map(n => h('option', {
            value: n, selected: FILTER.assignee === n,
          }, n + '  (' + used.get(n) + ')')));
        sel.addEventListener('change', () => {
          FILTER.assignee = sel.value || null;
          // Two ways of saying "nobody" that contradict each other; the newer choice wins.
          if (FILTER.assignee) FILTER.un = false;
          renderSide();
        });
        return sel;
      })(),
      (() => {
        const b = h('button', { class: 'btn sm', 'aria-pressed': String(FILTER.un) }, 'Unassigned');
        b.addEventListener('click', () => {
          FILTER.un = !FILTER.un;
          if (FILTER.un) FILTER.assignee = null;
          b.setAttribute('aria-pressed', String(FILTER.un));
          renderSide();
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

  issueActions(foot);
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
        /* "Is anyone waiting on me" without reading every thread. Reconstructed from the
           comments the pull kept, so it can miss — never a claim, only a prompt to look. */
        (() => {
          const why = needsMe(i);
          return why
            ? h('span', { class: 'why-chip mine', title: 'Worth a look — ' + why }, '◆')
            : null;
        })(),
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
  // No plan yet is exactly when you are most likely to be pulling issues to build one from,
  // so the actions come before the early return rather than after it.
  if (!ins) {
    body.append(h('div', { class: 'empty' }, 'No plan is available for this repository.'));
    return issueActions(foot);
  }
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
  put(body, milestoneEditor());
  // The plan view stages closes as you read it, so it gets the same three buttons the Issues
  // view has rather than sending you to another view to apply what you just decided.
  issueActions(foot);
  foot.append(h('span', { class: 'lab' }, ins.source));
}

/*
 * Editing the milestones the whole Plan view is built out of.
 *
 * Titles, descriptions and due dates decide the phase bands, the ordering, and what the
 * model is told each milestone is FOR — and every one of them was previously editable only
 * on github.com. You could create a milestone here and then never correct it, which is the
 * wrong half of the operation to support.
 *
 * It lives in the Plan sidebar rather than in a settings screen because that is where the
 * consequences are visible: change a due date and the band it drives is on the same page.
 * Staged like everything else, so a rename can be reviewed and dropped before it lands.
 */
function milestoneEditor() {
  const all = (S.github && S.github.milestones) || [];
  if (!all.length) return null;
  const counts = new Map();
  (S.issues || []).forEach(i => { if (i.ms) counts.set(i.ms, (counts.get(i.ms) || 0) + 1); });

  const box = h('div', { style: { padding: '11px', borderTop: '1px solid var(--line-soft)' } },
    h('span', { class: 'lab' }, 'Edit milestones'),
    h('div', { class: 'lab', style: { marginBottom: '7px', textTransform: 'none', letterSpacing: '0' } },
      'Staged like any other change — nothing moves until you push.'));

  all.forEach(m => {
    const staged = (S.queue || []).some(c => c.kind === 'milestoneEdit' && c.payload.number === m.number);
    box.append(h('button', {
      class: 'btn wide', disabled: staged,
      style: { justifyContent: 'flex-start', marginBottom: '3px' },
      title: staged ? 'An edit to this milestone is already staged'
        : [m.description || 'No description.',
          m.dueOn ? 'Due ' + String(m.dueOn).slice(0, 10) : 'No due date.',
          (counts.get(m.title) || 0) + ' issues'].join('\n'),
      onclick: (e) => openMilestoneEditor(e.currentTarget, m),
    }, (m.state === 'closed' ? '✓ ' : '') + m.title +
      (m.dueOn ? '  · ' + String(m.dueOn).slice(0, 10) : '')));
  });
  return box;
}

function openMilestoneEditor(btn, m) {
  popover(btn, 'Milestone: ' + m.title, (body) => {
    const title = h('input', { type: 'text', value: m.title });
    const desc = h('textarea', { style: { minHeight: '80px' } });
    desc.value = m.description || '';
    const due = h('input', { type: 'date', value: m.dueOn ? String(m.dueOn).slice(0, 10) : '' });
    const closed = m.state === 'closed';

    const send = (extra) => {
      closePop();
      stage('milestoneEdit', Object.assign({ number: m.number }, extra));
    };

    body.append(
      h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Title'), title),
      h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Description'), desc,
        h('span', { class: 'lab', style: { textTransform: 'none', letterSpacing: '0' } },
          'The plan generator reads this to decide what belongs here, so say what "done" means.')),
      h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Due date'), due),
      h('div', { class: 'acts' },
        h('button', {
          class: 'btn sm primary',
          onclick: () => {
            const patch = {};
            if (title.value.trim() && title.value.trim() !== m.title) patch.title = title.value.trim();
            if (desc.value !== (m.description || '')) patch.description = desc.value;
            const d = due.value || null;
            const was = m.dueOn ? String(m.dueOn).slice(0, 10) : null;
            // undefined means "leave it"; null means "clear it". They are different edits.
            if (d !== was) patch.dueOn = d;
            if (!Object.keys(patch).length) { closePop(); return toast('Nothing changed', ''); }
            send(patch);
          },
        }, 'Stage changes'),
        h('button', {
          class: 'btn sm',
          title: closed
            ? 'Reopen it. A closed milestone is folded out of the plan header.'
            : 'Close the milestone itself. This does NOT close its issues.',
          onclick: () => send({ state: closed ? 'open' : 'closed' }),
        }, closed ? 'Stage reopen' : 'Stage close'),
        h('button', { class: 'btn sm', onclick: () => closePop() }, 'Cancel')));
  });
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
  // A half-finished merge outranks everything else in this panel: until it is resolved or
  // aborted, committing anything else is not a thing the user can meaningfully do.
  put(body, mergeBanner());
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

/*
 * A repository has two histories and they answer different questions.
 *
 * The commit log says what the CODE did. It is the only history most Git clients show, and on
 * its own it cannot tell you when a piece of work was agreed, argued about, or abandoned —
 * a decision taken in an issue thread and never written into a commit message leaves no trace
 * in it at all. The tracker holds that half: when each issue was filed, when it was closed,
 * and every comment in between.
 *
 * Both are already in memory — the log from git, the issue timeline from the pull — so this
 * is a switch between two readings of what is there, not a second fetch.
 */
let HISTORY_MODE = 'commits';

function setHistoryMode(mode) {
  if (HISTORY_MODE === mode) return;
  HISTORY_MODE = mode;
  // A commit selected under one reading has no meaning under the other, and leaving it set
  // would open the issue timeline on a commit diff.
  SEL.commit = null;
  render();
}

function historySwitch() {
  const tab = (mode, label, hint) => h('button', {
    class: 'btn sm', 'aria-pressed': String(HISTORY_MODE === mode), title: hint,
    style: { flex: '1 1 0' },
    onclick: () => setHistoryMode(mode),
  }, label);
  return h('div', {
    style: { display: 'flex', gap: '6px', padding: '10px 11px', borderBottom: '1px solid var(--line-soft)' },
  },
    tab('commits', 'Commits', 'What the code did: commits on this branch, newest first, each with its full diff.'),
    tab('issues', 'Issue activity', 'What the tracker did: every issue opened, closed and commented on, newest first. Read from the last pull, so it is as current as your issue list.'));
}

/*
 * The tracker's timeline, assembled from what a pull already stores.
 *
 * Three event kinds, because three are what the cached fields can support honestly: an issue
 * was filed, an issue was closed, somebody said something. Label changes, reassignments and
 * reopens are real events too and are NOT here — they live only in GitHub's timeline API,
 * which a pull does not fetch, and inventing them from `updatedAt` would produce a history
 * that looks complete and is wrong.
 */
function issueEvents(limit = 400) {
  const out = [];
  for (const i of S.issues || []) {
    if (i.createdAt) out.push({ at: i.createdAt, kind: 'opened', n: i.n, t: i.t, who: null });
    if (i.closedAt) out.push({ at: i.closedAt, kind: 'closed', n: i.n, t: i.t, who: null });
    for (const c of i.cm || []) {
      if (c.at) out.push({ at: c.at, kind: 'commented', n: i.n, t: i.t, who: c.who, body: c.body });
    }
  }
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { events: out.slice(0, limit), total: out.length };
}

const EVENT_WORD = { opened: 'filed', closed: 'closed', commented: 'comment on' };

function sideHistory(body, foot) {
  body.append(historySwitch());

  if (HISTORY_MODE === 'issues') {
    if (!S.issuesLoaded) {
      body.append(h('div', { class: 'empty' }, 'Pull issues to see what the tracker has been doing.'));
      return foot.append(h('span', { class: 'lab' }, 'no issues loaded'));
    }
    const { events, total } = issueEvents();
    if (!events.length) {
      body.append(h('div', { class: 'empty' }, 'No issue activity recorded.'));
      return foot.append(h('span', { class: 'lab' }, '0 events'));
    }
    events.forEach(e => body.append(h('div', {
      class: 'irow', style: { gridTemplateColumns: '1fr' },
      title: e.kind === 'commented' && e.body ? e.body.slice(0, 300) : e.t,
      onclick: () => { VIEW = 'issues'; SEL.issue = e.n; render(); },
    },
      h('span', { class: 't' }, '#' + e.n + ' ' + e.t,
        h('span', { class: 'sub' },
          EVENT_WORD[e.kind] + (e.who ? ' by ' + e.who : '') + ' · ' + ago(e.at))))));
    // Say what is not shown. A truncated list that looks whole is the one failure a history
    // view cannot recover from.
    foot.append(h('span', { class: 'lab' },
      events.length < total
        ? 'newest ' + events.length + ' of ' + total + ' events'
        : total + ' events'));
    return;
  }

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
  // Nothing that talks to GitHub works without a usable gh, so this outranks every view.
  put(p, ghHealthBanner());
  if (S.githubError && (VIEW === 'issues' || VIEW === 'plan')) {
    p.append(h('div', { class: 'banner' }, h('b', {}, 'GitHub unavailable. '), S.githubError));
  }
  if (VIEW === 'issues' || VIEW === 'plan') put(p, digestBanner());
  if (S.truncated) {
    p.append(h('div', { class: 'banner warn' }, h('b', {}, 'Issue list truncated. '),
      'This repo has more issues than the fetch limit, so counts below are partial.'));
  }
  if (VIEW === 'issues') return paneIssue(p);
  if (VIEW === 'plan') return panePlan(p);
  if (VIEW === 'changes') return paneDiff(p);
  if (VIEW === 'conflicts') return paneConflicts(p);
  if (VIEW === 'history') return paneHistory(p);
  if (VIEW === 'prs') return panePrs(p);
  if (VIEW === 'staged') return paneStaged(p);
}

/*
 * The GitHub CLI, before it is needed rather than after.
 *
 * A missing gh, a gh from before 2.54, and a gh nobody is signed in to are three different
 * problems with three different fixes, and all three used to arrive identically: as whatever
 * stderr said, in a toast, in the middle of an action the user had already committed to.
 * Somebody evaluating this app for the first time could not tell a broken install from a
 * broken app. Git itself keeps working throughout, which is worth saying out loud — half
 * the app is still usable.
 */
function ghHealthBanner() {
  const gh = S && S.ghHealth;
  if (!gh || !gh.problem) return null;
  return h('div', { class: 'banner warn' },
    h('b', {}, gh.installed ? 'The GitHub CLI is out of date. ' : 'The GitHub CLI is missing. '),
    gh.problem, ' ',
    gh.fix ? h('b', {}, gh.fix) : null,
    h('br'),
    h('span', { class: 'lab' },
      'The Changes, History and Conflicts views work without it — they are Git, not GitHub.'));
}

/*
 * What happened here while you were away.
 *
 * The tracker moves whether or not you are looking at it, and until now nothing said so: you
 * pulled, and a list that had changed under you looked exactly like one that had not. This
 * is the same reasoning the Plan view already does about its own staleness, pointed at the
 * issue list — and it is deliberately counts and a jump, not a feed, because the History
 * view's issue timeline is the feed and duplicating it here would be two of the same thing.
 *
 * Your own actions are excluded server-side. Being told about the issue you closed two
 * minutes ago is noise, and noise is how a surface like this gets ignored permanently.
 */
let digestOff = false;

function digestBanner() {
  const d = S && S.digest;
  if (digestOff || !d || !d.total) return null;
  const bits = [];
  if (d.filed.length) bits.push(d.filed.length + ' filed');
  if (d.closed.length) bits.push(d.closed.length + ' closed');
  if (d.commented.length) bits.push('comments on ' + d.commented.length);
  const box = h('div', { class: 'banner' },
    h('b', {}, 'Since you last caught up: '), bits.join(', '), '. ',
    d.mine.length
      ? h('b', {}, d.mine.length === 1
        ? '1 of them is on an issue you are part of. '
        : d.mine.length + ' are on issues you are part of. ')
      : null,
    h('span', { class: 'lab' }, 'as of your last pull, ' + (S.issuesAt ? ago(S.issuesAt) : 'unknown')));
  const acts = h('div', { class: 'acts', style: { marginTop: '7px' } });
  acts.append(h('button', {
    class: 'btn sm', title: 'Open the issue timeline in the History view',
    onclick: () => { VIEW = 'history'; setHistoryMode('issues'); },
  }, 'See what changed'));
  if (d.mine.length) {
    acts.append(h('button', {
      class: 'btn sm', title: 'Show only the issues you are assigned to or have commented on',
      onclick: () => { VIEW = 'issues'; SEL.issue = d.mine[0]; render(); },
    }, 'Open #' + d.mine[0]));
  }
  acts.append(h('button', {
    class: 'btn sm primary',
    title: 'Mark everything up to now as read. Nothing is changed on GitHub.',
    onclick: async () => {
      try {
        const r = await api('/api/issues/seen', {});
        S.seenAt = r.seenAt; S.digest = r.digest;
        renderPane();
      } catch (e) { toast(e.message, 'bad'); }
    },
  }, 'Mark as caught up'));
  acts.append(h('button', {
    class: 'btn sm', title: 'Hide this until the next time the page loads',
    onclick: () => { digestOff = true; renderPane(); },
  }, 'Not now'));
  box.append(acts);
  return box;
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

  wrap.append(h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Body'),
    h('div', { class: 'body-md' }, i.body || '(empty)')));

  // put(), not append(): the thread declines to build anything when there is no discussion.
  put(wrap, commentThread(i));

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
    const field = h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Dependencies'));
    // The graph goes first: direction of flow is the thing a list of buttons cannot show,
    // and it is the only question this section exists to answer — what has to happen before
    // this, and what is stuck behind it.
    const graph = depGraph(i.n, waiting, waiters);
    if (graph) field.append(graph);
    field.append(...rows);
    wrap.append(field);
  }

  /*
   * Related issues — dependencies AND similarity in one list.
   *
   * These were two sections that never spoke: an issue could be listed as a blocker above
   * and appear again below at 0.71 similarity, with nothing saying they were the same issue.
   * Dependency edges are facts and go first; similarity is a guess and follows, with the
   * ones already shown as edges suppressed rather than repeated.
   */
  const relatedBox = h('div', { class: 'field' },
    h('span', { class: 'lab' }, 'Related issues'),
    h('div', { class: 'lab', id: 'related-note' }, 'looking…'));
  wrap.append(relatedBox);
  p.append(wrap);
  loadRelated(i.n, relatedBox);
}

/*
 * The discussion, which used to be a number.
 *
 * The detail view showed a body and a comment count, and the count is the least useful part
 * of a thread: an issue whose body describes one plan and whose comments abandoned it reads
 * as current, and every decision taken after filing was invisible without opening github.com.
 * That is the context this view was missing — most of these threads are one reply long and
 * that one reply is usually the whole answer.
 *
 * Bodies are inserted as TEXT, never markup. These are other people's words arriving through
 * an API, held to the same rule as the issue body above them.
 */
function commentThread(i) {
  const thread = Array.isArray(i.cm) ? i.cm : null;
  const total = Number(i.comments) || 0;
  // Staged comments have not been pushed, so they belong to the thread visually but must never
  // be mistaken for something the other person can already see.
  const pending = (S.queue || []).filter(c => c.kind === 'comment' && c.payload &&
    c.payload.number === i.n && c.payload.body);
  if (!total && !pending.length) return null;

  const field = h('div', { class: 'field' },
    h('span', { class: 'lab' },
      'Comments' + (total ? ' (' + total + ')' : '')));

  /* An issue cached before comments were kept has a count and no thread. Saying which is
     honest; rendering an empty thread would claim the discussion was empty. */
  if (thread == null) {
    field.append(h('div', { class: 'lab' },
      'Pull issues to load ' + (total === 1 ? 'the comment' : 'these ' + total + ' comments') + '.'));
  } else {
    if (total > thread.length) {
      field.append(h('div', { class: 'lab' },
        'showing the ' + thread.length + ' most recent · ' +
        (total - thread.length) + ' older on GitHub'));
    }
    const box = h('div', { class: 'comments' });
    thread.forEach(c => box.append(h('div', { class: 'cmt' },
      h('div', { class: 'cmt-h' },
        h('span', { class: 'who' }, c.who ? '@' + c.who : 'unknown'),
        c.at ? h('span', { class: 'lab', title: c.at }, ago(c.at)) : null,
        c.url ? h('a', {
          class: 'lab', href: c.url, target: '_blank', rel: 'noreferrer noopener',
          title: 'Open this comment on GitHub',
        }, '↗') : null),
      h('div', { class: 'body-md' }, c.body || '(empty)'))));
    field.append(box);
  }

  pending.forEach(c => field.append(h('div', { class: 'cmt pending' },
    h('div', { class: 'cmt-h' },
      h('span', { class: 'who' }, 'you'),
      h('span', { class: 'chip' }, 'staged — not pushed yet')),
    h('div', { class: 'body-md' }, c.payload.body))));
  return field;
}

function relHit(number, title, state, extra) {
  return h('div', {
    class: 'relhit' + (state === 'OPEN' ? '' : ' closed'),
    onclick: () => { SEL.issue = number; render(); },
  },
    h('span', { class: 'n' }, '#' + number),
    h('span', { class: 't' }, title),
    extra);
}

async function loadRelated(number, box) {
  const issue = S.issues.find(x => x.n === number) || {};
  // Dependency edges are known locally and cost nothing, so they render immediately rather
  // than waiting on the similarity round trip — and they are shown even when there is no
  // embedding index at all, which is when this section used to be empty.
  const waiting = (issue.bk || []).filter(n => S.issues.some(x => x.n === n && x.st === 'OPEN'));
  const waiters = (DEPS && (DEPS.unblocks.find(u => u.number === number) || {}).waiters) || [];
  const edges = new Map();
  waiting.forEach(n => edges.set(n, 'blocks this'));
  waiters.forEach(n => { if (!edges.has(n)) edges.set(n, 'waiting on this'); });

  const note = box.querySelector('#related-note');
  if (edges.size) {
    if (note) note.remove();
    for (const [n, why] of edges) {
      const other = S.issues.find(x => x.n === n);
      box.append(relHit(n, other ? other.t : '(not in the pulled list)', other && other.st,
        h('span', { class: 'why-chip dep', title: 'from the issue body' }, why)));
    }
  }

  try {
    const r = await api('/api/issues/related?number=' + encodeURIComponent(number));
    if (SEL.issue !== number) return;              // the user moved on while we asked
    const live = box.querySelector('#related-note');
    // An issue already shown as an edge is not shown again as a similarity hit; a known
    // relationship beats a guessed one, and the duplicate row reads as two different issues.
    const fresh = r.related.filter(rel => !edges.has(rel.number));
    if (!fresh.length) {
      if (live) live.textContent = edges.size ? '' : 'nothing similar in this tracker';
      if (live && edges.size) live.remove();
      return;
    }
    if (live) live.remove();
    fresh.forEach(rel => box.append(relHit(rel.number, rel.title, rel.state, simChip(rel.score))));
  } catch {
    const live = box.querySelector('#related-note');
    if (live) live.textContent = 'similarity needs an embedding model and a built index';
  }
}

/*
 * The whole tracker's dependency structure, for the Plan view.
 *
 * depGraph() below answers "what surrounds THIS issue" and is the right shape for the issue
 * detail pane. This answers a different question — "what is the shape of the work" — and so
 * needs a different picture: every blocking relationship at once, laid out in layers so that
 * depth down the page means "cannot start until the things above it are done".
 *
 * Only issues that participate in an edge are drawn. A tracker with sixty issues and three
 * dependencies would otherwise render fifty-seven disconnected boxes, which is a great deal
 * of ink spent obscuring the three edges that matter.
 */
function trackerGraph(open) {
  if (!DEPS) return null;
  const openNums = new Set(open.map(i => i.n));
  /* blocker → [blocked]. DEPS.blocked already filtered to edges between OPEN issues. */
  const edges = [];
  for (const row of DEPS.blocked || []) {
    if (!openNums.has(row.number)) continue;
    for (const dep of row.waitingOn || []) {
      if (openNums.has(dep)) edges.push([dep, row.number]);
    }
  }
  if (!edges.length) return null;

  const nodes = new Set(edges.flat());
  const blockedBy = new Map([...nodes].map(n => [n, []]));
  edges.forEach(([from, to]) => blockedBy.get(to).push(from));

  /*
   * Depth is the longest chain of blockers above a node. Iterated to a fixed point rather
   * than recursed, because issue bodies can and do describe cycles ("blocked by #4" on #4's
   * own blocker), and a cycle must produce a slightly wrong picture rather than a stack
   * overflow. The bound is the node count, past which no honest depth can still be growing.
   */
  const depth = new Map([...nodes].map(n => [n, 0]));
  for (let pass = 0; pass < nodes.size; pass++) {
    let moved = false;
    for (const n of nodes) {
      const want = blockedBy.get(n).reduce((mx, b) => Math.max(mx, depth.get(b) + 1), 0);
      if (want > depth.get(n)) { depth.set(n, want); moved = true; }
    }
    if (!moved) break;
  }

  const layers = [];
  for (const n of [...nodes].sort((a, b) => a - b)) {
    const d = depth.get(n);
    (layers[d] = layers[d] || []).push(n);
  }

  const NW = 104, NH = 30, GAP = 10, ROW = 74;
  const PER_ROW = 8;                       // past this a row stops being readable at any width
  const trimmed = layers.map(row => row.slice(0, PER_ROW));
  const dropped = layers.reduce((sum, row) => sum + Math.max(0, row.length - PER_ROW), 0);
  const rowW = (n) => n * NW + (n - 1) * GAP;
  const width = Math.max(...trimmed.map(row => rowW(row.length))) + 24;
  const height = trimmed.length * NH + (trimmed.length - 1) * (ROW - NH) + 20;

  const root = svg('svg', {
    class: 'depgraph tracker', viewBox: `0 0 ${width} ${height}`, width: '100%', height,
    role: 'img',
    'aria-label': `${nodes.size} issues in ${trimmed.length} dependency layers; ` +
      `${(DEPS.ready || []).length} can be started now`,
  });
  root.append(svg('defs', {}, svg('marker', {
    id: 'tdep-arrow', viewBox: '0 0 8 8', refX: 7, refY: 4,
    markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
  }, svg('path', { d: 'M0,0 L8,4 L0,8 z', fill: 'var(--fg-dim)' }))));

  const at = new Map();
  trimmed.forEach((row, d) => row.forEach((n, k) => at.set(n, {
    x: (width - rowW(row.length)) / 2 + k * (NW + GAP),
    y: 10 + d * ROW,
  })));

  // Edges first, so nodes paint over their endpoints.
  for (const [from, to] of edges) {
    const a = at.get(from), b = at.get(to);
    if (!a || !b) continue;                // one end was trimmed out of its row
    root.append(svg('line', {
      x1: a.x + NW / 2, y1: a.y + NH, x2: b.x + NW / 2, y2: b.y,
      stroke: 'var(--line)', 'stroke-width': 1.5, 'marker-end': 'url(#tdep-arrow)',
    }));
  }

  const unblocks = new Map((DEPS.unblocks || []).map(u => [u.number, u.waiters.length]));
  for (const [n, pos] of at) {
    const issue = open.find(i => i.n === n);
    const title = issue ? issue.t : '';
    const frees = unblocks.get(n) || 0;
    const ready = (DEPS.ready || []).includes(n);
    const g = svg('g', {
      class: 'depnode ' + (ready ? 'up' : 'down'), tabindex: 0, role: 'button',
      'aria-label': `#${n} ${title}. ${ready ? 'Can be started now' : 'Blocked'}` +
        (frees ? `, unblocks ${frees} issue${frees === 1 ? '' : 's'}` : ''),
      onclick: () => { VIEW = 'issues'; SEL.issue = n; render(); },
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); VIEW = 'issues'; SEL.issue = n; render(); }
      },
    });
    g.append(svg('title', {}, `#${n} ${title}` +
      (frees ? ` — finishing this unblocks ${frees}` : '') + (ready ? '' : ' — blocked')));
    g.append(svg('rect', { x: pos.x, y: pos.y, width: NW, height: NH, rx: 5 }));
    g.append(svg('text', { x: pos.x + 8, y: pos.y + 13, class: 'dn' },
      '#' + n + (frees ? `  ↓${frees}` : '')));
    g.append(svg('text', { x: pos.x + 8, y: pos.y + 24, class: 'dt' },
      title.length > 16 ? title.slice(0, 16) + '…' : title));
    root.append(g);
  }

  return h('div', { class: 'depwrap' }, root,
    h('div', { class: 'lab deplegend' },
      `${nodes.size} issues linked · top row can start now · ↓N is how many finishing it frees`,
      dropped ? ` · ${dropped} not drawn` : ''));
}

/*
 * The Plan's dependency section, including the case that matters most here: no edges at all.
 *
 * An empty graph and an absent feature look identical, and this tracker has zero dependency
 * edges — so saying nothing would read as "the graph is broken". Instead it says what the
 * structure is and how an edge comes to exist, because the edges are parsed out of issue
 * BODIES and nobody guesses that from a blank panel.
 */
function planDependencies(open) {
  const box = h('div', {});
  const graph = trackerGraph(open);
  const readyCount = DEPS ? (DEPS.ready || []).length : 0;
  const blockedCount = DEPS ? (DEPS.blocked || []).length : 0;

  box.append(h('div', { class: 'sec-head' },
    h('h2', {}, 'What is blocked'),
    DEPS && blockedCount
      ? h('button', {
        class: 'btn sm', title: 'Show only issues nothing is blocking',
        onclick: () => { VIEW = 'issues'; FILTER.ready = true; render(); },
      }, `Show the ${readyCount} ready`)
      : null));

  if (!DEPS) {
    box.append(h('p', { class: 'deps-note' }, 'Loading dependency structure…'));
    // DEPS is normally fetched alongside the issue list; if the Plan was opened first, ask
    // for it now and redraw rather than leaving a permanent "loading".
    loadDeps().then(() => { if (VIEW === 'plan') renderPane(); });
    return box;
  }

  if (!graph) {
    box.append(h('p', { class: 'deps-note' },
      `No issue in this tracker declares a dependency, so all ${readyCount} open issues can be `,
      'started in any order and there is nothing to draw.',
      h('br'),
      'Dependencies are read out of issue bodies. Write ',
      h('code', {}, 'blocked by #12'), ', ', h('code', {}, 'depends on #4'), ' or ',
      h('code', {}, 'needs #7'), ' in a body and the graph appears here, the ',
      h('b', {}, 'Ready'), ' filter starts excluding blocked work, and the assistant stops ',
      'recommending an order that ignores it.'));
    return box;
  }

  box.append(h('p', { class: 'deps-note' },
    `${readyCount} issue${readyCount === 1 ? '' : 's'} can be started now; `,
    `${blockedCount} ${blockedCount === 1 ? 'is' : 'are'} waiting on other open work. `,
    'Arrows point from a blocker to what it blocks.'));
  box.append(graph);
  box.append(planDepProposals());
  return box;
}

/*
 * Edges the plan proposed but nobody has accepted yet. They are NOT drawn in the graph above:
 * the graph is what the tracker says, and mixing a suggestion into it would make a guess
 * indistinguishable from a recorded fact at a glance.
 */
function planDepProposals() {
  const proposed = (S.insights && S.insights.deps) || [];
  const refusedCount = planMutes().deps.length;
  if (!proposed.length && !refusedCount) return null;
  const live = proposed.filter(d => !d.muted);
  const refused = proposed.filter(d => d.muted);
  const outstanding = live.filter(d => {
    const issue = S.issues.find(i => i.n === d.blocked);
    if (issue && issue.st !== 'OPEN') return false;
    const already = new Set((issue && issue.bk) || []);
    const no = new Set(d.mutedBy || []);
    // Same test depCard() applies, so the heading count and the cards below it agree about
    // how much is actually left to decide.
    return d.blockedBy.some(n => !already.has(n) && !no.has(n) && depOpen(n));
  });
  const wrap = h('div', { class: 'depprops' });
  wrap.append(h('div', { class: 'sec-head', style: { marginTop: '4px' } },
    h('h3', {}, outstanding.length
      ? `${outstanding.length} dependenc${outstanding.length === 1 ? 'y' : 'ies'} the plan noticed`
      : 'Proposed dependencies'),
    outstanding.length
      ? h('span', { class: 'lab' }, 'staging one edits the blocked issue’s body · refusing one stages nothing')
      : h('span', { class: 'lab' }, live.length ? 'all recorded' : 'none outstanding')));
  live.forEach(d => wrap.append(depCard(d)));

  /*
   * Refused edges are kept reachable rather than deleted. A refusal is a judgement made in a
   * second, and the way to trust it is to be able to see what it was and take it back — not
   * to have the evidence disappear.
   */
  if (refusedCount) {
    wrap.append(h('div', { class: 'acts', style: { marginTop: '8px' } },
      h('span', { class: 'lab' }, refusedCount + ' refused'),
      h('button', {
        class: 'btn sm', onclick: () => { showRefusedDeps = !showRefusedDeps; renderPane(); },
      }, showRefusedDeps ? 'Hide refused' : 'Show refused'),
      showRefusedDeps
        ? h('button', {
          class: 'btn sm', title: 'Allow every refused edge to be proposed again',
          onclick: () => planUnmuteAll('deps'),
        }, 'Restore all')
        : null));
    if (showRefusedDeps) {
      refused.forEach(d => wrap.append(depCard(d)));
      /* An edge refused against an issue that has since closed, or against a plan that no
         longer proposes it, has no card above. Listing the raw entries keeps them undoable. */
      const shown = new Set(proposed.flatMap(d => (d.mutedBy || []).map(n => 'dep:' + d.blocked + ':' + n)));
      const orphans = planMutes().deps.filter(entry => !shown.has(entry.key));
      orphans.forEach(entry => wrap.append(h('div', { class: 'ign' },
        h('span', { class: 't' }, entry.label || entry.key.replace(/^dep:(\d+):(\d+)$/, '#$1 ⇠ #$2')),
        h('button', {
          class: 'btn sm', onclick: () => planUnmute({ kind: 'deps', key: entry.key }),
        }, 'Restore'))));
    }
  }
  return wrap;
}

/*
 * A dependency graph, as an actual graph.
 *
 * Three bands: what must happen first on top, this issue in the middle, what is stuck behind
 * it underneath — with arrows pointing the way work flows. The direction is the entire point.
 * The same information as a row of buttons reads as "these issues are related somehow"; drawn
 * with edges it reads as "two things block this, and finishing it frees four others", which
 * is the sentence someone actually needs before choosing what to do next.
 *
 * Hand-built SVG because the project has no dependencies and is not about to gain a graph
 * library for eleven nodes.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...kids) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(9)) {
    if (kid == null || kid === false) continue;
    e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

function depGraph(center, upstream, downstream) {
  if (!upstream.length && !downstream.length) return null;
  const CAP = 6;                       // beyond this the picture stops being readable
  const up = upstream.slice(0, CAP);
  const down = downstream.slice(0, CAP);
  const NW = 108, NH = 30, GAP = 12;
  const rowW = (n) => n * NW + (n - 1) * GAP;
  const width = Math.max(rowW(Math.max(up.length, 1)), rowW(Math.max(down.length, 1)), NW) + 24;
  const rows = [up.length ? 1 : 0, 1, down.length ? 1 : 0].filter(Boolean).length;
  const height = rows * NH + (rows - 1) * 46 + 16;

  const root = svg('svg', {
    class: 'depgraph', viewBox: `0 0 ${width} ${height}`, width: '100%',
    height, role: 'img',
    'aria-label': `#${center} is blocked by ${up.length} issue(s) and blocks ${down.length} issue(s)`,
  });
  root.append(svg('defs', {}, svg('marker', {
    id: 'dep-arrow', viewBox: '0 0 8 8', refX: 7, refY: 4,
    markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
  }, svg('path', { d: 'M0,0 L8,4 L0,8 z', fill: 'var(--fg-dim)' }))));

  let y = 8;
  const bands = [];
  if (up.length) { bands.push({ list: up, y, role: 'up' }); y += NH + 46; }
  const centerY = y; y += NH + 46;
  const downBand = down.length ? { list: down, y, role: 'down' } : null;
  if (downBand) bands.push(downBand);

  const place = (list, bandY) => list.map((n, k) => ({
    n, y: bandY,
    x: (width - rowW(list.length)) / 2 + k * (NW + GAP),
  }));
  const positions = new Map();
  bands.forEach(b => place(b.list, b.y).forEach(p => positions.set(p.n + ':' + b.role, p)));
  const centerX = (width - NW) / 2;

  // Edges first so nodes paint over their endpoints.
  for (const p of positions.values()) {
    const fromUp = p.y < centerY;
    root.append(svg('line', {
      x1: p.x + NW / 2, y1: fromUp ? p.y + NH : centerY + NH,
      x2: centerX + NW / 2, y2: fromUp ? centerY : p.y,
      stroke: 'var(--line)', 'stroke-width': 1.5, 'marker-end': 'url(#dep-arrow)',
    }));
  }

  const node = (n, x, ny, kind) => {
    const issue = S.issues.find(x2 => x2.n === n);
    const title = issue ? issue.t : '';
    const g = svg('g', {
      class: 'depnode ' + kind, tabindex: kind === 'self' ? null : 0,
      role: kind === 'self' ? null : 'button',
      'aria-label': `#${n} ${title}`,
      onclick: kind === 'self' ? null : () => { SEL.issue = n; render(); },
      onkeydown: kind === 'self' ? null : (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); SEL.issue = n; render(); }
      },
    });
    g.append(svg('title', {}, `#${n} ${title}`));
    g.append(svg('rect', { x, y: ny, width: NW, height: NH, rx: 5 }));
    g.append(svg('text', { x: x + 8, y: ny + 13, class: 'dn' }, '#' + n));
    g.append(svg('text', { x: x + 8, y: ny + 24, class: 'dt' },
      title.length > 17 ? title.slice(0, 17) + '…' : title));
    return g;
  };

  for (const [key, p] of positions) root.append(node(p.n, p.x, p.y, key.endsWith(':up') ? 'up' : 'down'));
  root.append(node(center, centerX, centerY, 'self'));

  const overflow = (upstream.length - up.length) + (downstream.length - down.length);
  return h('div', { class: 'depwrap' }, root,
    h('div', { class: 'lab deplegend' },
      up.length ? `${upstream.length} blocking · ` : '',
      down.length ? `${downstream.length} waiting on this` : '',
      overflow > 0 ? ` · ${overflow} more not drawn` : ''));
}

/*
 * The draft, kept OUTSIDE the render.
 *
 * This form used to build fresh inputs on every render and hold the text nowhere else, so
 * anything that redrew the pane — clicking a label filter, a background refresh landing, a
 * push finishing — silently emptied a half-written issue. The chat box has had `chatDraft`
 * for exactly this reason since it was written; the issue form, which is where the longest
 * text in the app gets typed, had nothing.
 *
 * Cleared on a successful stage and on Cancel, which are the two places the user has said
 * they are finished with it. Not cleared on navigation: leaving the form to go and read the
 * issue you are about to duplicate is part of writing one.
 */
let issueDraft = null;

const blankDraft = () => ({ title: '', body: '', milestone: '', labels: [], assignees: [], from: null });

function paneNewIssue(p) {
  const gh = S.github || { milestones: [], labels: [], assignable: [] };
  if (!issueDraft) issueDraft = blankDraft();
  const d = issueDraft;

  const title = h('input', { type: 'text', placeholder: 'Issue title', value: d.title });
  const body = h('textarea', { placeholder: 'Description (markdown)', style: { minHeight: '190px' } });
  body.value = d.body;
  const ms = h('select', {}, h('option', { value: '' }, '— no milestone —'),
    ...gh.milestones.map(m => h('option', { value: m.title, selected: m.title === d.milestone }, m.title)));
  const labels = new Set(d.labels), assignees = new Set(d.assignees);

  // Every keystroke, because the whole point is surviving a redraw nobody asked for.
  title.addEventListener('input', () => { d.title = title.value; });
  body.addEventListener('input', () => { d.body = body.value; });
  ms.addEventListener('change', () => { d.milestone = ms.value; });
  const remember = () => { d.labels = [...labels]; d.assignees = [...assignees]; };

  const wrap = h('div', { class: 'detail pane-narrow' },
    h('div', { class: 'head' }, h('div', { class: 't' }, 'New issue'),
      h('span', { class: 'lab' }, 'staged like everything else — nothing is filed until you push')));

  put(wrap, templatePicker(d, { title, body, labels, assignees, remember }));

  put(wrap,
    h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Title'), title),
    h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Body'), body),
    h('div', { class: 'grid2' },
      h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Milestone'), ms),
      h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Assignees'),
        h('div', { class: 'picker' }, ...gh.assignable.slice(0, 24).map(w =>
          h('button', {
            class: 'pick', 'aria-pressed': String(assignees.has(w)),
            onclick: (e) => {
              assignees.has(w) ? assignees.delete(w) : assignees.add(w);
              e.currentTarget.setAttribute('aria-pressed', String(assignees.has(w)));
              remember();
            },
          }, w))))),
    h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Labels'),
      h('div', { class: 'picker' }, ...gh.labels.map(l =>
        h('button', {
          class: 'pick', 'aria-pressed': String(labels.has(l.name)),
          onclick: (e) => {
            labels.has(l.name) ? labels.delete(l.name) : labels.add(l.name);
            e.currentTarget.setAttribute('aria-pressed', String(labels.has(l.name)));
            remember();
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
          }).then(() => { issueDraft = null; SEL.issue = null; renderPane(); });
        },
      }, 'Stage new issue'),
      h('button', {
        class: 'btn',
        title: 'Discard this draft and go back',
        onclick: () => { issueDraft = null; SEL.issue = null; renderPane(); },
      }, 'Cancel')));
  p.append(wrap);
}

/*
 * The repository's own issue templates.
 *
 * A maintainer writes a template to ask specific questions, and an issue filed without it
 * skips every one of them. vibe-git used to offer a blank box regardless, which made filing
 * through this app strictly worse than filing on github.com for any repository that has
 * them — the one comparison it must never lose.
 *
 * Fetched once per repository and cached, because most repositories have none and asking
 * again on every render would be a filesystem walk per keystroke-triggered redraw.
 */
let TEMPLATES = null;            // { issue: [], pr: [] } once fetched
let templatesFor = null;         // which repo path the cache belongs to

async function loadTemplates() {
  const path = S && S.selected && S.selected.path;
  if (!path) return null;
  if (templatesFor === path && TEMPLATES) return TEMPLATES;
  try {
    const r = await api('/api/templates');
    TEMPLATES = { issue: r.issue || [], pr: r.pr || [] };
    templatesFor = path;
  } catch { TEMPLATES = { issue: [], pr: [] }; templatesFor = path; }
  return TEMPLATES;
}

function applyTemplate(t, d, ui) {
  // Never overwrite text somebody has already typed — a template is a starting point, and
  // clobbering a half-written body would be the exact failure this form just stopped having.
  if (d.body.trim() && !confirm('Replace what you have written with the "' + t.name + '" template?')) return;
  d.from = t.name;
  d.body = t.body || '';
  ui.body.value = d.body;
  if (t.title && !d.title.trim()) { d.title = t.title; ui.title.value = t.title; }
  // Labels and assignees are additive: the template's are what it asks for, and anything
  // already picked was picked deliberately.
  (t.labels || []).forEach(l => { if ((S.github.labels || []).some(x => x.name === l)) ui.labels.add(l); });
  (t.assignees || []).forEach(a => ui.assignees.add(a));
  ui.remember();
  renderPane();
}

function templatePicker(d, ui) {
  if (!TEMPLATES) { loadTemplates().then(t => { if (t && t.issue.length) renderPane(); }); return null; }
  const list = TEMPLATES.issue;
  if (!list.length) return null;

  const box = h('div', { class: 'field' },
    h('span', { class: 'lab' }, 'Templates this repository defines'),
    h('div', { class: 'lab' }, d.from
      ? 'Started from “' + d.from + '”. Picking another replaces the body.'
      : 'Optional, but they are the questions the maintainers actually want answered.'));
  const row = h('div', { class: 'picker' });
  list.forEach(t => row.append(h('button', {
    class: 'pick', 'aria-pressed': String(d.from === t.name),
    title: [t.about, t.source, t.form ? 'An issue form — its fields become headings you fill in.' : null,
      (t.labels || []).length ? 'adds labels: ' + t.labels.join(', ') : null]
      .filter(Boolean).join('\n'),
    onclick: () => applyTemplate(t, d, ui),
  }, t.name)));
  if (d.from) {
    row.append(h('button', {
      class: 'pick', title: 'Empty the body and start from nothing',
      onclick: () => {
        d.from = null; d.body = ''; ui.body.value = '';
        renderPane();
      },
    }, 'Blank'));
  }
  box.append(row);
  return box;
}

/* ── plan view (per-repo insights) ───────────────────────────────── */
/*
 * Staging a proposed dependency.
 *
 * A dependency is recorded by editing the blocked issue's BODY — "Blocked by: #4" — because
 * that is where the parser reads edges from and the only form that still means something to
 * someone reading the issue on github.com. So this is an ordinary `edit` change, and the body
 * is rebuilt client-side from the issue as it currently stands rather than from whatever the
 * model was shown, which may be several pulls old.
 */
async function stageDependency(dep) {
  const issue = S.issues.find(i => i.n === dep.blocked);
  if (!issue) return toast('#' + dep.blocked + ' is not in the pulled issue list', 'bad');
  if (issue.st !== 'OPEN') return toast('#' + dep.blocked + ' is closed, so it waits on nothing', 'bad');
  const already = new Set(issue.bk || []);
  const add = dep.blockedBy.filter(n => !already.has(n) && depOpen(n));
  if (!add.length) return toast('Nothing left to record — already declared, or the blocker is closed', '');
  const body = addBlockedByLine(issue.body, add);
  await act(() => api('/api/queue/add', { kind: 'edit', payload: { number: dep.blocked, body } }), 'queue');
}

/*
 * Is this number still an issue that can block something?
 *
 * The server validates every proposed edge when it makes it and again when it reads the plan
 * back, so nothing arrives here naming finished work. What arrives here and then GOES STALE
 * is the other half: DEP_PROPOSALS and S.insights are held in the page across pulls, so an
 * edge that was live when the run finished is still on screen after the pull that closed its
 * blocker — offering to record a constraint that stopped existing thirty seconds ago.
 *
 * Unknown numbers are treated as blockers, not as closed: an issue missing from the list is
 * usually a truncated fetch, and refusing to draw it would hide a real edge.
 */
function depOpen(n) {
  const hit = S.issues.find(x => x.n === n);
  return !hit || hit.st === 'OPEN';
}

/* The browser-side twin of issues.js withBlockedBy(). Kept deliberately simple and identical
   in behaviour: extend an existing line, otherwise append one. */
function addBlockedByLine(body, numbers) {
  const src = String(body == null ? '' : body).replace(/\r/g, '');
  const hit = /^([^\S\n]*\**\s*blocked\s+by[\s:*]*)(.*)$/im.exec(src);
  if (hit) {
    const existing = hit[2].match(/#\d+/g) || [];
    const merged = existing.concat(numbers.map(n => '#' + n)).join(', ');
    return src.slice(0, hit.index) + hit[1].replace(/\s+$/, '') + ' ' + merged +
      src.slice(hit.index + hit[0].length);
  }
  const tail = src.trim() ? src.replace(/\s+$/, '') + '\n\n' : '';
  return tail + 'Blocked by: ' + numbers.map(n => '#' + n).join(', ');
}

/*
 * One proposed edge, as a reviewable card. Used by the Plan view and the assistant rail.
 *
 * A proposal has three fates, not two. It can be recorded, it can be left alone — and it can
 * be WRONG, which is the common one and used to have no button: the model reads two issues
 * about the same subsystem and declares an ordering constraint that does not exist, and the
 * only way to stop being shown it was to stage a body edit asserting something untrue. So
 * refusal is a first-class action here, per edge, because a card that proposes three blockers
 * is often right about two of them.
 */
function depCard(dep) {
  const issue = S.issues.find(i => i.n === dep.blocked);
  const already = new Set((issue && issue.bk) || []);
  const refused = new Set(dep.mutedBy || []);
  // A blocker that has since been closed is dropped from the offer the same way an
  // already-recorded one is: the constraint is satisfied, so there is nothing to write down.
  const finished = dep.blockedBy.filter(n => !depOpen(n));
  const settled = issue && issue.st !== 'OPEN';
  const fresh = settled ? []
    : dep.blockedBy.filter(n => !already.has(n) && !refused.has(n) && depOpen(n));
  const staged = (S.queue || []).some(c => c.kind === 'edit' && c.payload.number === dep.blocked &&
    typeof c.payload.body === 'string' && fresh.length &&
    fresh.every(n => new RegExp('#' + n + '\\b').test(c.payload.body)));
  const name = (n) => {
    const other = S.issues.find(x => x.n === n);
    const done = !depOpen(n);
    const chip = h('button', {
      class: 'chip tap' + (refused.has(n) || done ? ' struck' : ''),
      title: done ? 'Already closed — it blocks nothing'
        : refused.has(n) ? 'You refused this edge'
          : (other ? other.t : 'not in the pulled list'),
      onclick: () => { VIEW = 'issues'; SEL.issue = n; render(); },
    }, '#' + n + (other ? ' ' + (other.t.length > 34 ? other.t.slice(0, 34) + '…' : other.t) : ''));
    // Only worth offering per-blocker when there is a choice to make between them; with one
    // blocker the card-level button says the same thing more clearly.
    if (fresh.length < 2 || refused.has(n) || done) return chip;
    return h('span', { class: 'chipwrap' }, chip, h('button', {
      class: 'chip x', title: 'Refuse just this one — #' + dep.blocked + ' does not wait on #' + n,
      onclick: () => planMute({ kind: 'deps', blocked: dep.blocked, blockedBy: n, label: '#' + dep.blocked + ' ⇠ #' + n }),
    }, '✕'));
  };
  const card = h('div', { class: 'prop dep' + (staged || !fresh.length ? ' done' : '') + (dep.muted ? ' muted' : '') });
  /* "recorded" and "no longer applies" both mean there is nothing to stage and mean opposite
     things about whether the edge was ever right, so they must not share a chip. */
  const why = dep.muted ? h('span', { class: 'chip' }, 'refused')
    : settled ? h('span', { class: 'chip ok' }, '#' + dep.blocked + ' closed')
      : fresh.length ? (staged ? h('span', { class: 'chip' }, 'staged') : null)
        : finished.length && !already.size ? h('span', { class: 'chip ok' }, 'blocker already done')
          : h('span', { class: 'chip ok' }, 'recorded');
  card.append(h('div', { class: 'h' },
    h('span', { class: 't' }, '#' + dep.blocked + ' ' + (dep.title || (issue ? issue.t : ''))),
    why));
  card.append(h('div', { class: 'relrow' }, h('span', { class: 'lab' }, 'waits on'), ...dep.blockedBy.map(name)));
  if (dep.why) card.append(h('div', { class: 'why' }, dep.why));

  const acts = h('div', { class: 'acts' });
  if (fresh.length && !staged) {
    acts.append(h('button', {
      class: 'btn sm primary',
      title: 'Stage an edit adding "Blocked by: ' + fresh.map(n => '#' + n).join(', ') + '" to the body',
      onclick: () => stageDependency(Object.assign({}, dep, { blockedBy: fresh })),
    }, 'Stage dependency'));
    acts.append(h('button', {
      class: 'btn sm', title: 'Open the blocked issue to judge it yourself',
      onclick: () => { VIEW = 'issues'; SEL.issue = dep.blocked; render(); },
    }, 'Open #' + dep.blocked));
    acts.append(h('button', {
      class: 'btn sm',
      title: 'This is not a real ordering constraint. Nothing is staged and it will not be ' +
        'proposed again.',
      onclick: async () => {
        for (const n of fresh) {
          await planMute({
            kind: 'deps', blocked: dep.blocked, blockedBy: n,
            label: '#' + dep.blocked + ' ⇠ #' + n,
          });
        }
      },
    }, fresh.length > 1 ? 'Refuse all ' + fresh.length : 'Refuse'));
  }
  (dep.mutedBy || []).forEach(n => acts.append(h('button', {
    class: 'btn sm', title: 'Allow #' + dep.blocked + ' ⇠ #' + n + ' to be proposed again',
    onclick: () => planUnmute({ kind: 'deps', blocked: dep.blocked, blockedBy: n }),
  }, 'Restore #' + n)));
  if (acts.children.length) card.append(acts);
  return card;
}

/* ── hiding parts of the plan ────────────────────────────────────── */
/*
 * Muting is a per-repository "not now" that stages nothing. See lib/mutes.js for why it is a
 * separate idea from ignoring, and note that these two key builders MUST agree with the ones
 * there character for character — a key composed differently on this side matches nothing on
 * that one, and the button would silently do nothing.
 */
const muteTitleKey = (value) => String(value == null ? '' : value)
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function planItemKey(entry) {
  if (!entry) return null;
  if (entry.gap) {
    const key = muteTitleKey(entry.gap);
    return key ? 'gap:' + key : null;
  }
  const ns = [...new Set((entry.ns || []).filter(Number.isInteger))];
  return ns.length ? 'ns:' + ns.sort((a, b) => a - b).join(',') : null;
}

const planMutes = () => (S && S.planMutes) || { items: [], deps: [] };

/* Every one of these reloads state rather than patching in place: mutes are applied when the
   plan is READ, so the ranking, the counts and the dependency cards all change together. */
async function planMute(payload) {
  try {
    const r = await api('/api/plan/mute', payload);
    toast(r.message, 'good');
    await load();
  } catch (e) { toast(e.message, 'bad'); }
}
async function planUnmute(payload) {
  try {
    const r = await api('/api/plan/unmute', payload);
    toast(r.message, 'good');
    await load();
  } catch (e) { toast(e.message, 'bad'); }
}
async function planUnmuteAll(kind) {
  try {
    const r = await api('/api/plan/mutes/clear', kind ? { kind } : {});
    toast(r.message, 'good');
    await load();
  } catch (e) { toast(e.message, 'bad'); }
}

/* Turning down a proposed issue. Shared, because it is offered from both the ranked list and
   the gap cards and the two must not drift apart. */
async function ignoreGap(title, why) {
  try {
    const r = await api('/api/ai/ignore', { title, reason: why });
    IGNORED = r.ignored; IGNORED_TITLES = r.ignored.map(x => x.title);
    toast(r.message, 'good');
    await load();
  } catch (e) { toast(e.message, 'bad'); }
}

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

  /*
   * Finished milestones leave the header.
   *
   * The first band used to be the first milestone the repository ever had, forever. Once it
   * was done the header opened with a phase whose due date is in the past — "Next milestone
   * due: 0 days" — and a timeline whose left half is history the reader has no decision to
   * make about. Both were describing the project accurately and answering the wrong question,
   * which for a view called "What to build next" is the whole question.
   *
   * A phase is complete when GitHub says the milestone is closed, or when it holds issues and
   * none are still open — the second because closing the milestone itself is a chore people
   * skip for months. Whatever is being filtered on stays visible regardless, or clicking a
   * band could make that band disappear.
   */
  const phaseComplete = (ph) => {
    if (String(ph.state || '').toLowerCase() === 'closed') return true;
    const mine = S.issues.filter(i => i.p === ph.n);
    return mine.length > 0 && mine.every(i => i.st !== 'OPEN');
  };
  const donePhases = ins.phases.filter(phaseComplete);
  const livePhases = showDonePhases
    ? ins.phases
    : ins.phases.filter(ph => !phaseComplete(ph) || FILTER.phase === ph.n);

  const p0 = livePhases[0];
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
  livePhases.forEach(ph => {
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
  if (livePhases.length) {
    const t0 = livePhases[0].s ? +new Date(livePhases[0].s + 'T00:00:00') : NaN;
    const lastDue = livePhases[livePhases.length - 1].e;
    const span = lastDue ? +new Date(lastDue + 'T00:00:00') - t0 : NaN;
    if (Number.isFinite(t0) && span > 0) {
      tl.append(h('div', { class: 'today', style: { left: Math.min(100, Math.max(0, (now - t0) / span * 100)) + '%' } },
        h('span', {}, 'TODAY')));
    }
    wrap.append(h('div', { class: 'tl-outer', style: { marginBottom: donePhases.length ? '8px' : '26px' } }, tl));
  }
  /* Every milestone is finished, so there is no timeline to draw and saying nothing would
     read as a bug rather than as an answer. */
  if (!livePhases.length && ins.phases.length) {
    wrap.append(h('div', { class: 'banner', style: { marginBottom: '18px' } },
      h('b', {}, 'Every milestone is complete. '),
      'Nothing is scheduled ahead of you. Open a new milestone, or reopen one to plan against it.'));
  }
  if (donePhases.length) {
    wrap.append(h('div', { class: 'acts', style: { marginBottom: '26px' } },
      h('span', { class: 'lab' }, donePhases.length + ' completed milestone' +
        (donePhases.length === 1 ? '' : 's') + ' ' + (showDonePhases ? 'shown' : 'hidden')),
      h('button', {
        class: 'btn sm',
        title: 'Milestones that are closed, or whose issues are all closed',
        onclick: () => { showDonePhases = !showDonePhases; renderPane(); },
      }, showDonePhases ? 'Hide completed' : 'Show completed')));
  }

  /*
   * Dependency structure, above the ranking rather than below it.
   *
   * The ranking is an ANSWER to "what next"; the dependency graph is the constraint the
   * answer has to satisfy. Reading them the other way round — order first, then discovering
   * the third item cannot start until the ninth is finished — is exactly the mistake this
   * view exists to stop.
   */
  wrap.append(planDependencies(open));

  /* ranked */
  const hiddenToggle = h('button', {
    class: 'btn sm', onclick: () => { showHiddenPlan = !showHiddenPlan; renderPane(); },
  }, 'Show hidden');
  wrap.append(h('div', { class: 'sec-head' }, h('h2', {}, 'Recommended order'), hiddenToggle));
  const queue = h('div', { class: 'queue', style: { marginTop: '12px' } });
  let rank = 0, shown = 0, hidden = 0, outsidePhase = 0, muted = 0;
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
    /*
     * A hidden entry gives up its rank number.
     *
     * That is the whole point of the button: someone hides the third item because it does not
     * belong third, and if the numbering kept a gap where it used to be, the list would still
     * be asserting the order they just rejected. Finished work has always been renumbered
     * away the same way.
     */
    const isMuted = !!r.muted;
    if (isMuted) muted++;
    if (!done && !isMuted) rank++;
    if ((done || isMuted) && !showHiddenPlan) { hidden++; return; }
    if (FILTER.phase !== null && !itemPhases.includes(FILTER.phase)) { outsidePhase++; return; }
    shown++;
    if (isMuted) { c = 'var(--fg-dim)'; bits.push(h('span', { class: 'chip' }, 'hidden')); }

    const acts = h('div', { class: 'acts' });
    openNums.forEach(n => acts.append(h('button', {
      class: 'btn sm', onclick: () => stage('close', { number: n, reason: 'completed' }),
    }, 'Stage close #' + n)));
    closedNums.forEach(n => acts.append(h('button', {
      class: 'btn sm', onclick: () => stage('reopen', { number: n }),
    }, 'Stage reopen #' + n)));
    if (r.gap && !gapHit && !gapPending && !gapIgnored) {
      const g = ins.gaps.find(x => x.t === r.gap);
      if (g) {
        acts.append(h('button', { class: 'btn sm primary', onclick: () => stageGap(g, ins) }, 'Stage create'));
        // The gap cards below have always had this; the ranked entries did not, so a proposal
        // you met here could only be staged, never turned down.
        acts.append(h('button', {
          class: 'btn sm', title: 'Never suggest this again',
          onclick: () => ignoreGap(g.t, g.why),
        }, 'Ignore'));
      }
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

    /*
     * Hide, offered on everything the plan still recommends.
     *
     * The gap between "stage a change" and "do nothing" was the whole usable range of
     * responses to a ranking, and it was empty. This fills it: no queue entry, no GitHub
     * call, reversible from the toggle above — for the item that is real but not this week,
     * and for the one the model simply put in the wrong place.
     */
    const key = r.muteKey || planItemKey(r);
    if (key && !done) {
      acts.append(isMuted
        ? h('button', {
          class: 'btn sm', title: 'Put it back in the recommended order',
          onclick: () => planUnmute({ kind: 'items', key }),
        }, 'Unhide')
        : h('button', {
          class: 'btn sm',
          title: 'Fold it out of the way without staging anything. Reversible, and the next ' +
            'plan is told you pushed it down.',
          onclick: () => planMute({
            kind: 'items', key,
            label: r.gap || [...openNums, ...closedNums].map(n => '#' + n).join(' ') +
              (byNum[(openNums[0] || closedNums[0])] ? ' ' + byNum[openNums[0] || closedNums[0]].t : ''),
          }),
        }, 'Hide'));
    }

    queue.append(h('div', {
      class: 'card' + (done ? ' done' : '') + (isMuted ? ' muted' : ''), style: { '--c': c },
    },
      h('div', { class: 'rank num' }, done ? '✓' : (isMuted ? '–' : String(rank))),
      h('div', { class: 'cbody' },
        h('div', { class: 'row1' }, ...head),
        h('p', { class: 'why' }, rich(r.why)),
        h('div', { class: 'tags' }, ...bits),
        acts.children.length ? acts : null)));
  });

  hiddenToggle.textContent = showHiddenPlan
    ? 'Fold finished + hidden away'
    : 'Show hidden (' + hidden + ')';
  hiddenToggle.disabled = hidden === 0 && !showHiddenPlan;
  hiddenToggle.title = muted
    ? muted + ' entr' + (muted === 1 ? 'y is' : 'ies are') + ' hidden by you; the rest are finished'
    : 'Finished work, folded away';
  if (muted && !showHiddenPlan) {
    wrap.append(h('div', { class: 'acts', style: { marginTop: '10px' } },
      h('span', { class: 'lab' }, 'you hid ' + muted + ' entr' + (muted === 1 ? 'y' : 'ies')),
      h('button', {
        class: 'btn sm', title: 'Put every hidden entry back in the order',
        onclick: () => planUnmuteAll('items'),
      }, 'Unhide all')));
  }

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
        onclick: () => ignoreGap(g.t, g.why),
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
  /* An image has no readable text diff — `git diff` says "Binary files differ" and stops,
     which is true and tells you nothing. Show the picture instead. */
  if (isImagePath(SEL.file)) {
    const known = (S.git && S.git.status.files.find(f => f.path === SEL.file)) || null;
    return imageDiffPane(p, SEL.file, known ? known.status : null);
  }
  p.append(h('div', { class: 'empty' }, 'Loading diff…'));
  try {
    const d = await api('/api/git/diff?file=' + encodeURIComponent(SEL.file));
    clear(p);
    p.append(diffBlock(d.patch, d.path + (d.untracked ? '  (new file)' : d.conflicted ? '  (conflicted)' : '  vs HEAD'),
      { conflicted: !!d.conflicted }));
  } catch (e) {
    clear(p).append(h('div', { class: 'banner' }, h('b', {}, 'Could not load diff. '), e.message));
  }
}

async function paneHistory(p) {
  if (HISTORY_MODE === 'issues') return paneIssueHistory(p);
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

/*
 * A rating chip always says what it is rating.
 *
 * The rail used to show a bare "82%" beside a proposal and a bare "84%" beside a duplicate
 * group, and they measure completely different things — one is the model's confidence in its
 * own answer, the other is cosine similarity between two issues. Same shape, same colours,
 * no way to tell them apart, and 84% similarity reads as far more certain than it is. The
 * word is part of the chip now rather than a tooltip, because a tooltip does not exist on a
 * touch screen and does not exist for a screen reader reading the list.
 */
const METRIC_TITLE = {
  conf: "the model's confidence in this proposal",
  sim: 'cosine similarity between the issue texts',
};

function ratingChip(value, metric) {
  if (value == null) return null;
  const cls = value >= 0.8 ? 'hi' : value >= 0.55 ? 'mid' : 'lo';
  return h('span', {
    class: 'conf ' + cls, title: METRIC_TITLE[metric] || '',
    'aria-label': `${metric === 'sim' ? 'similarity' : 'confidence'} ${Math.round(value * 100)} percent`,
  }, h('span', { class: 'metric' }, metric === 'sim' ? 'sim' : 'conf'), Math.round(value * 100) + '%');
}

const confChip = (c) => ratingChip(c, 'conf');
const simChip = (s) => ratingChip(s, 'sim');

let railOpen = false;
let RAIL_TAB = 'run';          // 'run' | 'chat' | 'settings'
let MILESTONES = [];           // proposed new milestones
let NEW_LABELS = [];           // labels the classifier nominated
let DEP_PROPOSALS = [];        // blocking relationships the classifier spotted
let DEP_DROPPED = 0;           // ...and how many it proposed against already-closed issues
let DUPES = [];                // near-duplicate clusters awaiting a decision
let DUPE_SCALE = null;         // this repo's similarity distribution, for honest labelling
let dupeClosed = true;         // a duplicate of a CLOSED issue is the most useful kind
let IGNORED = [];              // suggestions previously dismissed
let showIgnored = false;
let showHandledGaps = false;
let showHiddenPlan = false;
// Finished milestones and refused dependency edges: both folded away by default and both
// one click from being visible again, because a plan you cannot audit is not reviewable.
let showDonePhases = false;
let showRefusedDeps = false;
let PRS = [], prState = 'open', prLoaded = false, EDITING = null;
let IGNORED_TITLES = [];   // titles only, for gap matching

/* Assistant work is cancellable, so each run carries an id the browser mints up front —
   waiting for the server to name the job would leave its slowest part uncancellable. */
/*
 * What the model is doing, polled while it does it.
 *
 * A local 30B can take two minutes on a classification run, and a spinner for two minutes is
 * indistinguishable from a hang. The server already tracked kind, progress and current step
 * per job and nothing ever read them; this is the reader. Polling rather than streaming
 * because the work is a single non-streaming POST and a second endpoint costs nothing.
 */
let AI_JOBS = [];              // live progress, from /api/ai/jobs
let jobPoll = null;

function jobLine() {
  const job = AI_JOBS.find(j => !j.cancelled);
  if (!job) return '';
  const label = job.label || job.kind || 'working';
  const frac = job.total > 1 ? ` ${Math.min(job.done + 1, job.total)}/${job.total}` : '';
  const step = job.step ? ' · ' + job.step : '';
  return (label + frac + step).slice(0, 64);
}

function startJobPoll() {
  if (jobPoll) return;
  jobPoll = setInterval(async () => {
    if (!aiBusy && !chatBusy) return stopJobPoll();
    try {
      const r = await api('/api/ai/jobs');
      AI_JOBS = r.jobs || [];
      // Only the two live regions are redrawn. Re-rendering the whole rail every second
      // would destroy the chat box and its caret while someone was typing the next question.
      const state = $('ai-state');
      if (state) state.textContent = jobLine() || 'working…';
      const live = document.querySelector('.joblive');
      if (live) { clear(live); live.append(jobDetail()); }
    } catch { /* the action's own error handling covers a real outage */ }
  }, 1100);
}

function stopJobPoll() {
  clearInterval(jobPoll); jobPoll = null; AI_JOBS = [];
  const live = document.querySelector('.joblive');
  if (live) clear(live);
}

/* The fuller version, shown in the Run tab under the buttons. */
function jobDetail() {
  const job = AI_JOBS.find(j => !j.cancelled);
  if (!job) return h('span', { class: 'lab' }, 'starting…');
  const pct = job.total > 1 ? Math.round((job.done / job.total) * 100) : null;
  return h('div', { class: 'jobrow' },
    h('div', { class: 'jt' },
      h('b', {}, job.label || job.kind),
      h('span', { class: 'lab' }, job.seconds + 's')),
    job.step ? h('div', { class: 'js' }, job.step) : null,
    pct == null ? null : h('div', { class: 'jbar' },
      h('i', { style: { width: pct + '%' } }),
      h('span', { class: 'lab' }, `${job.done} of ${job.total}`)));
}

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
/* What a plan may add beyond the ordering itself. Both default on, both answerable per run:
   "just rank what I have" is a legitimate and common request. */
let planWantGaps = true;
let planWantDeps = true;
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
  aiBusy = true; busy(true); renderRail(); renderNav(); startJobPoll();
  try {
    const r = await fn(AI_JOB);
    if (r && r.cancelled) { toast(r.message || 'Cancelled', ''); return null; }
    if (r && r.message) toast(r.message, 'good');
    return r;
  } catch (e) { toast(e.message, 'bad'); return null; }
  finally { AI_JOB = null; aiBusy = false; stopJobPoll(); busy(false); renderRail(); renderNav(); }
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
    : (aiBusy || chatBusy) ? (jobLine() || 'working…')
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
      title: 'End the conversation and discard the transcript, including any proposal cards ' +
        'below it that you have not staged. Nothing already staged is affected.',
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
  chatBusy = true; CHAT_JOB = newJobId(); startJobPoll();
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
    chatBusy = false; CHAT_JOB = null; stopJobPoll();
    busy(false); renderRail(); renderNav();
    const box = document.querySelector('.chat-in');
    if (box) box.focus();
  }
}

/* ── Settings tab ────────────────────────────────────────────────── */
/* A labelled text field that saves on change. Enough of them exist now to be worth naming. */
function aiField(label, value, key, { type = 'text', placeholder = '', hint = '' } = {}) {
  const input = h('input', { type, value: value || '', placeholder });
  input.addEventListener('change', () => {
    const v = input.value.trim();
    aiSave({ [key]: v }).catch(e => toast(e.message, 'bad'));
  });
  return h('div', { class: 'field' }, h('span', { class: 'lab' }, label), input,
    hint ? h('span', { class: 'lab hint-line' }, hint) : null);
}

function railSettings(body, foot, cfg) {
  if (!AI.ok) {
    body.append(h('div', { class: 'banner' }, h('b', {}, 'Endpoint unreachable. '), AI.error || '',
      h('br'), h('br'),
      // The advice depends on where they were pointing. Telling someone with an OpenAI URL
      // to run `ollama serve` is the kind of help that makes people stop reading errors.
      (cfg.provider === 'anthropic' || /anthropic\.com/.test(cfg.endpoint || ''))
        ? 'Check the API key and that this machine can reach api.anthropic.com.'
        : /^https:/.test(cfg.endpoint || '')
          ? 'Check the URL and the API key for that provider.'
          : h('span', {}, 'If this is Ollama, start it with ', h('code', {}, 'ollama serve'), '.')));
  }

  /*
   * The endpoint is asked for first and the provider second, because in practice people know
   * the URL and not the dialect. Left on "detect", the server probes and reports back what
   * answered — which is shown beside the picker, so an unexpected answer is visible rather
   * than silently shaping every later request.
   */
  const detected = AI.ok && AI.providerLabel
    ? h('span', { class: 'lab hint-line' },
      'Detected: ' + AI.providerLabel + (AI.models.length ? ` · ${AI.models.length} models` : ''))
    : null;

  const providerSel = h('select', {},
    h('option', { value: 'auto' }, 'Detect automatically'),
    h('option', { value: 'ollama' }, 'Ollama'),
    h('option', { value: 'openai' }, 'OpenAI-compatible (llama.cpp, LM Studio, vLLM, OpenRouter…)'),
    h('option', { value: 'anthropic' }, 'Anthropic'));
  providerSel.value = cfg.provider || 'auto';
  providerSel.addEventListener('change', () =>
    aiSave({ provider: providerSel.value }).catch(e => toast(e.message, 'bad')));

  body.append(h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
    aiField('Endpoint', cfg.endpoint || 'http://127.0.0.1:11434', 'endpoint',
      { placeholder: 'http://127.0.0.1:11434' }),
    h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Kind of endpoint'), providerSel, detected),
    /*
     * The key is write-only from the browser's point of view: what comes back is a row of
     * dots, and sending those dots back unchanged means "keep it". ${VAR} is offered in the
     * placeholder because a key in an environment variable is a config file that is safe to
     * back up, and nobody discovers that option without being told.
     */
    aiField('API key', cfg.apiKey || '', 'apiKey', {
      type: 'password', placeholder: 'only for hosted endpoints — or ${MY_API_KEY}',
      hint: cfg.apiKey ? 'A key is stored. Clear the box and press enter to remove it.'
        : 'Left empty for local servers. Stored in ~/.config/vibe-git/config.json, mode 0600.',
    }),
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
        'Chat always asks for at least 16k, since tool results have to fit alongside the conversation.')),
    /*
     * Residency, offered here because it is the largest latency knob in the app and the
     * default that costs the most is the one nobody knows exists. Ollama drops a model after
     * five idle minutes; that is shorter than the pause between reading a plan and asking a
     * question about it, so the usual rhythm of using this pays a full reload almost every
     * time. A hosted endpoint has no residency and ignores this.
     */
    (AI.can && AI.can.unload === false) ? null
      : h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Keep model loaded (minutes)'),
        (() => {
          const value = cfg.keepAliveMinutes == null ? 30 : cfg.keepAliveMinutes;
          const i = h('input', { type: 'number', min: '-1', max: '1440', value: String(value) });
          i.addEventListener('change', () => aiSave({ keepAliveMinutes: Number(i.value) }).catch(e => toast(e.message, 'bad')));
          return i;
        })(),
        h('span', { class: 'lab', style: { textTransform: 'none', letterSpacing: '0' } },
          'How long a local model stays in VRAM between requests. 0 uses the server\'s own ' +
          'default (5 minutes for Ollama); -1 keeps it resident until you unload it. A big ' +
          'model reloads in tens of seconds, so this is the difference between an answer ' +
          'starting now and starting in half a minute.'))));

  /*
   * A second endpoint for embeddings, folded away because most people never need it.
   *
   * Two cases make it necessary rather than nice: Anthropic has no embedding API at all, so
   * every semantic feature is dead without one; and sending a whole tracker's issue bodies to
   * a hosted embedder costs money and privacy that a local nomic-embed does not.
   */
  const embedOpen = !!cfg.embedEndpoint;
  const embedProviderSel = h('select', {},
    h('option', { value: 'auto' }, 'Detect automatically'),
    h('option', { value: 'ollama' }, 'Ollama'),
    h('option', { value: 'openai' }, 'OpenAI-compatible'));
  embedProviderSel.value = cfg.embedProvider || 'auto';
  embedProviderSel.addEventListener('change', () =>
    aiSave({ embedProvider: embedProviderSel.value }).catch(e => toast(e.message, 'bad')));

  const embedBox = h('details', embedOpen ? { open: true } : {},
    h('summary', {}, 'Separate endpoint for embeddings'),
    h('div', { class: 'fold' },
      h('span', { class: 'lab hint-line' },
        AI.can && AI.can.embed === false
          ? 'This provider has no embedding API, so semantic search needs one here.'
          : 'Leave blank to embed on the same endpoint as chat.'),
      aiField('Embedding endpoint', cfg.embedEndpoint || '', 'embedEndpoint',
        { placeholder: 'http://127.0.0.1:11434' }),
      h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Kind'), embedProviderSel),
      aiField('Embedding API key', cfg.embedApiKey || '', 'embedApiKey',
        { type: 'password', placeholder: 'defaults to the key above' }),
      AI.embed
        ? h('span', { class: 'lab hint-line' }, AI.embed.ok
          ? `Reachable · ${AI.embed.provider} · ${AI.embed.models.length} models`
          : 'Unreachable: ' + (AI.embed.error || 'no answer'))
        : null));
  body.append(embedBox);

  // Model residency is an Ollama-shaped idea. A hosted endpoint has nothing to unload, and
  // offering the button anyway produces a control that can only ever report failure.
  if (AI.can && AI.can.listLoaded && AI.loaded && AI.loaded.length) {
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
  /*
   * Every button here spends minutes of model time and they are told apart by four words
   * each. "Suggest missing issues" and "Suggest milestones" in particular read as the same
   * button twice, and the difference — one invents work, the other invents categories — is
   * exactly what you want to know before pressing either. So each says what it reads, what
   * it produces, and what it costs.
   */
  const acts = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
    h('button', {
      class: 'btn wide primary', disabled: !ready, onclick: () => runClassify(false),
      title: 'Read every open issue that has no milestone and propose one for each, plus labels. ' +
        'One model call per issue, so this is the slowest button here.',
    }, aiBusy ? h('span', { class: 'spin' }) : null, 'Classify ' + unclassified + ' unassigned'),
    h('button', {
      class: 'btn wide', disabled: !ready, onclick: () => runClassify(true),
      title: 'The same pass over EVERY open issue, including ones already filed under a ' +
        'milestone — for when the milestones have changed and the old placements may be wrong.',
    }, 'Re-check all open'),
    h('button', {
      class: 'btn wide', disabled: aiBusy, onclick: () => runSuggest(),
      title: 'Propose NEW issues for work the planning document and milestones imply but the ' +
        'tracker does not cover. Reads the repository files first so it does not propose what is built.',
    }, 'Suggest missing issues'),
    h('button', {
      class: 'btn wide', disabled: !ready, onclick: () => runMilestones(),
      title: 'Propose new MILESTONES — groupings for work the existing milestones cannot hold. ' +
        'Files nothing and moves no issues.',
    }, 'Suggest milestones'),
    planButtonRow(ready));
  if (cfg.embedModel) {
    acts.append(h('button', {
      class: 'btn wide', disabled: !ready,
      title: 'Embed every issue with the embedding model so search matches meaning and the ' +
        'duplicate finder works. Only new or edited issues are re-embedded, so re-running is cheap.',
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
    // Filled by the poll rather than by this render, so it updates without rebuilding the tab.
    acts.append(h('div', { class: 'joblive' }, jobDetail()));
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
    !NEW_LABELS.length && !DUPES.length && !DEP_PROPOSALS.length && !DEP_DROPPED;

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
  if (DEP_PROPOSALS.length || DEP_DROPPED) {
    body.append(h('h3', {}, 'Dependencies found'),
      h('div', { class: 'lab', style: { marginBottom: '7px' } },
        DEP_PROPOSALS.length
          ? 'staging one writes “Blocked by: #N” into the blocked issue’s body'
          : 'nothing left to record'),
      /* Silently dropping these read as "the model found nothing", which is a different and
         much more flattering claim than "the model kept reaching for finished work". */
      DEP_DROPPED
        ? h('div', { class: 'lab', style: { marginBottom: '7px' } },
          DEP_DROPPED + ' more ignored: ' +
          (DEP_DROPPED === 1 ? 'a proposal that named' : 'proposals that named') +
          ' an already-closed issue as the blocker')
        : null);
    DEP_PROPOSALS.forEach(d => body.append(depCard(d)));
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
    title: st.hasPlan
      ? 'Offers a choice between updating the existing plan and starting over. ' + driftText(st)
      : 'Rank the open issues into a recommended order with reasons, and propose the ' +
        'dependencies and missing work behind that order. Saved locally; dates and milestones ' +
        'still come from GitHub.',
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
  const check = (label, hint, get, set) => {
    const box = h('input', { type: 'checkbox', checked: get() });
    box.addEventListener('change', () => { set(box.checked); renderRail(); });
    return h('label', { class: 'inline-check', title: hint }, box, h('span', { class: 'lab' }, label));
  };
  return h('div', {},
    h('label', { class: 'inline-check', style: { marginTop: '6px' } }, sel,
      h('span', { class: 'lab' }, open ? 'of ' + open + ' open' : 'plan length')),
    /*
     * Asking for a plan and getting five invented issues with it is not what was asked for.
     * Both extras are opt-out here rather than buried, because the moment you want them off
     * is the moment you are about to press the button.
     */
    check('suggest missing issues', 'Propose issues the plan implies but the tracker lacks',
      () => planWantGaps, (v) => { planWantGaps = v; }),
    check('find dependencies', 'Work out which issues block which, and propose recording it',
      () => planWantDeps, (v) => { planWantDeps = v; }));
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
      simChip(cluster.score)),
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
    gapCount: planWantGaps ? 5 : 0,
    deps: planWantDeps,
    // An update reuses the scope, the gap count and the dependency switch already saved with
    // the plan; the server ignores these on an update.
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
  // Ordering constraints found while reading every open issue — the same pass, so they cost
  // nothing extra, and re-checking all open is exactly when they surface.
  DEP_PROPOSALS = r.deps || [];
  DEP_DROPPED = Number(r.depsClosed) || 0;
  renderRail();
}

async function runSuggest() {
  const r = await runAi(jobId => api('/api/ai/suggest', { count: 6, jobId }));
  if (!r) return;
  SUGGESTIONS = r.suggestions; PROPOSALS = [];
  renderRail();
}


/* ── conflicts ───────────────────────────────────────────────────── */
/*
 * The view exists because "open each conflicted file and pick what survives between the
 * markers" is the one instruction in this app that hands the work back to the user. Every
 * other operation here is a button.
 *
 * What it adds over an editor, and over GitHub Desktop:
 *   - It names the sides. Not "ours" and "theirs" but the branch or commit each one came
 *     from, the role it plays, and which of the two is newer.
 *   - It says so loudly when a rebase has swapped them, which is the failure this whole
 *     view is built around.
 *   - It handles the conflicts that have no markers to edit — the delete/modify family —
 *     which is where an editor-based workflow leaves you with nothing to look at.
 *   - Nothing is staged until you say so, so every decision can be taken back.
 */

const conflictKey = (path, index) => path + ' ' + index;

async function refreshConflicts({ detail = true } = {}) {
  if (!S || !S.selected) { CONFLICTS = null; CONFLICT_DETAIL = null; return; }
  conflictsLoading = true;
  try {
    CONFLICTS = await api('/api/git/conflicts');
    conflictsError = null;
  } catch (e) {
    CONFLICTS = null; CONFLICT_DETAIL = null;
    conflictsError = e.message;
    return;
  } finally { conflictsLoading = false; }

  const rows = CONFLICTS.files;
  const has = (p) => rows.some(f => f.path === p);
  if (SEL.conflict && !has(SEL.conflict)) { SEL.conflict = null; CONFLICT_DETAIL = null; }
  if (!SEL.conflict) {
    // Land on something that still needs a decision rather than on the first row
    // alphabetically, which after a few resolutions is usually already done.
    const next = rows.find(f => !f.ready) || rows[0];
    SEL.conflict = next ? next.path : null;
    CONFLICT_DETAIL = null;
  }
  if (detail && SEL.conflict) await loadConflictDetail(SEL.conflict);
  else if (!SEL.conflict) CONFLICT_DETAIL = null;
}

/*
 * A concurrent caller JOINS the request in flight rather than being turned away.
 *
 * Turning it away looks equivalent and is not: the renderer fetches when it finds no detail
 * and re-renders when the call settles, so an early return resolves immediately, re-renders,
 * finds no detail, and calls again — a tight loop with no network in it, which pins the tab
 * rather than merely being wasteful. Sharing the promise means every caller redraws once,
 * after the one request lands.
 */
function loadConflictDetail(file) {
  if (conflictDetailFor && conflictDetailFor.file === file) return conflictDetailFor.promise;
  const promise = (async () => {
    try {
      const next = await api('/api/git/conflict?file=' + encodeURIComponent(file));
      // A slow response for a file the user has since navigated away from must not
      // overwrite the one they are looking at now.
      if (SEL.conflict !== file) return;
      CONFLICT_DETAIL = next;
      conflictDetailError = null;
      // A stale draft belongs to the text that was on screen before, not to this one.
      if (!conflictRaw) conflictRawDraft = next.content || '';
    } catch (e) {
      if (SEL.conflict !== file) return;
      CONFLICT_DETAIL = null;
      conflictDetailError = e.message;
    } finally {
      if (conflictDetailFor && conflictDetailFor.file === file) conflictDetailFor = null;
    }
  })();
  conflictDetailFor = { file, promise };
  return promise;
}

/* The retry, shown in place of the thing that would not load. */
/*
 * The tracker's history, grouped by day.
 *
 * By day rather than as a flat list because the useful question is "what happened that week",
 * and because the shape of the answer is itself information: four closes on one day and
 * nothing for the next fortnight is a fact about the project that no per-issue view shows.
 */
function paneIssueHistory(p) {
  const wrap = h('div', { class: 'pane-narrow' });
  if (!S.issuesLoaded) {
    wrap.append(h('div', { class: 'sec-head' }, h('h2', {}, 'Issue activity'),
      h('p', {}, 'Nothing is loaded yet. Pull issues from the Issues view and this fills in.')));
    return p.append(wrap);
  }
  const { events, total } = issueEvents();
  const opened = events.filter(e => e.kind === 'opened').length;
  const closed = events.filter(e => e.kind === 'closed').length;

  wrap.append(h('div', { class: 'sec-head', style: { marginBottom: '12px' } },
    h('h2', {}, 'Issue activity'),
    h('p', {},
      events.length
        ? `${events.length === total ? total : 'The newest ' + events.length + ' of ' + total} ` +
          `event${total === 1 ? '' : 's'} — ${opened} filed, ${closed} closed, ` +
          `${events.length - opened - closed} comment${events.length - opened - closed === 1 ? '' : 's'}. ` +
          'Read from your last pull, and limited to the comments the pull kept. ' +
          'Label changes and reassignments are not here: GitHub keeps those in a timeline this app does not fetch.'
        : 'No issue activity recorded.')));

  if (!events.length) return p.append(wrap);

  const list = h('div', { class: 'commits' });
  let day = null;
  for (const e of events) {
    const stamp = new Date(e.at);
    const key = stamp.toDateString();
    if (key !== day) {
      day = key;
      list.append(h('div', { class: 'crow dayhead' },
        h('span', { class: 'sha' }, ''),
        h('span', { class: 's' }, stamp.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })),
        h('span', { class: 'w' }, ago(e.at))));
    }
    list.append(h('div', {
      class: 'crow ev-' + e.kind, style: { cursor: 'pointer' },
      onclick: () => { VIEW = 'issues'; SEL.issue = e.n; render(); },
    },
      h('span', { class: 'sha' }, EVENT_WORD[e.kind]),
      h('span', { class: 's', title: e.kind === 'commented' && e.body ? e.body : e.t },
        '#' + e.n + ' ' + e.t),
      h('span', { class: 'w' }, e.who ? '@' + e.who : stamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))));
  }
  wrap.append(list);
  p.append(wrap);
}

function conflictFailure(message, retry) {
  return h('div', { class: 'banner' },
    h('b', {}, 'Could not read the conflict. '), message,
    h('div', { class: 'acts', style: { marginTop: '10px' } },
      h('button', { class: 'btn sm', onclick: retry }, 'Try again')));
}

/*
 * Every conflict mutation goes through here: act, re-read the conflict, re-read git. The
 * second read matters — resolving the last hunk changes the nav badge, the Changes list and
 * the merge banner, none of which live in the conflict payload.
 */
async function conflictAct(fn, { keepRaw = false } = {}) {
  busy(true);
  try {
    const r = await fn();
    if (r && r.message) toast(r.message, r.ok === false ? 'bad' : 'good');
    if (r && r.detail) console.info(r.detail);
    if (!keepRaw) conflictRaw = false;
    // A resolution rewrites the working file, so any cached preview of it is now a picture of
    // something that no longer exists.
    if (r && r.path) CONFLICT_IMAGES.delete(r.path);
    await refreshConflicts();
    await load();
    return r;
  } catch (e) {
    toast(e.message, 'bad');
    throw e;
  } finally { busy(false); }
}

function selectConflict(file) {
  if (SEL.conflict === file) return;
  SEL.conflict = file;
  CONFLICT_DETAIL = null;
  conflictRaw = false; conflictRawDraft = '';
  conflictDetailError = null;
  CONFLICT_HAND.clear();
  // renderPane() starts the fetch and redraws when it lands; doing it here as well would
  // issue the same request twice for every click in the file list.
  renderSide(); renderPane();
}

/* ── the side descriptor, which is the point of the whole view ───── */

const AGE_TITLE = {
  newer: 'the more recently committed of the two',
  older: 'the older of the two',
};

/*
 * One side of a conflict, described by where it came from rather than by which marker
 * introduced it. The marker is still printed — someone comparing this to their editor needs
 * to line the two up — but it is the last line of the card, not the first.
 */
function sideCard(side, { position, compact = false } = {}) {
  if (!side) return null;
  return h('div', { class: 'cside c-' + side.key },
    h('div', { class: 'k' }, position, side.age ? h('span', { class: 'agechip ' + side.age, title: AGE_TITLE[side.age] }, side.age) : null),
    h('div', { class: 'n', title: side.name }, side.name),
    h('div', { class: 'r' }, side.role),
    compact ? null : h('div', { class: 'm' },
      [side.short, side.author, side.date ? ago(side.date) : null].filter(Boolean).join(' · ') || 'no commit recorded'),
    compact ? null : (side.subject ? h('div', { class: 'm sub', title: side.subject }, side.subject) : null),
    side.hint ? h('div', { class: 'hint' }, side.hint) : null,
    h('div', { class: 'mk' }, 'marked ', h('code', {}, side.marker), ' in the file'));
}

/* The paragraph that says which block is which, and shouts when a rebase has flipped them. */
function directionBox(op) {
  if (!op) return null;
  return h('div', { class: 'cdir' + (op.swapped ? ' swapped' : '') },
    h('div', { class: 'lab' }, op.swapped ? 'Sides are reversed in this operation' : 'Which block is which'),
    h('div', { class: 'why' }, op.direction),
    op.note ? h('div', { class: 'why note' }, op.note) : null,
    op.octopus ? h('div', { class: 'why note' },
      `This merge brings in ${op.octopus} branches at once, so the second block may come from any of them.`) : null);
}

/* ── sidebar ─────────────────────────────────────────────────────── */

const KIND_SHORT = {
  'both-modified': 'both changed',
  'both-added': 'both added',
  'both-deleted': 'both deleted',
  'added-by-us': 'added here',
  'added-by-them': 'added there',
  'deleted-by-us': 'deleted here',
  'deleted-by-them': 'deleted there',
};

function sideConflicts(body, foot) {
  if (!CONFLICTS) {
    if (conflictsError) {
      body.append(conflictFailure(conflictsError, () => {
        conflictsError = null; renderSide(); renderPane();
      }));
      return;
    }
    body.append(h('div', { class: 'empty' }, 'Reading the conflict…'));
    if (!conflictsLoading) refreshConflicts().then(() => { renderSide(); renderPane(); });
    return;
  }
  const c = CONFLICTS;
  const op = c.operation;

  body.append(h('div', { class: 'cophead' },
    h('div', { class: 'lab' }, op.kind + ' in progress'),
    h('div', { class: 't' }, op.headline)));

  if (!c.files.length) {
    body.append(h('div', { class: 'empty' }, c.canFinish
      ? 'Every conflict is resolved.\nFinish the ' + op.kind + ' below.'
      : 'Nothing is conflicted.'));
  } else {
    body.append(h('div', { class: 'cprog' },
      h('span', {}, `${c.ready} of ${c.total} ready`),
      h('i', { style: { width: (c.total ? Math.round((c.ready / c.total) * 100) : 0) + '%' } })));

    c.files.forEach(f => body.append(h('div', {
      class: 'frow cfrow' + (f.ready ? ' done' : ''), 'aria-selected': String(SEL.conflict === f.path),
      onclick: () => selectConflict(f.path),
    },
      h('span', { class: 'tick', title: f.ready ? 'no conflict markers left' : 'still has conflicts' },
        f.ready ? '✓' : '●'),
      h('span', { class: 'p', title: f.path }, f.path),
      /*
       * The count is only meaningful for a file that has markers to count.
       *
       * Keyed off `expectMarkers` alone this printed "0×" beside every conflicted image,
       * which reads as "zero conflicts" — the opposite of true, on a row that will not go
       * away. A binary file has no marker count, so it shows what KIND of conflict it is;
       * and one whose sides hold the same bytes says so, because that is the whole story.
       */
      h('span', {
        class: 's conf' + (f.identical ? ' same' : ''),
        title: f.identical && f.note ? f.note.headline : f.title,
      },
      f.identical ? 'same bytes'
        : (f.expectMarkers && !f.binary && !f.tooBig && !f.missing && !f.ready)
          ? f.hunks + '×'
          : (KIND_SHORT[f.kind] || f.kind)))));
  }

  /*
   * Continue is the only button here that can move history, so it states what it will do and
   * stays disabled with a reason until it can actually do it. "Continue" greyed out with no
   * explanation is the exact moment people give up on a GUI and open a terminal.
   */
  const canGo = c.canContinue || c.canFinish;
  const go = h('button', {
    class: 'btn primary wide', disabled: !canGo,
    title: canGo ? c.continueLabel
      : `${c.remaining} file${c.remaining === 1 ? '' : 's'} still need a decision`,
  }, c.continueLabel);
  go.addEventListener('click', async () => {
    const r = await conflictAct(() => api('/api/git/conflict/continue', {}));
    if (r && r.done) { VIEW = 'changes'; SEL.conflict = null; render(); }
  });
  foot.append(go);
  if (!canGo && c.files.length) {
    foot.append(h('div', { class: 'lab note' },
      `${c.remaining} file${c.remaining === 1 ? '' : 's'} still conflicted.`));
  }
  if (c.canSkip) {
    foot.append(arm(h('button', { class: 'btn wide' }, 'Skip this commit'),
      'Skip this commit', 'Skip — the commit is dropped',
      () => conflictAct(() => api('/api/git/conflict/skip', {}))));
  }
  if (c.canAbort) {
    foot.append(arm(h('button', { class: 'btn danger wide' }, `Abort the ${op.kind}`),
      `Abort the ${op.kind}`, 'Abort — really?',
      async () => {
        await act(() => api('/api/git/merge-abort', {}), 'git');
        VIEW = 'changes'; SEL.conflict = null;
        CONFLICTS = null; CONFLICT_DETAIL = null;
        render();
      }));
  }
}

/* ── main pane ───────────────────────────────────────────────────── */

function paneConflicts(p) {
  if (!CONFLICTS) {
    p.append(conflictsError
      ? conflictFailure(conflictsError, () => { conflictsError = null; renderSide(); renderPane(); })
      : h('div', { class: 'empty' }, 'Reading the conflict…'));
    return;
  }
  const op = CONFLICTS.operation;
  const wrap = h('div', { class: 'conflicts' });

  wrap.append(h('div', { class: 'sec-head' },
    h('h2', {}, 'Resolve conflicts'),
    h('p', {}, op.headline + '. Each block below says which branch it came from — pick the ' +
      'one that should survive, or combine them by hand.')));

  wrap.append(directionBox(op));
  wrap.append(h('div', { class: 'clegend' },
    sideCard(op.ours, { position: 'First block' }),
    op.base ? sideCard(op.base, { position: 'Common ancestor' }) : null,
    sideCard(op.theirs, { position: 'Second block' })));

  if (!CONFLICTS.files.length) {
    wrap.append(h('div', { class: 'empty' }, CONFLICTS.canFinish
      ? 'Every conflict is resolved. Finish the ' + op.kind + ' from the sidebar.'
      : 'Nothing is conflicted right now.'));
    return p.append(wrap);
  }
  if (!SEL.conflict) {
    wrap.append(h('div', { class: 'empty' }, 'Pick a file on the left.'));
    return p.append(wrap);
  }
  const d = CONFLICT_DETAIL;
  if (!d || d.path !== SEL.conflict) {
    if (conflictDetailError) {
      wrap.append(conflictFailure(conflictDetailError, () => { conflictDetailError = null; renderPane(); }));
      return p.append(wrap);
    }
    wrap.append(h('div', { class: 'empty' }, 'Loading ' + SEL.conflict + '…'));
    p.append(wrap);
    loadConflictDetail(SEL.conflict).then(() => renderPane());
    return;
  }

  wrap.append(conflictFileHead(d));
  if (conflictRaw) { wrap.append(conflictRawEditor(d)); return p.append(wrap); }

  /*
   * Said before anything else, because it is the answer to "why is this a conflict at all".
   * When both sides hold the same bytes there is nothing to compare and nothing to weigh —
   * the dispute is about where the file lives, and every panel below would show two identical
   * things and leave the person hunting for a difference that does not exist.
   */
  if (d.note && d.note.identical) {
    wrap.append(h('div', { class: 'csame' },
      h('b', {}, d.note.headline), h('div', { class: 'why' }, d.note.detail)));
  }

  if (d.image) {
    wrap.append(conflictImages(d, op));
    return p.append(wrap);
  }
  if (d.binary || d.tooBig) {
    wrap.append(h('div', { class: 'banner warn' },
      h('b', {}, d.binary ? 'This file is binary. ' : 'This file is too large to edit here. '),
      'Pick a whole-file option above, or resolve it in your editor and mark it resolved.'));
    return p.append(wrap);
  }
  if (!d.expectMarkers) {
    wrap.append(h('div', { class: 'banner' },
      h('b', {}, d.title + '. '),
      'There is nothing inside the file to choose between — the disagreement is about whether ' +
      'the file should exist at all. Use one of the options above.'));
    return p.append(wrap);
  }
  if (!d.hunks.length) {
    wrap.append(h('div', { class: 'cready' },
      h('b', {}, 'No conflict markers left in this file. '),
      'Mark it resolved when you are happy with it — nothing is recorded until you do.',
      h('div', { class: 'acts' },
        h('button', {
          class: 'btn primary sm',
          onclick: () => conflictAct(() => api('/api/git/conflict/mark', { files: [d.path] })),
        }, 'Mark resolved'),
        arm(h('button', { class: 'btn sm' }, 'Put the conflict back'),
          'Put the conflict back', 'Discard my edits and restore the markers',
          () => conflictAct(() => api('/api/git/conflict/reopen', { file: d.path }))))));
    return p.append(wrap);
  }

  d.hunks.forEach(hunk => wrap.append(hunkCard(d, hunk, op)));
  p.append(wrap);
}

/*
 * An image conflict, shown as pictures in the same three columns the text view uses.
 *
 * Same column order, same tints, same branch names in the headers — an art conflict and a
 * code conflict are the same decision about the same two branches, and making them look
 * different would mean learning the layout twice.
 *
 * The versions load lazily and the node is cached on the detail, because a repaint happens on
 * every hover-free re-render and re-fetching a few hundred KB of base64 each time would make
 * the panel flicker.
 */
function conflictImages(d, op) {
  const box = h('div', { class: 'imgconflict' });
  const cached = CONFLICT_IMAGES.get(d.path);
  if (!cached) {
    box.append(h('div', { class: 'empty' }, 'Loading images…'));
    if (conflictImagesFor !== d.path) {
      conflictImagesFor = d.path;
      loadImage(d.path, ['base', 'ours', 'theirs'])
        .then(r => { CONFLICT_IMAGES.set(d.path, r.versions); })
        .catch(e => { CONFLICT_IMAGES.set(d.path, { error: e.message }); })
        .finally(() => { conflictImagesFor = null; if (VIEW === 'conflicts') renderPane(); });
    }
    return box;
  }
  if (cached.error) {
    box.append(h('div', { class: 'banner' }, h('b', {}, 'Could not load the images. '), cached.error));
    return box;
  }
  const pick = (side) => conflictAct(() => api('/api/git/conflict/file', { file: d.path, option: side }));
  const col = (side, version, label, role, tint, action) => {
    const card = imageCard(label, role, version, { tint });
    if (action) card.append(h('div', { class: 'iact' }, action));
    return card;
  };
  box.append(h('div', { class: 'imgrow three' },
    col('ours', cached.ours, op.ours.name, op.ours.role, 'ours',
      h('button', {
        class: 'btn sm wide', title: `Discard the ${op.theirs.name} version of this file`,
        onclick: () => pick('ours'),
      }, 'Use this')),
    cached.base ? col('base', cached.base, op.base ? op.base.name : 'Common ancestor',
      'What both sides started from', 'base', null) : null,
    col('theirs', cached.theirs, op.theirs.name, op.theirs.role, 'theirs',
      h('button', {
        class: 'btn sm wide', title: `Discard the ${op.ours.name} version of this file`,
        onclick: () => pick('theirs'),
      }, 'Use this'))));

  // Dimension changes are the thing you most want flagged and least likely to spot by eye at
  // preview scale, so they get said in words rather than left to the two labels underneath.
  const o = cached.ours, t = cached.theirs;
  if (o && t && o.width && t.width && (o.width !== t.width || o.height !== t.height)) {
    box.append(h('div', { class: 'banner warn' },
      h('b', {}, 'These are different sizes. '),
      `${op.ours.name} is ${o.width}×${o.height}, ${op.theirs.name} is ${t.width}×${t.height}. ` +
      'Check whatever references this asset before picking the smaller one.'));
  }
  return box;
}

/* The per-file header: what kind of conflict, and the actions that apply to all of it. */
function conflictFileHead(d) {
  const acts = h('div', { class: 'acts' });
  d.options.forEach(o => {
    const run = () => conflictAct(() => api('/api/git/conflict/file', { file: d.path, option: o.id }));
    // A destructive option removes the file from the index, and with it the recorded stages
    // that make "put the conflict back" possible. Those get the two-stage confirm.
    acts.append(o.destructive
      ? arm(h('button', { class: 'btn sm', title: o.hint }, o.label), o.label, 'Confirm — cannot be reopened', run)
      : h('button', { class: 'btn sm', title: o.hint, onclick: run }, o.label));
  });
  if (d.expectMarkers && !d.binary && !d.tooBig) {
    acts.append(h('button', {
      class: 'btn sm', title: 'Rewrite this file yourself, markers and all',
      onclick: () => { conflictRaw = true; conflictRawDraft = d.content || ''; renderPane(); },
    }, 'Edit the whole file'));
    /*
     * Re-running the conflict with diff3 is the single most useful thing you can do to a
     * conflict you cannot read: it inserts what BOTH sides started from, which turns "which
     * of these two do I want" into "what did each side actually change". It rewrites the
     * file, so any hand edits go — hence the confirm.
     */
    acts.append(arm(h('button', {
      class: 'btn sm',
      title: 'Regenerate the markers with the common ancestor between the two sides',
    }, 'Show the ancestor'), 'Show the ancestor', 'Rewrite the file — my edits go',
    () => conflictAct(() => api('/api/git/conflict/reopen', { file: d.path, withAncestor: true }))));
  }
  if (assistantAvailable() && d.hunks.length) {
    acts.append(conflictAiBusy
      ? h('button', {
        class: 'btn sm danger',
        onclick: () => { if (CONFLICT_JOB) api('/api/ai/cancel', { jobId: CONFLICT_JOB }).catch(() => {}); },
      }, h('span', { class: 'spin' }), 'Reading — cancel')
      : h('button', {
        class: 'btn sm primary',
        title: 'The assistant reads both sides and suggests a resolution for each conflict. ' +
          'It never applies anything itself.',
        onclick: () => runConflictAi(d.path, null),
      }, 'Ask the assistant'));
  }

  return h('div', { class: 'cfilehead' },
    h('div', { class: 'top' },
      h('span', { class: 't', title: d.path }, d.path),
      h('span', { class: 'chip risk' }, d.title)),
    d.expectMarkers && d.hunks.length
      ? h('div', { class: 'lab' }, `${d.hunks.length} conflict${d.hunks.length === 1 ? '' : 's'} in this file`)
      : null,
    acts);
}

/*
 * One conflict, side by side.
 *
 * Each column carries the branch name in its own header rather than relying on the legend at
 * the top of the page — by the time you have scrolled to the fourth conflict in a file the
 * legend is long gone, and that is exactly when picking the wrong side becomes easy.
 */
function hunkCard(d, hunk, op) {
  const key = conflictKey(d.path, hunk.index);
  const apply = (choice, textValue) => conflictAct(() => api('/api/git/conflict/hunks', {
    file: d.path, fingerprint: d.fingerprint,
    choices: [{ index: hunk.index, choice, text: textValue }],
  }));

  const column = (side, lines, { label, choice, hint }) => h('div', { class: 'cpane c-' + side.key },
    h('div', { class: 'ch' },
      h('span', { class: 'n', title: side.name }, side.name),
      side.age ? h('span', { class: 'agechip ' + side.age, title: AGE_TITLE[side.age] }, side.age) : null),
    h('div', { class: 'rr' }, side.role),
    h('pre', {}, ...(lines.length ? lines : ['(nothing on this side)']).map(l => h('span', { class: 'dl' }, l || ' '))),
    h('button', { class: 'btn sm wide', title: hint, onclick: () => apply(choice) }, label));

  const cols = h('div', { class: 'cbody' + (hunk.base ? ' three' : '') },
    column(op.ours, hunk.ours, {
      label: 'Keep this', choice: 'ours',
      hint: `Discard the ${op.theirs.name} version of these lines`,
    }),
    hunk.base ? h('div', { class: 'cpane c-base' },
      h('div', { class: 'ch' }, h('span', { class: 'n' }, op.base ? op.base.name : 'Common ancestor')),
      h('div', { class: 'rr' }, 'What both sides started from'),
      h('pre', {}, ...(hunk.base.length ? hunk.base : ['(nothing here originally)']).map(l => h('span', { class: 'dl' }, l || ' '))),
      h('button', {
        class: 'btn sm wide', title: 'Throw away both changes and go back to the original',
        onclick: () => apply('base'),
      }, 'Revert to this')) : null,
    column(op.theirs, hunk.theirs, {
      label: 'Keep this', choice: 'theirs',
      hint: `Discard the ${op.ours.name} version of these lines`,
    }));

  const handOpen = CONFLICT_HAND.has(key);
  const extras = h('div', { class: 'cacts' },
    h('button', {
      class: 'btn sm', title: `${op.ours.name} first, then ${op.theirs.name}`,
      onclick: () => apply('both'),
    }, 'Keep both'),
    h('button', {
      class: 'btn sm', title: `${op.theirs.name} first, then ${op.ours.name}`,
      onclick: () => apply('both-reversed'),
    }, 'Keep both, other order'),
    h('button', {
      class: 'btn sm', onclick: () => {
        if (handOpen) CONFLICT_HAND.delete(key); else CONFLICT_HAND.add(key);
        renderPane();
      },
    }, handOpen ? 'Close the editor' : 'Write it myself'),
    assistantAvailable() && !conflictAiBusy
      ? h('button', { class: 'btn sm', onclick: () => runConflictAi(d.path, hunk.index) }, 'Ask about this one')
      : null);

  const card = h('div', { class: 'chunk' },
    h('div', { class: 'chead' },
      h('span', { class: 'n' }, `Conflict ${hunk.n} of ${d.hunks.length}`),
      h('span', { class: 'lab' }, `lines ${hunk.startLine}–${hunk.endLine}`),
      hunk.identical ? h('span', { class: 'chip' }, 'both sides are identical here') : null),
    hunk.context.before.length
      ? h('pre', { class: 'cctx' }, ...hunk.context.before.map(l => h('span', { class: 'dl' }, l || ' '))) : null,
    cols,
    hunk.context.after.length
      ? h('pre', { class: 'cctx' }, ...hunk.context.after.map(l => h('span', { class: 'dl' }, l || ' '))) : null,
    extras);

  const suggestion = CONFLICT_AI.get(key);
  if (suggestion) card.append(suggestionCard(d, hunk, op, suggestion));
  if (handOpen) card.append(handEditor(d, hunk, op, apply));
  /* Git's own marker text, last and quiet. Useful only for lining this screen up against the
     same file open in an editor — which is why it is a footnote and not a label. */
  if (hunk.labels && (hunk.labels.ours || hunk.labels.theirs)) {
    card.append(h('div', { class: 'lab note mk' },
      'In the file: ', h('code', {}, '<<<<<<< ' + (hunk.labels.ours || '')),
      ' … ', h('code', {}, '>>>>>>> ' + (hunk.labels.theirs || ''))));
  }
  return card;
}

/*
 * The hand-written resolution. Pre-filled with BOTH sides, because the edit people actually
 * want to make is nearly always "keep these lines, drop those" — starting from one side
 * means retyping the other from a pane you can no longer see.
 */
function handEditor(d, hunk, op, apply) {
  const id = 'hand-' + hunk.index;
  const box = h('textarea', {
    id, class: 'handedit', spellcheck: 'false',
    rows: String(Math.min(24, Math.max(6, hunk.ours.length + hunk.theirs.length + 2))),
  }, hunk.ours.concat(hunk.theirs).join('\n'));
  return h('div', { class: 'chand' },
    h('div', { class: 'lab' }, `Both sides, ${op.ours.name} first. Delete what should not survive.`),
    box,
    h('div', { class: 'acts' },
      h('button', {
        class: 'btn sm primary',
        onclick: () => apply('custom', $(id).value),
      }, 'Use this'),
      h('button', {
        class: 'btn sm',
        onclick: () => { CONFLICT_HAND.delete(conflictKey(d.path, hunk.index)); renderPane(); },
      }, 'Cancel')));
}

/*
 * A suggestion, not a resolution.
 *
 * It shows the exact text it would leave behind and applies through the same endpoint the
 * manual buttons use, so accepting the model's answer and making the choice yourself are
 * literally the same operation. "Unsure" is rendered as a real answer rather than hidden,
 * because on a genuine semantic conflict it is the correct one.
 */
function suggestionCard(d, hunk, op, s) {
  const key = conflictKey(d.path, hunk.index);
  const drop = () => { CONFLICT_AI.delete(key); renderPane(); };
  const preview = s.choice === 'ours' ? hunk.ours.join('\n')
    : s.choice === 'theirs' ? hunk.theirs.join('\n')
      : s.choice === 'both' ? hunk.ours.concat(hunk.theirs).join('\n')
        : s.text || '';
  const named = s.choice === 'ours' ? `Keep ${op.ours.name}`
    : s.choice === 'theirs' ? `Keep ${op.theirs.name}`
      : s.choice === 'both' ? 'Keep both sides'
        : s.choice === 'custom' ? 'Combine the two'
          : 'No confident answer';

  const box = h('div', { class: 'csuggest' + (s.choice === 'unsure' ? ' unsure' : '') },
    h('div', { class: 'h' },
      h('span', { class: 'lab' }, 'Assistant suggests'),
      h('span', { class: 'n' }, named),
      confChip(s.confidence)),
    s.why ? h('div', { class: 'why' }, s.why) : null);

  if (s.choice === 'unsure') {
    box.append(h('div', { class: 'why note' },
      'Both sides changed the same lines for different reasons, so this one is yours to decide.'),
      h('div', { class: 'acts' }, h('button', { class: 'btn sm', onclick: drop }, 'Dismiss')));
    return box;
  }
  box.append(
    h('pre', { class: 'cprev' }, ...preview.split('\n').map(l => h('span', { class: 'dl' }, l || ' '))),
    h('div', { class: 'acts' },
      h('button', {
        class: 'btn sm primary',
        onclick: () => conflictAct(() => api('/api/git/conflict/hunks', {
          file: d.path, fingerprint: d.fingerprint,
          choices: [{ index: hunk.index, choice: s.choice, text: s.text }],
        })),
      }, 'Use this'),
      h('button', {
        class: 'btn sm',
        title: 'Open it in the editor so you can change it before applying',
        onclick: () => {
          CONFLICT_HAND.add(key); renderPane();
          const box2 = $('hand-' + hunk.index);
          if (box2) { box2.value = preview; box2.focus(); }
        },
      }, 'Edit it first'),
      h('button', { class: 'btn sm', onclick: drop }, 'Dismiss')));
  return box;
}

/* Whole-file hand editing, for when the conflict is really one edit spanning several hunks. */
function conflictRawEditor(d) {
  const box = h('textarea', {
    id: 'craw', class: 'handedit tall', spellcheck: 'false',
    oninput: (e) => { conflictRawDraft = e.target.value; },
  }, conflictRawDraft);
  const save = (force) => conflictAct(() => api('/api/git/conflict/text', {
    file: d.path, text: $('craw').value, fingerprint: d.fingerprint, force,
  }));
  return h('div', { class: 'chand whole' },
    h('div', { class: 'lab' }, 'Editing ' + d.path + ' as text, markers and all. ' +
      'Saving checks that nobody else changed it while you were typing.'),
    box,
    h('div', { class: 'acts' },
      h('button', { class: 'btn sm primary', onclick: () => save(false) }, 'Save'),
      h('button', { class: 'btn sm', title: 'Save even though conflict markers are still in it', onclick: () => save(true) }, 'Save, keep the markers'),
      h('button', {
        class: 'btn sm',
        onclick: () => { conflictRaw = false; conflictRawDraft = d.content || ''; renderPane(); },
      }, 'Cancel')));
}

/*
 * Ask the model. One conflict or all of them in the file; the answers land beside the hunks
 * they belong to rather than in a chat pane, because a suggestion you have to scroll away
 * from to apply is a suggestion you will apply to the wrong hunk.
 */
async function runConflictAi(file, hunkIndex) {
  if (conflictAiBusy || !assistantAvailable()) return;
  const repoPath = S && S.selected && S.selected.path;
  conflictAiBusy = true;
  CONFLICT_JOB = newJobId();
  renderPane();
  try {
    const r = await api('/api/ai/resolve-conflict', {
      file, hunk: hunkIndex == null ? null : hunkIndex, jobId: CONFLICT_JOB,
    });
    if (!S || !S.selected || S.selected.path !== repoPath) return;
    if (r.cancelled) { toast(r.message, ''); return; }
    (r.hunks || []).forEach(s => CONFLICT_AI.set(conflictKey(file, s.index), s));
    toast(r.message, 'good');
  } catch (e) {
    toast(e.message, 'bad');
  } finally {
    conflictAiBusy = false;
    CONFLICT_JOB = null;
    if (VIEW === 'conflicts') renderPane();
  }
}

/* ── image previews ──────────────────────────────────────────────── */
/*
 * A diff of a sprite is useless; the picture is the diff. Shared by Changes and Conflicts so
 * an asset looks the same in both, and so the "is this the 32×32 or the 64×64 re-export"
 * question has one answer in one place.
 *
 * Must match the server's allowlist in lib/images.js. SVG is deliberately absent — it is
 * markup that can carry script, so it stays on the text-diff path where it reads fine anyway.
 */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico)$/i;
const isImagePath = (p) => IMAGE_EXT.test(String(p || ''));

const fmtBytes = (n) => (n == null ? '—'
  : n < 1024 ? n + ' B'
    : n < 1024 * 1024 ? (n / 1024).toFixed(1) + ' KB'
      : (n / (1024 * 1024)).toFixed(1) + ' MB');

async function loadImage(file, sides) {
  return api('/api/git/image?file=' + encodeURIComponent(file) +
    '&sides=' + encodeURIComponent(sides.join(',')));
}

/*
 * One version of an image, with the facts that decide an art conflict printed under it.
 *
 * `checker` matters more than it looks: half of these are sprites with transparent
 * backgrounds, and against a flat panel a transparent region and a filled one of the same
 * colour are indistinguishable. `pixelated` matters for the same reason — smoothing a 32×32
 * tile up to preview size hides exactly the single-pixel differences being looked for.
 */
function imageCard(label, sublabel, v, { tint = null } = {}) {
  const card = h('div', { class: 'imgcard' + (tint ? ' c-' + tint : '') },
    h('div', { class: 'ch' },
      h('span', { class: 'n', title: label }, label),
      sublabel ? h('span', { class: 'lab' }, sublabel) : null));

  if (!v) {
    card.append(h('div', { class: 'imgbox empty' }, 'does not exist on this side'));
    return card;
  }
  if (v.unreadable) {
    card.append(h('div', { class: 'imgbox empty' }, 'not a readable image'));
  } else if (v.tooBig) {
    card.append(h('div', { class: 'imgbox empty' },
      'too large to preview (' + fmtBytes(v.bytes) + ')'));
  } else {
    card.append(h('div', { class: 'imgbox' },
      h('img', { src: v.data, alt: label, loading: 'lazy' })));
  }
  card.append(h('div', { class: 'imeta' },
    h('span', {}, v.width && v.height ? v.width + ' × ' + v.height : 'size unknown'),
    h('span', {}, fmtBytes(v.bytes))));
  if (v.mismatched) {
    card.append(h('div', { class: 'imeta warn' },
      'The contents are ' + v.mime + ', not ' + v.declared + ' as the extension claims.'));
  }
  return card;
}

/* The Changes view: what this file looked like before, and what it looks like now. */
async function imageDiffPane(p, file, status) {
  p.append(h('div', { class: 'empty' }, 'Loading image…'));
  let r;
  try { r = await loadImage(file, ['head', 'worktree']); }
  catch (e) {
    return clear(p).append(h('div', { class: 'banner' }, h('b', {}, 'Could not load image. '), e.message));
  }
  clear(p);
  const before = r.versions.head, after = r.versions.worktree;
  const same = before && after && before.bytes === after.bytes && before.data === after.data;
  p.append(h('div', { class: 'imgpane' },
    h('div', { class: 'diff-head' },
      h('span', {}, file),
      h('span', { class: 'lab' }, status === 'untracked' ? 'new file' : 'vs HEAD')),
    same ? h('div', { class: 'cbanner' },
      h('b', {}, 'Identical. '), 'The file is recorded as changed but its bytes match HEAD — ' +
      'usually a mode or timestamp change.') : null,
    h('div', { class: 'imgrow' },
      status === 'untracked' ? null : imageCard('Before', 'HEAD', before),
      imageCard(status === 'deleted' ? 'Deleted' : 'Now', 'working tree', after))));
}

/* ── shared diff renderer ────────────────────────────────────────── */
/*
 * Conflict markers are diff content, so without special handling they render as ordinary
 * additions: "<<<<<<< HEAD" comes out green, exactly like a line someone chose to write.
 * Marking them — and tinting the two sides between them — is the difference between reading
 * a conflict and reading a diff that happens to contain seven angle brackets.
 */
const CONFLICT_START = /^[+ -]?<{7}(\s|$)/;
const CONFLICT_BASE = /^[+ -]?\|{7}(\s|$)/;
const CONFLICT_MID = /^[+ -]?={7}(\s|$)/;
const CONFLICT_END = /^[+ -]?>{7}(\s|$)/;

function diffBlock(patch, label, { conflicted = false } = {}) {
  const pre = h('pre', {});
  const lines = String(patch || '').split('\n');
  let side = null;                      // 'ours' | 'base' | 'theirs' while inside a conflict
  let conflicts = 0;
  lines.slice(0, 4000).forEach(l => {
    let cls = '';
    if (CONFLICT_START.test(l)) { side = 'ours'; conflicts++; cls = 'cmark'; }
    else if (CONFLICT_BASE.test(l) && side) { side = 'base'; cls = 'cmark'; }
    else if (CONFLICT_MID.test(l) && side) { side = 'theirs'; cls = 'cmark'; }
    else if (CONFLICT_END.test(l) && side) { cls = 'cmark'; side = null; }
    else if (side) cls = 'c' + side;
    else if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ')) cls = 'meta';
    else if (l.startsWith('@@')) cls = 'hunk';
    else if (l.startsWith('+')) cls = 'add';
    else if (l.startsWith('-')) cls = 'del';
    pre.append(h('span', { class: 'dl ' + cls }, l || ' '));
  });
  const showConflict = conflicted || conflicts > 0;
  return h('div', { class: 'diff' + (showConflict ? ' has-conflict' : '') },
    h('div', { class: 'diff-head' }, h('span', {}, label || ''),
      h('span', { class: 'lab' }, lines.length > 4000 ? 'truncated at 4000 lines' : lines.length + ' lines')),
    showConflict
      ? h('div', { class: 'cbanner' },
        h('b', {}, conflicts ? `${conflicts} conflict${conflicts === 1 ? '' : 's'} in this file. ` : 'This file is conflicted. '),
        'Everything between ', h('code', {}, '<<<<<<<'), ' and ', h('code', {}, '======='),
        ' is yours; below it, up to ', h('code', {}, '>>>>>>>'), ', is theirs. ',
        'Delete the markers and the side you do not want, then stage the file.')
      : null,
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
  /*
   * The repository's own pull request template, prefilled.
   *
   * A PULL_REQUEST_TEMPLATE.md is a checklist the maintainers want ticked before they read
   * the diff, and opening a PR from here used to skip it silently. Prefilled rather than
   * offered as a picker because, unlike issues, almost every repository has exactly one —
   * and a single-option chooser is a worse way of saying "here it is".
   */
  if (!TEMPLATES) loadTemplates().then(t => { if (t && t.pr.length) renderPane(); });
  else if (TEMPLATES.pr.length) body.value = TEMPLATES.pr[0].body || '';
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
    h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Description'), body,
      TEMPLATES && TEMPLATES.pr.length
        ? h('span', { class: 'lab', style: { textTransform: 'none', letterSpacing: '0' } },
          'Prefilled from ' + TEMPLATES.pr[0].source + ' — this repository\'s pull request template.')
        : null),
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
        onclick: async (e) => {
          e.stopPropagation(); closePop();
          // A conflicted merge succeeds as an operation and fails as an outcome, so it comes
          // back ok:true carrying its own recipe rather than throwing into act()'s catch.
          const r = await act(() => api('/api/git/merge', { branch: b.name }), 'git');
          /* Conflicts are the expected outcome of a merge often enough to be worth going
             straight to, rather than leaving as a red count on a nav item. */
          if (r && r.conflicted) {
            VIEW = 'conflicts'; SEL.conflict = null;
            await refreshConflicts();
            render();
          } else if (r && r.recovery) showRecovery(r.message, r.recovery);
        },
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
  add('Do', 'Switch theme', 'system → light → dark', () => cycleTheme());

  /*
   * The bulk keys are also commands, so the palette is where you find out they exist. A
   * shortcut nobody can discover is a shortcut for whoever wrote it.
   */
  add('Select', 'Select all visible issues', 'a', () => { VIEW = 'issues'; render(); pickAllVisible(); });
  add('Select', 'Clear the selection', 'd or esc', () => clearPicked(), !!PICKED.size);
  add('Select', 'Set milestone on selected', 'm', () => openBulkMenu('milestone'), !!PICKED.size);
  add('Select', 'Add label to selected', 'l', () => openBulkMenu('label'), !!PICKED.size);
  add('Select', 'Remove label from selected', 'shift+L', () => openBulkMenu('unlabel'), !!PICKED.size);

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

/*
 * The state a merge leaves behind.
 *
 * The conflict count was computed on the server and shipped in every state payload, and the
 * front-end never read it — so the only time anyone saw it was in the toast right after the
 * merge, which vanished. After a reload you were left with a pile of files marked "conf" and
 * nothing saying you were mid-merge or that abort was an option.
 */
function mergeBanner() {
  const g = S && S.git;
  if (!g) return null;
  const merging = g.merge && g.merge.inProgress;
  const conflicts = (g.status && g.status.conflicted) || 0;
  if (!merging && !conflicts) return null;
  const kind = (g.merge && g.merge.kind) || 'merge';
  const box = h('div', { class: 'mergebar' },
    h('div', { class: 'lab' }, `${kind} in progress`),
    h('div', { class: 'why' }, conflicts
      ? `${conflicts} file${conflicts === 1 ? '' : 's'} still conflicted.`
      : 'All conflicts are resolved — commit to finish it.'));
  const acts = h('div', { class: 'acts' });
  /* The banner's job is to hand off, not to explain. Resolving is a whole view now, and it
     knows which side is which — which this three-line box cannot say without lying by
     omission on a rebase. */
  if (conflicts) {
    acts.append(h('button', {
      class: 'btn sm primary',
      onclick: () => { VIEW = 'conflicts'; render(); refreshConflicts().then(() => { renderSide(); renderPane(); }); },
    }, `Resolve ${conflicts} conflict${conflicts === 1 ? '' : 's'}`));
  }
  if (merging) {
    acts.append(arm(h('button', { class: 'btn sm danger' }, `Abort ${kind}`), `Abort ${kind}`, 'Abort — really?',
      () => act(() => api('/api/git/merge-abort', {}), 'git')));
  }
  if (acts.childNodes.length) box.append(acts);
  return box;
}

/* ── theme ───────────────────────────────────────────────────────── */
/*
 * Three states, not two. "System" has to be its own selectable value rather than the absence
 * of a choice, because someone who deliberately wants to follow the OS should be able to get
 * back there after trying dark — and with only a light/dark pair, they cannot.
 *
 * The chosen value is applied by the boot script in index.html before first paint; this only
 * has to handle changes made after load. localStorage is the right home for it: it is a
 * per-browser display preference, not something the server should hold per-repository.
 */
const THEMES = ['system', 'light', 'dark'];
const THEME_GLYPH = { system: '◐', light: '☀', dark: '☾' };
const THEME_TITLE = {
  system: 'Theme: following your system setting',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

function readTheme() {
  try {
    const v = localStorage.getItem('vibe-git.theme');
    return THEMES.includes(v) ? v : 'system';
  } catch { return 'system'; }        // private mode, or storage disabled
}

function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  try {
    if (mode === 'system') localStorage.removeItem('vibe-git.theme');
    else localStorage.setItem('vibe-git.theme', mode);
  } catch { /* the attribute still holds for this session */ }
  const btn = $('btn-theme');
  if (btn) { btn.textContent = THEME_GLYPH[mode]; btn.title = THEME_TITLE[mode]; }
}

function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(readTheme()) + 1) % THEMES.length];
  applyTheme(next);
  toast(THEME_TITLE[next].replace('Theme: ', 'Theme — '), '');
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
  } else if (e.key === 'a') { e.preventDefault(); pickAllVisible(); }
  // Both spellings of "let go": Escape because it is the reflex, 'd' because the other
  // bulk keys are letters and reaching for Escape breaks the rhythm of j/k/x/a/d.
  else if ((e.key === 'Escape' || e.key === 'd') && PICKED.size) { e.preventDefault(); clearPicked(); }
  else if (e.key === 'm') { e.preventDefault(); openBulkMenu('milestone'); }
  else if (e.key === 'l') { e.preventDefault(); openBulkMenu('label'); }
  else if (e.key === 'L') { e.preventDefault(); openBulkMenu('unlabel'); }
});

/*
 * "Select all" means all VISIBLE issues, not all issues.
 *
 * The filter bar is the user's statement of what they are working on, and a key that
 * silently reached past it into closed or out-of-milestone issues would stage bulk edits
 * against work they cannot see. Selecting an already-complete set clears it instead, so the
 * same key toggles.
 */
function pickAllVisible() {
  const rows = visibleIssues();
  if (!rows.length) return toast('Nothing visible to select', 'bad');
  if (rows.every(i => PICKED.has(i.n))) return clearPicked();
  rows.forEach(i => PICKED.add(i.n));
  lastPicked = rows[rows.length - 1].n;
  renderIssueList();
  toast(`Selected ${rows.length} visible issue${rows.length === 1 ? '' : 's'}`, '');
}

/*
 * The bulk keys drive the SAME dropdowns the mouse uses rather than duplicating their
 * staging logic. Two code paths for "add a label to these twelve issues" is exactly how the
 * keyboard version quietly stops matching the button version.
 */
const BULK_MENU = { milestone: 0, label: 1, unlabel: 2 };

function openBulkMenu(which) {
  if (!PICKED.size) return toast('Select some issues first — press a, or x on a row', 'bad');
  const menus = document.querySelectorAll('#bulk-bar .bulk-select');
  const menu = menus[BULK_MENU[which]];
  if (!menu) return;
  menu.focus();
  // showPicker() opens the native list where supported; focus alone leaves the user needing
  // a second interaction, which defeats the point of a shortcut.
  if (typeof menu.showPicker === 'function') { try { menu.showPicker(); } catch { /* focused anyway */ } }
}

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

/*
 * The Conflicts view polls too, because resolving a conflict in a real editor is a normal
 * thing to do half-way through and the screen has to notice. It stops while an editor is open
 * here — replacing a textarea someone is typing into would be worse than being stale.
 */
async function refreshConflictsQuietly() {
  if (VIEW !== 'conflicts' || document.hidden) return;
  if (conflictRaw || CONFLICT_HAND.size || conflictAiBusy || busyCount) return;
  const before = JSON.stringify(CONFLICTS && CONFLICTS.files);
  const beforeFile = CONFLICT_DETAIL && CONFLICT_DETAIL.fingerprint;
  await refreshConflicts();
  const changed = JSON.stringify(CONFLICTS && CONFLICTS.files) !== before
    || (CONFLICT_DETAIL && CONFLICT_DETAIL.fingerprint) !== beforeFile;
  if (changed) { renderNav(); renderSide(); renderPane(); }
}

window.addEventListener('focus', () => refreshGit());
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshGit(); });
setInterval(() => { if (VIEW === 'changes' && !document.hidden) refreshGit(); }, 4000);
setInterval(() => { refreshConflictsQuietly(); }, 4000);
$('btn-refresh').addEventListener('click', async () => {
  await load({ fresh: true });
  // The explicit top-bar refresh means everything, including the issue fields used by
  // Plan cards. Background git polling remains local-only and keeps the issue cache.
  if (S && S.selected && S.selected.github && !S.githubError) await pullIssues();
});
$('btn-theme').addEventListener('click', () => cycleTheme());
$('btn-ai').addEventListener('click', () => toggleRail());
$('ai-close').addEventListener('click', () => toggleRail(false));
$('ai-tab-run').addEventListener('click', () => { RAIL_TAB = 'run'; renderRail(); });
$('ai-tab-chat').addEventListener('click', () => {
  RAIL_TAB = 'chat'; renderRail();
  const box = document.querySelector('.chat-in');
  if (box) box.focus();
});
$('ai-tab-set').addEventListener('click', () => { RAIL_TAB = 'settings'; renderRail(); });

/* The boot script already set the attribute; this syncs the button's glyph and tooltip. */
applyTheme(readTheme());

load();
