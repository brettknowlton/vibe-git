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
let S = null;                 // last server state
let VIEW = 'issues';
let SEL = { issue: null, file: null, commit: null };
const FILTER = { phase: null, milestone: null, q: '', state: 'open', un: false };
let CHECKED = new Set();      // files ticked for the next commit
const COMMIT_DRAFT = { subject: '', body: '' };

/* ── tiny DOM helper ─────────────────────────────────────────────── */
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
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
      if (r.issues) { S.issues = r.issues; S.issuesLoaded = true; S.issuesAt = r.issuesAt; stampNow(); }
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
    // First sight of a GitHub repo: pull issues once, in the background.
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
  PROPOSALS = []; SUGGESTIONS = []; MILESTONES = [];
  commitSummaryBusy = false; commitSummarySeq++;
  showHandledGaps = false; showHiddenPlan = false;
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
    S.issuesLoaded = true; S.issuesAt = r.issuesAt;
    if (r.insights) S.insights = r.insights;
    stampNow(); render();
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
  $('c-plan').textContent = S.insights ? S.insights.ranked.length : '—';
  $('c-changes').textContent = S.git ? S.git.status.files.length : '—';
  $('c-history').textContent = S.git ? S.git.log.length : '—';
  const cp = $('c-prs'); if (cp) cp.textContent = prLoaded ? PRS.length : '—';
  const q = $('c-staged');
  q.textContent = S.queue.length;
  q.classList.toggle('hot', S.queue.length > 0);
  const pip = $('ai-pip');
  if (pip) pip.className = aiBusy ? 'busy'
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
  return S.issues.filter(i => {
    if (FILTER.state === 'open' && i.st !== 'OPEN') return false;
    if (FILTER.state === 'closed' && i.st !== 'CLOSED') return false;
    if (FILTER.phase !== null && i.p !== FILTER.phase) return false;
    if (FILTER.milestone === '__none__' && i.ms) return false;
    if (FILTER.milestone && FILTER.milestone !== '__none__' && i.ms !== FILTER.milestone) return false;
    if (FILTER.un && i.a.length) return false;
    if (FILTER.q && !(i.t.toLowerCase().includes(FILTER.q) || String(i.n).includes(FILTER.q))) return false;
    return true;
  }).sort((a, b) => b.n - a.n);
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
          type: 'search', placeholder: 'Filter issues…', value: FILTER.q,
          style: { flex: '1 1 100%', maxWidth: 'none' },
        });
        inp.addEventListener('input', () => {
          FILTER.q = inp.value.toLowerCase().trim();
          renderIssueList();                    // list only — the input keeps focus
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
      (() => {
        const b = h('button', { class: 'btn sm', 'aria-pressed': String(FILTER.un) }, 'Unassigned');
        b.addEventListener('click', () => {
          FILTER.un = !FILTER.un;
          b.setAttribute('aria-pressed', String(FILTER.un));
          renderIssueList();
        });
        return b;
      })()));
  body.append(bar);

  const list = h('div', { id: 'issue-list' });
  body.append(list);
  renderIssueList();

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
}

/* Redraws only the rows, so the filter input above keeps focus and caret position. */
function renderIssueList() {
  const list = $('issue-list');
  if (!list) return;
  clear(list);
  const stagedFor = new Set(S.queue.filter(c => c.payload && c.payload.number).map(c => c.payload.number));
  const rows = visibleIssues();
  if (!rows.length) {
    list.append(h('div', { class: 'empty' },
      pulling ? 'Pulling issues…'
        : (S.issuesLoaded ? 'No issues match those filters.' : 'Issues not pulled yet.')));
  }
  rows.forEach(i => {
    list.append(h('div', {
      class: 'irow' + (i.st === 'CLOSED' ? ' closed' : ''),
      'aria-selected': String(SEL.issue === i.n),
      style: { '--c': pc(i.p), gridTemplateColumns: '52px 1fr auto' },
      onclick: () => { SEL.issue = i.n; renderIssueList(); renderPane(); },
    },
      h('span', { class: 'n' }, '#' + i.n),
      h('span', { class: 't' }, i.t,
        h('span', { class: 'sub' }, (i.ms || 'no milestone') + (i.a.length ? ' · ' + i.a[0] : ''))),
      h('span', { class: 'meta' },
        stagedFor.has(i.n) ? h('span', { class: 'staged-pip', title: 'has staged changes' }) : null,
        i.p != null ? h('span', { class: 'dot', style: { '--c': pc(i.p) }, title: i.ms }) : null)));
  });
  const c = $('issue-count');
  if (c) c.textContent = rows.length + ' shown · ' + S.issues.length + ' loaded' +
    (S.issuesLoaded ? '' : ' · not pulled yet');
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

function sideChanges(body, foot) {
  const files = S.git ? S.git.status.files : [];
  if (!files.length) {
    body.append(h('div', { class: 'empty' }, 'No local changes.'));
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
    }, 'Stash'),
    h('button', {
      class: 'btn sm', title: 'Restore the most recent stash',
      onclick: () => act(() => api('/api/git/stash', { action: 'pop' }), 'git'),
    }, 'Pop stash'));
  foot.append(extras);

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
    assistantAvailable() ? h('button', {
      class: 'btn wide', disabled: !n || commitSummaryBusy,
      title: n ? 'Draft an editable commit message from the selected changes' : 'Select files first',
      onclick: () => runCommitSummary([...CHECKED]),
    }, commitSummaryBusy ? 'Summarizing…' : 'Draft commit message') : null,
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
      ...i.l.map(l => h('span', { class: 'chip' }, l)),
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
  p.append(wrap);
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
    h('div', { class: 'stat' }, h('span', { class: 'lab' }, 'Open'), h('span', { class: 'v num' }, open.length)),
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
    const card = h('div', { class: 'gap' + (hit || pending ? ' filled' : '') });
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
        class: 'btn sm',
        onclick: async () => {
          try {
            const r = await api('/api/ai/unignore', { title: g.t });
            IGNORED = r.ignored; IGNORED_TITLES = r.ignored.map(x => x.title);
            toast(r.message, 'good'); await load();
          } catch (e) { toast(e.message, 'bad'); }
        },
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

function assistantAvailable() {
  const cfg = AI && AI.config;
  return !!(AI && AI.ok && cfg && cfg.enabled && cfg.model);
}

async function runCommitSummary(paths) {
  if (!paths.length || commitSummaryBusy || !assistantAvailable()) return;
  const repoPath = S && S.selected && S.selected.path;
  const requestSeq = ++commitSummarySeq;
  commitSummaryBusy = true;
  renderSide();
  try {
    const result = await api('/api/ai/commit-summary', { paths });
    if (!S || !S.selected || S.selected.path !== repoPath) return;
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
    if (VIEW === 'changes' && S && S.selected && S.selected.path === repoPath) renderSide();
  }
}

async function aiStatus() {
  try { AI = await api('/api/ai/status'); }
  catch (e) { AI = { ok: false, error: e.message, models: [], loaded: [], config: {} }; }
  renderNav();
  if (VIEW === 'changes') renderSide();
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
let RAIL_TAB = 'run';          // 'run' | 'settings'
let MILESTONES = [];           // proposed new milestones
let IGNORED = [];              // suggestions previously dismissed
let showIgnored = false;
let showHandledGaps = false;
let showHiddenPlan = false;
let PRS = [], prState = 'open', prLoaded = false, EDITING = null;
let IGNORED_TITLES = [];   // titles only, for gap matching

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
  $('ai-tab-set').setAttribute('aria-selected', String(RAIL_TAB === 'settings'));
  $('ai-state').textContent = !AI ? 'checking…'
    : !AI.ok ? 'unreachable'
    : aiBusy ? 'working…'
    : (cfg.enabled && cfg.model ? cfg.model.split('/').pop().slice(0, 22) : 'not set up');

  if (!AI) { body.append(h('div', { class: 'empty' }, 'Checking endpoint…')); return; }
  if (RAIL_TAB === 'settings') return railSettings(body, foot, cfg);
  return railRun(body, foot, cfg);
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
        return i; })())));

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
    h('button', { class: 'btn wide', disabled: !ready, onclick: () => runPlan() }, 'Generate plan + insights'));
  if (cfg.embedModel) {
    acts.append(h('button', {
      class: 'btn wide', disabled: !ready,
      onclick: async () => {
        aiBusy = true; renderRail();
        try { const r = await api('/api/ai/index', {}); toast(r.message, 'good'); }
        catch (e) { toast(e.message, 'bad'); }
        finally { aiBusy = false; renderRail(); }
      },
    }, 'Build / refresh index'));
  }
  body.append(acts);
  body.append(h('div', { class: 'lab', style: { marginTop: '9px', textTransform: 'none', letterSpacing: '0' } },
    'Plan generation saves a local editorial plan and proposes missing issues. Live repository data supplies its dates, milestones, and status.'));

  if (!S || !S.issuesLoaded) {
    body.append(h('div', { class: 'banner warn', style: { marginTop: '11px' } }, 'Pull issues first.'));
  }

  const nothing = !PROPOSALS.length && !SUGGESTIONS.length && !MILESTONES.length;

  if (MILESTONES.length) {
    body.append(h('h3', {}, 'Proposed milestones'));
    MILESTONES.forEach(ms => body.append(milestoneCard(ms)));
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
        h('span', { class: 't', title: g.title }, g.title),
        h('button', {
          class: 'btn sm',
          onclick: async () => {
            try {
              const r = await api('/api/ai/unignore', { title: g.title });
              IGNORED = r.ignored; toast(r.message, 'good'); await load(); renderRail();
            } catch (e) { toast(e.message, 'bad'); }
          },
        }, 'Restore'))));
      foot.append(box);
    }
  }
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
  aiBusy = true; busy(true); renderRail(); renderNav();
  try {
    const r = await api('/api/ai/milestones', {});
    MILESTONES = r.milestones; toast(r.message, r.milestones.length ? 'good' : '');
  } catch (e) { toast(e.message, 'bad'); }
  finally { aiBusy = false; busy(false); renderRail(); renderNav(); }
}

async function runPlan() {
  aiBusy = true; busy(true); renderRail(); renderNav();
  try {
    const r = await api('/api/ai/plan', { count: 10 });
    toast(r.message, 'good');
    await load();
    VIEW = 'plan'; render();
  } catch (e) { toast(e.message, 'bad'); }
  finally { aiBusy = false; busy(false); renderRail(); renderNav(); }
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
  aiBusy = true; busy(true); renderRail(); renderNav();
  try {
    const r = await api('/api/ai/classify', { includeClassified, limit: 40 });
    PROPOSALS = r.proposals; SUGGESTIONS = [];
    toast(r.message, 'good');
  } catch (e) { toast(e.message, 'bad'); }
  finally { aiBusy = false; busy(false); renderRail(); renderNav(); }
}

async function runSuggest() {
  aiBusy = true; busy(true); renderRail(); renderNav();
  try {
    const r = await api('/api/ai/suggest', { count: 6 });
    SUGGESTIONS = r.suggestions; PROPOSALS = [];
    toast(r.message + (r.usedPlan ? ' (using the repo plan)' : ''), 'good');
  } catch (e) { toast(e.message, 'bad'); }
  finally { aiBusy = false; busy(false); renderRail(); renderNav(); }
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

/* Offer "open a PR" only when the branch could actually have one. */
function newPrButton() {
  const st = S.git && S.git.status;
  const existing = S.branchPr;
  if (existing && existing.st === 'OPEN') {
    return h('a', { class: 'btn wide primary', href: existing.url, target: '_blank', rel: 'noreferrer noopener' },
      'View PR #' + existing.n + ' ↗');
  }
  const can = st && st.branch && st.upstream;
  return h('button', {
    class: 'btn wide primary', disabled: !can,
    title: can ? '' : 'Push this branch first — a PR needs an upstream',
    onclick: () => { SEL.pr = 'new'; VIEW = 'prs'; render(); },
  }, can ? 'Create pull request' : 'Push branch to open a PR');
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
  const title = h('input', { type: 'text', placeholder: 'Pull request title' });
  title.value = (S.git.log && S.git.log[0] && S.git.log[0].subject) || '';
  const body = h('textarea', { placeholder: 'Description', style: { minHeight: '150px' } });
  const base = h('select', {}, ...(S.git.branches.local || [])
    .filter(b => b.name !== st.branch)
    .map(b => h('option', { value: b.name, selected: /^(main|master|develop)$/.test(b.name) }, b.name)));
  const draft = h('input', { type: 'checkbox' });
  p.append(h('div', { class: 'pane-narrow detail' },
    h('div', { class: 'head' }, h('div', { class: 't' }, 'New pull request'),
      h('span', { class: 'lab' }, 'from ' + st.branch)),
    h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Title'), title),
    h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Merge into'), base),
    h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Description'), body),
    h('label', { class: 'acts' }, draft, h('span', { class: 'lab' }, 'Open as a draft')),
    h('div', { class: 'acts' },
      arm(h('button', { class: 'btn primary' }, 'Create pull request'),
        'Create pull request', 'Confirm — this is public',
        async () => {
          const r = await act(() => api('/api/pr/create', {
            title: title.value.trim(), body: body.value, base: base.value, head: st.branch, draft: draft.checked,
          }), 'git');
          SEL.pr = (r && r.number) || null; prLoaded = false; loadPrs();
        }),
      h('button', { class: 'btn', onclick: () => { SEL.pr = null; renderPane(); } }, 'Cancel'))));
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

/* ── wiring ──────────────────────────────────────────────────────── */
$('nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (!b || b.disabled) return;
  VIEW = b.dataset.view;
  render();
  // Opening Changes or History should show the tree as it is NOW, not as it was when the
  // page last loaded. Git calls are ~0ms, so this is free.
  if (VIEW === 'changes' || VIEW === 'history') refreshGit();
  if (VIEW === 'changes' && !AI) aiStatus();
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
$('ai-tab-set').addEventListener('click', () => { RAIL_TAB = 'settings'; renderRail(); });

load();
