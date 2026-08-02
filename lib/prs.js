'use strict';
/*
 * Pull requests. The single largest gap versus GitHub Desktop for a tool that calls
 * itself a GitHub client.
 *
 * Reads are direct. Creating a PR is a WRITE, so it routes through ghWrite and is
 * intercepted by --dry-run like everything else.
 */

const { gh, ghWrite, text, refName, posInt, bad, noLeadingDash } = require('./exec');

const FIELDS = 'number,title,state,isDraft,author,headRefName,baseRefName,url,createdAt,updatedAt,mergeable,reviewDecision,additions,deletions,changedFiles';

async function list(dir, { state = 'open', limit = 60 } = {}) {
  const st = ['open', 'closed', 'merged', 'all'].includes(state) ? state : 'open';
  const { stdout } = await gh(dir, [
    'pr', 'list', '--state', st, '--limit', String(Math.min(Math.max(limit, 1), 200)), '--json', FIELDS,
  ]);
  const raw = JSON.parse(stdout || '[]');
  return raw.map(p => ({
    n: p.number,
    t: p.title || '',
    st: String(p.state || 'OPEN').toUpperCase(),
    draft: !!p.isDraft,
    author: (p.author && p.author.login) || null,
    head: p.headRefName, base: p.baseRefName,
    url: p.url,
    mergeable: p.mergeable || null,
    review: p.reviewDecision || null,
    adds: p.additions || 0, dels: p.deletions || 0, files: p.changedFiles || 0,
    updatedAt: p.updatedAt,
  })).sort((a, b) => b.n - a.n);
}

/* Is there already a PR for this branch? Drives "Create PR" vs "View PR" in the UI. */
async function forBranch(dir, branch) {
  if (!branch) return null;
  try {
    const { stdout } = await gh(dir, ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', FIELDS]);
    const raw = JSON.parse(stdout || '[]');
    if (!raw.length) return null;
    const p = raw[0];
    return { n: p.number, t: p.title, st: String(p.state).toUpperCase(), url: p.url, draft: !!p.isDraft };
  } catch { return null; }
}

async function view(dir, number) {
  const n = posInt(number, 'pull request number');
  const { stdout } = await gh(dir, ['pr', 'view', String(n), '--json', FIELDS + ',body,commits']);
  const p = JSON.parse(stdout);
  let diff = '';
  try { diff = (await gh(dir, ['pr', 'diff', String(n)])).stdout.slice(0, 400000); }
  catch { /* diff can be unavailable on a huge PR */ }
  return {
    n: p.number, t: p.title, st: String(p.state).toUpperCase(), draft: !!p.isDraft,
    author: (p.author && p.author.login) || null,
    head: p.headRefName, base: p.baseRefName, url: p.url,
    body: p.body || '', mergeable: p.mergeable || null, review: p.reviewDecision || null,
    adds: p.additions || 0, dels: p.deletions || 0, files: p.changedFiles || 0,
    commits: (p.commits || []).map(c => ({
      sha: (c.oid || '').slice(0, 7),
      subject: c.messageHeadline || '',
      author: (c.authors && c.authors[0] && c.authors[0].login) || null,
    })),
    diff,
  };
}

async function create(dir, { title, body, base, head, draft }) {
  const t = noLeadingDash(text(title, 'title', 256), 'title');
  const b = text(body, 'body', 60000, { required: false }) || '';
  const args = ['pr', 'create', '--title', t, '--body', b];
  if (base) args.push('--base', refName(base, 'base branch'));
  if (head) args.push('--head', refName(head, 'head branch'));
  if (draft) args.push('--draft');
  const r = await ghWrite(dir, args, {
    label: 'create pull request',
    fakeStdout: 'https://github.com/dry-run/pull/0',
  });
  const url = (String(r.stdout).match(/https?:\/\/\S+/) || [])[0] || null;
  const num = url ? Number((url.match(/\/(\d+)\s*$/) || [])[1]) : null;
  return {
    ok: true, dryRun: !!r.dryRun, url, number: num,
    message: (r.dryRun ? 'Would open' : 'Opened') + ' a pull request' + (num ? ' #' + num : ''),
  };
}

module.exports = { list, forBranch, view, create };
