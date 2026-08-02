'use strict';
/*
 * The GitHub half: reading issues and repo metadata through `gh`.
 *
 * Everything here is read-only. Writes live in queue.js, because in this app an issue
 * edit is staged first and applied later — the same shape as staging a file and
 * committing it.
 */

const { gh, bad } = require('./exec');

const FIELDS = 'number,title,state,milestone,labels,assignees,body,url,createdAt,updatedAt,comments';
const PAGE_LIMIT = 800;

async function repoMeta(dir) {
  const meta = { repo: null, login: null, milestones: [], labels: [], assignable: [] };
  meta.repo = (await gh(dir, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])).stdout.trim();
  const [ms, ls, me] = await Promise.all([
    gh(dir, ['api', 'repos/:owner/:repo/milestones?state=all&per_page=100']).catch(() => ({ stdout: '[]' })),
    gh(dir, ['label', 'list', '--limit', '200', '--json', 'name,color,description']).catch(() => ({ stdout: '[]' })),
    gh(dir, ['api', 'user', '-q', '.login']).catch(() => ({ stdout: '' })),
  ]);
  meta.milestones = JSON.parse(ms.stdout || '[]')
    .map(m => ({
      number: m.number, title: m.title, state: m.state,
      dueOn: m.due_on, description: m.description || '',
    }));
  meta.labels = JSON.parse(ls.stdout || '[]').map(l => ({ name: l.name, color: l.color, description: l.description }));
  meta.login = me.stdout.trim() || null;
  try {
    const a = await gh(dir, ['api', 'repos/:owner/:repo/assignees?per_page=100', '-q', '.[].login']);
    meta.assignable = a.stdout.split('\n').filter(Boolean);
  } catch { meta.assignable = meta.login ? [meta.login] : []; }
  return meta;
}

// Compatibility helper for older saved insight files. Live plan grouping now resolves
// exact milestone titles in lib/plans.js and does not require a "Phase N" convention.
function phaseOf(milestone) {
  if (!milestone) return null;
  const m = /^\s*Phase\s+(\d+)\b/i.exec(milestone.title || '');
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 9 ? n : null;
}

function countBoxes(body) {
  const src = String(body || '');
  // Markdown allows -, * or + bullets, any indent, and [x] or [X].
  const done = (src.match(/^[ \t]*[-*+] \[[xX]\]/gm) || []).length;
  const todo = (src.match(/^[ \t]*[-*+] \[ \]/gm) || []).length;
  return [done, done + todo];
}

async function list(dir) {
  const { stdout } = await gh(dir, ['issue', 'list', '--state', 'all', '--limit', String(PAGE_LIMIT), '--json', FIELDS]);
  let raw;
  try { raw = JSON.parse(stdout || '[]'); }
  catch { bad('Could not parse the issue list from gh'); }

  const issues = raw.map(i => {
    const body = i.body || '';
    return {
      n: i.number,
      t: i.title || '',
      st: String(i.state || 'OPEN').toUpperCase(),
      p: phaseOf(i.milestone), // provisional legacy value; plan hydration remaps by title
      ms: i.milestone ? i.milestone.title : null,
      l: (i.labels || []).map(x => x.name),
      a: (i.assignees || []).map(x => x.login),
      url: i.url || null,
      comments: Array.isArray(i.comments) ? i.comments.length : (i.comments || 0),
      updatedAt: i.updatedAt || null,
      body,
      refs: [...new Set((body.match(/#\d+/g) || []).map(s => Number(s.slice(1))))],
      bx: countBoxes(body),
    };
  });

  // "Ref'd by" = which other OPEN issues mention this one. Deliberately directionless:
  // a body saying "blocks #93" and one saying "depends on #93" are indistinguishable.
  const openNums = new Set(issues.filter(i => i.st === 'OPEN').map(i => i.n));
  const ref = new Map();
  for (const i of issues) {
    if (i.st !== 'OPEN') continue;
    for (const r of i.refs) {
      if (openNums.has(r) && r !== i.n) {
        if (!ref.has(r)) ref.set(r, new Set());
        ref.get(r).add(i.n);
      }
    }
  }
  for (const i of issues) {
    i.bl = [...(ref.get(i.n) || [])].sort((a, b) => a - b);
    delete i.refs;
  }
  issues.sort((a, b) => a.n - b.n);
  return { issues, truncated: raw.length >= PAGE_LIMIT };
}

/*
 * Whose GitHub account is this? The app never holds credentials — it inherits whatever
 * `gh` on this machine is authenticated as, so on someone else's laptop it is silently
 * their account. Surfacing that matters before anyone pushes anything.
 */
async function authStatus(dir) {
  try {
    const { stdout } = await gh(dir || process.cwd(), ['auth', 'status'], { timeout: 12000 });
    const login = (/account (\S+)/.exec(stdout) || [])[1] || null;
    const scopes = (/Token scopes:\s*(.+)/.exec(stdout) || [])[1] || null;
    const protocol = (/Git operations protocol:\s*(\S+)/.exec(stdout) || [])[1] || null;
    return { authed: !!login, login, scopes: scopes ? scopes.replace(/'/g, '') : null, protocol };
  } catch (e) {
    return {
      authed: false, login: null,
      error: /not logged|no accounts|gh auth login/i.test(e.message)
        ? 'Not signed in to GitHub on this machine'
        : e.message,
      hint: 'gh auth login',
    };
  }
}

module.exports = { repoMeta, list, phaseOf, countBoxes, authStatus, PAGE_LIMIT };
