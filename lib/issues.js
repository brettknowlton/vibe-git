'use strict';
/*
 * The GitHub half: reading issues and repo metadata through `gh`.
 *
 * Everything here is read-only. Writes live in queue.js, because in this app an issue
 * edit is staged first and applied later — the same shape as staging a file and
 * committing it.
 */

const { gh, bad } = require('./exec');

/* `closedAt` is what lets the tracker have a HISTORY rather than only a current state: an
   issue's close is the single most informative event in a repository and it is the one
   GitHub's own issue list will not show you on a timeline. */
const FIELDS = 'number,title,state,milestone,labels,assignees,body,url,createdAt,updatedAt,closedAt,comments';
const PAGE_LIMIT = 800;

/*
 * Comment bodies are kept, not just counted.
 *
 * `gh issue list --json comments` already returns the full thread, so this costs nothing on
 * the wire — the previous code fetched every comment and threw all of it away except the
 * length. That made the issue detail view quietly misleading: an issue whose body says one
 * thing and whose thread reverses it read as though the reversal never happened, and the
 * only way to find out was to open github.com.
 *
 * Both caps exist because the cache is one JSON file per repository that is read whole on
 * every request. A tracker with a few hundred-comment arguments in it would turn a 90KB
 * file into a multi-megabyte one for context nobody scrolls to. The newest comments are
 * the ones that matter, so the trim takes from the front and the true total is recorded
 * alongside, letting the view say what it is not showing rather than pretending it has
 * everything.
 */
const COMMENT_LIMIT = 20;
const COMMENT_CHARS = 4000;

function comments(raw) {
  if (!Array.isArray(raw)) return { count: Number(raw) || 0, kept: [] };
  return {
    count: raw.length,
    kept: raw.slice(-COMMENT_LIMIT).map(c => ({
      who: (c && c.author && c.author.login) || null,
      at: (c && c.createdAt) || null,
      url: (c && c.url) || null,
      body: String((c && c.body) || '').replace(/\r/g, '').slice(0, COMMENT_CHARS),
    })),
  };
}

async function repoMeta(dir) {
  const meta = { repo: null, login: null, defaultBranch: null, milestones: [], labels: [], assignable: [] };
  // Both fields come from one call. The default branch is what a pull request should be
  // opened against unless the user says otherwise, and guessing "main" gets it wrong on
  // every repository that predates the rename.
  const view = JSON.parse((await gh(dir, ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'])).stdout || '{}');
  meta.repo = String(view.nameWithOwner || '').trim();
  meta.defaultBranch = (view.defaultBranchRef && view.defaultBranchRef.name) || null;
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

/*
 * Which issues this one says it is waiting on.
 *
 * Deliberately conservative: only phrasings that state a dependency in the direction
 * "me → them" count. "blocks #4" is the opposite claim and must not be picked up, so the
 * patterns are anchored and "blocked by" is matched before the bare "blocks".
 */
const STRONG_DEP = /\b(?:blocked\s+by|depends?\s+(?:on|upon)|dependent\s+on|requires?|needs?|waiting\s+(?:on|for))\b/gi;
// "after"/"once" are ordinary English as often as they are dependencies, so they only
// count when the issue number follows immediately.
const WEAK_DEP = /\b(?:after|once)\b/gi;
const LIST_MORE = /^\s*(?:,|and|&|\+|or)\s*#(\d+)/;

function blockedBy(body) {
  const src = String(body || '');
  const out = new Set();

  const scan = (pattern, reach) => {
    pattern.lastIndex = 0;
    let hit;
    while ((hit = pattern.exec(src))) {
      // A line that also claims the opposite direction is ambiguous; leave it alone.
      const lineEnd = src.indexOf('\n', hit.index);
      const line = src.slice(src.lastIndexOf('\n', hit.index) + 1, lineEnd === -1 ? undefined : lineEnd);
      if (/\bblocks\s+#/i.test(line) && !/\bblocked\s+by\b/i.test(line)) continue;

      const after = src.slice(hit.index + hit[0].length, hit.index + hit[0].length + reach + 40);
      const first = new RegExp('^[^\\n#]{0,' + reach + '}#(\\d+)').exec(after);
      if (!first) continue;
      out.add(Number(first[1]));
      // "depends on #7 and #9, #11" — keep taking numbers while it reads as one list.
      let rest = after.slice(first[0].length);
      let more;
      while ((more = LIST_MORE.exec(rest))) {
        out.add(Number(more[1]));
        rest = rest.slice(more[0].length);
      }
    }
  };

  scan(STRONG_DEP, 40);
  scan(WEAK_DEP, 4);
  return [...out].filter(n => Number.isInteger(n) && n > 0);
}

/*
 * The inverse of blockedBy(): write an edge INTO a body so the parser above will read it back.
 *
 * A dependency in this app is not a field — it is a sentence someone wrote in an issue body,
 * which is what makes it survive leaving vibe-git and still mean something on github.com. So
 * declaring one means editing the body, and doing that safely means never rewriting what is
 * already there. An existing "Blocked by:" line is extended; otherwise one is appended.
 *
 * Returns null when the edge is already declared, so a caller can tell "nothing to do" from
 * "here is the new body" without diffing strings.
 */
/* Tolerates every way people write the line: plain, bold, with or without the colon, and
   with the colon on either side of the asterisks — "**Blocked by:** #2" is the common one. */
const BLOCKED_LINE = /^([^\S\n]*\**\s*blocked\s+by[\s:*]*)(.*)$/im;

function withBlockedBy(body, numbers) {
  const src = String(body == null ? '' : body).replace(/\r/g, '');
  const want = [...new Set((numbers || []).filter(n => Number.isInteger(n) && n > 0))];
  if (!want.length) return null;
  const already = new Set(blockedBy(src));
  const add = want.filter(n => !already.has(n));
  if (!add.length) return null;

  const hit = BLOCKED_LINE.exec(src);
  if (hit) {
    // Extend the line that is already there, keeping its existing wording and numbers.
    const existing = (hit[2].match(/#\d+/g) || []);
    const merged = existing.concat(add.map(n => '#' + n)).join(', ');
    return src.slice(0, hit.index) + hit[1].replace(/\s+$/, '') + ' ' + merged +
      src.slice(hit.index + hit[0].length);
  }
  const tail = src.trim() ? src.replace(/\s+$/, '') + '\n\n' : '';
  return tail + 'Blocked by: ' + add.map(n => '#' + n).join(', ');
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
    const cm = comments(i.comments);
    return {
      n: i.number,
      t: i.title || '',
      st: String(i.state || 'OPEN').toUpperCase(),
      p: phaseOf(i.milestone), // provisional legacy value; plan hydration remaps by title
      ms: i.milestone ? i.milestone.title : null,
      l: (i.labels || []).map(x => x.name),
      a: (i.assignees || []).map(x => x.login),
      url: i.url || null,
      comments: cm.count,
      // The thread itself, newest-last and capped. `comments` stays the true total, so a
      // trimmed thread can say so instead of looking complete.
      cm: cm.kept,
      updatedAt: i.updatedAt || null,
      createdAt: i.createdAt || null,
      // gh returns the zero time rather than null for an issue that was never closed.
      closedAt: i.closedAt && !/^0001-/.test(i.closedAt) ? i.closedAt : null,
      body,
      refs: [...new Set((body.match(/#\d+/g) || []).map(s => Number(s.slice(1))))],
      bx: countBoxes(body),
    };
  });

  /*
   * Reference edges between issues, in both directions.
   *
   * `bl` is the old directionless "ref'd by". `rf` is the forward edge — which issues this
   * one mentions — and used to be computed and then thrown away, which meant the tracker's
   * whole dependency structure was recomputed and discarded on every pull.
   *
   * `bk` is the subset of `rf` where the text actually says this issue is BLOCKED: a body
   * saying "blocks #93" and one saying "depends on #93" mean opposite things, so only the
   * phrasings that state a dependency are promoted. Everything else stays a plain mention.
   */
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
    i.rf = i.refs.filter(r => r !== i.n).sort((a, b) => a - b);
    i.bk = blockedBy(i.body).filter(r => r !== i.n && openNums.has(r)).sort((a, b) => a - b);
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

/*
 * Is this machine actually able to talk to GitHub?
 *
 * Three separate things can be wrong and they need three different sentences: `gh` is not
 * installed, `gh` is too old for the flags this app passes, or `gh` is installed and current
 * and nobody is signed in. Until now all three surfaced the same way — as whatever stderr
 * said, in a toast, halfway through an action somebody had already committed to — and the
 * first-run experience of a working install was indistinguishable from a broken one.
 *
 * Checked once and cached with the rest of the auth state, because `gh --version` costs a
 * process spawn and the answer changes roughly never.
 */
const MIN_GH = [2, 54, 0];

function compareVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

async function health(dir) {
  const out = {
    installed: false, version: null, current: false, minimum: MIN_GH.join('.'),
    problem: null, fix: null,
  };
  let stdout = '';
  try {
    ({ stdout } = await gh(dir || process.cwd(), ['--version'], { timeout: 10000 }));
  } catch (e) {
    out.problem = /not installed|not on PATH|ENOENT/i.test(e.message)
      ? 'The GitHub CLI is not installed, so nothing in this app can reach GitHub. Git itself still works.'
      : 'The GitHub CLI could not be run: ' + e.message;
    out.fix = 'Install gh from https://cli.github.com, then press Refresh.';
    return out;
  }
  out.installed = true;
  const hit = /gh version (\d+)\.(\d+)\.(\d+)/i.exec(stdout);
  if (!hit) {
    // Present and unparseable is not the same as absent, and must not be reported as broken.
    out.version = null; out.current = true;
    return out;
  }
  out.version = hit.slice(1, 4).join('.');
  out.current = compareVersion(hit.slice(1, 4).map(Number), MIN_GH) >= 0;
  if (!out.current) {
    out.problem = `This is gh ${out.version}. Issue operations here need ${MIN_GH.join('.')} or newer — ` +
      'older versions are missing flags this app passes and fail with confusing errors rather than clear ones.';
    out.fix = 'Update the GitHub CLI, then press Refresh.';
  }
  return out;
}

module.exports = {
  repoMeta, list, phaseOf, countBoxes, comments, blockedBy, withBlockedBy, authStatus, health,
  PAGE_LIMIT, COMMENT_LIMIT, COMMENT_CHARS, MIN_GH,
};
