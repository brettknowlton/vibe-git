'use strict';
/*
 * The native-git half of the app — the operations GitHub Desktop does locally:
 * branch list, working-tree status, commit, and the fetch/pull/push trio.
 *
 * File paths are never taken on trust. Anything destined for `git add` is checked
 * against the paths git itself just reported in `status`, so the UI can only ever act
 * on files that genuinely exist as changes right now.
 */

const path = require('path');
const { git, gitWrite, refName, text, bad } = require('./exec');

/* ── status ──────────────────────────────────────────────────────── */

const XY = {
  'M': 'modified', 'A': 'added', 'D': 'deleted',
  'R': 'renamed', 'C': 'copied', 'U': 'conflicted', 'T': 'typechange',
};

// porcelain=v2 is the stable machine format: header lines start with '#', entries with
// 1 (ordinary), 2 (rename), u (unmerged) or ? (untracked).
async function status(dir) {
  const { stdout } = await git(dir, ['status', '--porcelain=v2', '--branch', '--untracked-files=all']);
  const out = {
    branch: null, upstream: null, ahead: 0, behind: 0, detached: false,
    files: [], conflicted: 0,
  };
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head')) {
      const v = line.slice('# branch.head '.length).trim();
      out.branch = v === '(detached)' ? null : v;
      out.detached = v === '(detached)';
    } else if (line.startsWith('# branch.upstream')) {
      out.upstream = line.slice('# branch.upstream '.length).trim();
    } else if (line.startsWith('# branch.ab')) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line);
      if (m) { out.ahead = Number(m[1]); out.behind = Number(m[2]); }
    } else if (line[0] === '1' || line[0] === '2') {
      const parts = line.split(' ');
      const xy = parts[1] || '..';
      // rename entries put "orig\tnew" in the tail
      const tail = line.split('\t');
      const p = line[0] === '2' ? (tail[0].split(' ').slice(9).join(' ')) : parts.slice(8).join(' ');
      out.files.push({
        path: line[0] === '2' ? p : p,
        from: line[0] === '2' ? (tail[1] || null) : null,
        staged: xy[0] !== '.',
        unstaged: xy[1] !== '.',
        status: XY[xy[0] !== '.' ? xy[0] : xy[1]] || 'modified',
      });
    } else if (line[0] === 'u') {
      const p = line.split(' ').slice(10).join(' ');
      out.files.push({ path: p, staged: false, unstaged: true, status: 'conflicted' });
      out.conflicted++;
    } else if (line[0] === '?') {
      out.files.push({ path: line.slice(2), staged: false, unstaged: true, status: 'untracked' });
    }
  }
  out.files.sort((a, b) => a.path.localeCompare(b.path));
  out.clean = out.files.length === 0;
  return out;
}

/* ── branches & history ──────────────────────────────────────────── */

async function branches(dir) {
  const fmt = '%(refname:short)%09%(upstream:short)%09%(committerdate:iso8601)%09%(objectname:short)%09%(contents:subject)';
  const [local, remote, cur] = await Promise.all([
    git(dir, ['for-each-ref', '--format=' + fmt, '--sort=-committerdate', 'refs/heads']),
    git(dir, ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/remotes']),
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ({ stdout: '' })),
  ]);
  const current = cur.stdout.trim();
  const parse = (s) => s.stdout.split('\n').filter(Boolean).map(l => {
    const [name, upstream, date, sha, subject] = l.split('\t');
    return { name, upstream: upstream || null, date, sha, subject: subject || '' };
  });
  const locals = parse(local).map(b => Object.assign(b, { current: b.name === current }));
  const remotes = remote.stdout.split('\n').filter(Boolean)
    .filter(n => !n.endsWith('/HEAD'))
    .map(n => ({ name: n }));
  // Remote branches with no local counterpart are offerable as "check out a copy of".
  const haveLocal = new Set(locals.map(b => b.name));
  const remoteOnly = remotes
    .map(r => r.name.replace(/^[^/]+\//, ''))
    .filter(n => n && !haveLocal.has(n));
  return { current, local: locals, remote: remotes, remoteOnly: [...new Set(remoteOnly)] };
}

async function log(dir, limit = 30) {
  const fmt = '%H%x09%h%x09%an%x09%aI%x09%s';
  const { stdout } = await git(dir, ['log', '--max-count=' + Math.min(200, Math.max(1, limit)), '--format=' + fmt]);
  return stdout.split('\n').filter(Boolean).map(l => {
    const [sha, short, author, date, subject] = l.split('\t');
    return { sha, short, author, date, subject };
  });
}

async function fileDiff(dir, file) {
  const p = String(file || '');
  if (!p) bad('file is required');
  const st = await status(dir);
  const known = st.files.find(f => f.path === p);
  if (!known) bad('That file is not in the current working-tree changes');
  if (known.status === 'untracked') {
    // No diff exists for a file git has never seen; show it as all-additions.
    const { stdout } = await git(dir, ['diff', '--no-index', '--', '/dev/null', p]).catch(e => ({ stdout: e.message }));
    return { path: p, untracked: true, patch: stdout.slice(0, 200000) };
  }
  const { stdout } = await git(dir, ['diff', 'HEAD', '--', p]);
  return { path: p, untracked: false, patch: stdout.slice(0, 200000) };
}

/* A bounded, read-only diff for the commit-message assistant. Every path is validated
 * against live status first, and the budget is shared so one large file cannot crowd
 * every other selected change out of the model context. */
async function summaryDiff(dir, paths, maxChars = 24000) {
  const picked = await assertPathsAreChanges(dir, paths || []);
  const st = await status(dir);
  const byPath = new Map(st.files.map(file => [file.path, file]));
  const totalBudget = Math.max(4000, Math.min(Number(maxChars) || 24000, 60000));
  const perFile = Math.max(800, Math.min(8000, Math.floor(totalBudget / picked.length)));
  const sections = [];
  let truncated = false;
  for (const p of picked) {
    const info = byPath.get(p);
    if (!info) bad(`"${p}" changed while the summary was being prepared — refresh and try again`);
    let patch;
    if (info.status === 'untracked') {
      const result = await git(dir, ['diff', '--no-index', '--', '/dev/null', p])
        .catch(error => ({ stdout: error.message }));
      patch = result.stdout;
    } else {
      patch = (await git(dir, ['diff', 'HEAD', '--', p])).stdout;
    }
    if (patch.length > perFile) truncated = true;
    sections.push(`FILE: ${p} (${info.status})\n${patch.slice(0, perFile)}`);
  }
  let patch = sections.join('\n\n');
  if (patch.length > totalBudget) { patch = patch.slice(0, totalBudget); truncated = true; }
  return { files: picked, patch, truncated, branch: st.branch };
}

/* ── mutations ───────────────────────────────────────────────────── */

async function assertPathsAreChanges(dir, paths) {
  const st = await status(dir);
  const known = new Set(st.files.map(f => f.path));
  const picked = [];
  for (const raw of paths) {
    const p = String(raw || '');
    if (!p) bad('empty file path');
    if (p.startsWith('-')) bad('file path cannot start with "-"');
    if (!known.has(p)) bad(`"${p}" is not one of the current changes — refresh and try again`);
    picked.push(p);
  }
  if (!picked.length) bad('Select at least one file to commit');
  return picked;
}

async function commit(dir, { paths, subject, body }) {
  const subj = text(subject, 'Commit summary', 500);
  const desc = text(body, 'Description', 20000, { required: false });
  const picked = await assertPathsAreChanges(dir, paths || []);
  // `--` terminates flags, so even a file literally named "--force" is treated as a path.
  await gitWrite(dir, ['add', '--', ...picked], { label: `stage ${picked.length} file(s)` });
  const args = ['commit', '-m', subj];
  if (desc) args.push('-m', desc);
  args.push('--', ...picked);
  const { stdout, dryRun } = await gitWrite(dir, args, { label: 'commit', fakeStdout: '[dry-run] commit' });
  return { ok: true, dryRun: !!dryRun, message: dryRun ? 'Would commit ' + picked.length + ' file(s)' : 'Committed ' + picked.length + ' file(s)', detail: stdout.trim().slice(0, 400) };
}

async function discard(dir, paths) {
  const picked = await assertPathsAreChanges(dir, paths || []);
  const st = await status(dir);
  const byPath = new Map(st.files.map(f => [f.path, f]));
  const tracked = picked.filter(p => byPath.get(p).status !== 'untracked');
  const untracked = picked.filter(p => byPath.get(p).status === 'untracked');
  if (tracked.length) await gitWrite(dir, ['restore', '--staged', '--worktree', '--', ...tracked], { label: 'discard' });
  if (untracked.length) await gitWrite(dir, ['clean', '-f', '--', ...untracked], { label: 'delete untracked' });
  return { ok: true, message: `Discarded changes in ${picked.length} file(s)` };
}

async function checkout(dir, branch, { create = false, from = null } = {}) {
  const name = refName(branch, 'branch');
  const st = await status(dir);
  if (!create && st.files.some(f => f.status !== 'untracked')) {
    bad('You have uncommitted changes. Commit or discard them before switching branches.');
  }
  const args = create ? ['switch', '--create', name] : ['switch', name];
  if (create && from) args.push(refName(from, 'start point'));
  const { stdout, stderr, dryRun } = await gitWrite(dir, args, {
    label: create ? 'create branch' : 'switch branch', fakeStdout: '[dry-run]',
  });
  return {
    ok: true, dryRun: !!dryRun,
    message: dryRun
      ? (create ? `Would create and switch to ${name}` : `Would switch to ${name}`)
      : (create ? `Created and switched to ${name}` : `Switched to ${name}`),
    detail: (stderr || stdout || '').trim().slice(0, 300),
  };
}

async function sync(dir, what) {
  if (what === 'fetch') {
    const r = await gitWrite(dir, ['fetch', '--all', '--prune'], { label: 'fetch', fakeStdout: '' });
    return { ok: true, dryRun: !!r.dryRun, message: r.dryRun ? 'Would fetch all remotes' : 'Fetched', detail: (r.stderr || r.stdout || '').trim().slice(0, 400) };
  }
  if (what === 'pull') {
    const st = await status(dir);
    if (st.files.some(f => f.status !== 'untracked')) bad('Commit or discard your changes before pulling.');
    if (!st.upstream) bad('This branch has no upstream to pull from.');
    const r = await gitWrite(dir, ['pull', '--ff-only'], { label: 'pull', fakeStdout: '' });
    return { ok: true, dryRun: !!r.dryRun, message: r.dryRun ? 'Would pull (fast-forward only)' : 'Pulled', detail: (r.stderr || r.stdout || '').trim().slice(0, 400) };
  }
  if (what === 'push') {
    const st = await status(dir);
    if (!st.branch) bad('You are on a detached HEAD; check out a branch before pushing.');
    const args = st.upstream ? ['push'] : ['push', '--set-upstream', 'origin', st.branch];
    const r = await gitWrite(dir, args, { label: 'push', fakeStdout: '' });
    return { ok: true, dryRun: !!r.dryRun, message: r.dryRun ? 'Would push ' + st.branch : 'Pushed ' + st.branch, detail: (r.stderr || r.stdout || '').trim().slice(0, 400) };
  }
  bad('Unknown sync action');
}

/* ── the operations GitHub Desktop has that we were missing ──────── */

async function showCommit(dir, sha) {
  const ref = String(sha || '').trim();
  if (!/^[0-9a-fA-F]{4,40}$/.test(ref)) bad('That is not a commit hash');
  const fmt = '%H%x09%h%x09%an%x09%ae%x09%aI%x09%s%x09%b';
  const [meta, stat, patch] = await Promise.all([
    git(dir, ['show', '--no-patch', '--format=' + fmt, ref]),
    git(dir, ['show', '--stat', '--format=', ref]),
    git(dir, ['show', '--format=', ref]),
  ]);
  const [sha1, short, author, email, date, subject, bodyText] = meta.stdout.trim().split('\t');
  return {
    sha: sha1, short, author, email, date, subject, body: (bodyText || '').trim(),
    stat: stat.stdout.trim(), patch: patch.stdout.slice(0, 400000),
  };
}

/*
 * Undo the last commit but KEEP the work. --soft moves HEAD back and leaves everything
 * staged, so nothing is ever destroyed by this button.
 */
async function undoLastCommit(dir) {
  const { stdout } = await git(dir, ['log', '--max-count=1', '--format=%h %s']).catch(() => ({ stdout: '' }));
  if (!stdout.trim()) bad('There is no commit to undo');
  let hasParent = true;
  try { await git(dir, ['rev-parse', 'HEAD~1']); } catch { hasParent = false; }
  if (!hasParent) bad('That is the first commit — undoing it would leave no history to reset to');
  const r = await gitWrite(dir, ['reset', '--soft', 'HEAD~1'], { label: 'undo commit', fakeStdout: '' });
  return {
    ok: true, dryRun: !!r.dryRun,
    message: (r.dryRun ? 'Would undo ' : 'Undid ') + stdout.trim() + ' — changes kept and staged',
  };
}

async function amendCommit(dir, { subject, body }) {
  const subj = text(subject, 'Commit summary', 500);
  const desc = text(body, 'Description', 20000, { required: false });
  const args = ['commit', '--amend', '-m', subj];
  if (desc) args.push('-m', desc);
  const r = await gitWrite(dir, args, { label: 'amend', fakeStdout: '' });
  return { ok: true, dryRun: !!r.dryRun, message: (r.dryRun ? 'Would amend' : 'Amended') + ' the last commit' };
}

async function stash(dir, action, ref) {
  if (action === 'list') {
    const { stdout } = await git(dir, ['stash', 'list', '--format=%gd%x09%ai%x09%gs']);
    return {
      ok: true, stashes: stdout.split('\n').filter(Boolean).map(l => {
        const [id, date, subject] = l.split('\t');
        return { id, date, subject };
      }),
    };
  }
  if (action === 'push') {
    const st = await status(dir);
    if (st.clean) bad('Nothing to stash');
    const r = await gitWrite(dir, ['stash', 'push', '--include-untracked'], { label: 'stash', fakeStdout: '' });
    return { ok: true, dryRun: !!r.dryRun, message: r.dryRun ? 'Would stash your changes' : 'Stashed your changes' };
  }
  if (action === 'pop' || action === 'drop') {
    const id = String(ref || 'stash@{0}');
    if (!/^stash@\{\d+\}$/.test(id)) bad('That is not a stash reference');
    const r = await gitWrite(dir, ['stash', action, id], { label: 'stash ' + action, fakeStdout: '' });
    return { ok: true, dryRun: !!r.dryRun, message: (r.dryRun ? 'Would ' : '') + action + ' ' + id };
  }
  bad('Unknown stash action');
}

async function merge(dir, branch) {
  const name = refName(branch, 'branch');
  const st = await status(dir);
  if (st.files.some(f => f.status !== 'untracked')) bad('Commit or stash your changes before merging.');
  if (name === st.branch) bad('You cannot merge a branch into itself');
  const r = await gitWrite(dir, ['merge', '--no-ff', '--', name], { label: 'merge', fakeStdout: '' });
  const after = await status(dir).catch(() => null);
  return {
    ok: true, dryRun: !!r.dryRun,
    conflicted: after ? after.conflicted : 0,
    message: r.dryRun ? `Would merge ${name} into ${st.branch}`
      : (after && after.conflicted
          ? `Merged with ${after.conflicted} conflict(s) — resolve them in your editor, then commit`
          : `Merged ${name} into ${st.branch}`),
    detail: (r.stderr || r.stdout || '').trim().slice(0, 400),
  };
}

async function tags(dir) {
  const { stdout } = await git(dir, ['for-each-ref', '--sort=-creatordate',
    '--format=%(refname:short)%09%(objectname:short)%09%(creatordate:iso8601)%09%(contents:subject)', 'refs/tags']);
  return stdout.split('\n').filter(Boolean).slice(0, 100).map(l => {
    const [name, sha, date, subject] = l.split('\t');
    return { name, sha, date, subject: subject || '' };
  });
}

async function createTag(dir, { name, message, push }) {
  const tag = refName(name, 'tag');
  const msg = text(message, 'tag message', 2000, { required: false });
  const args = msg ? ['tag', '-a', tag, '-m', msg] : ['tag', tag];
  const r = await gitWrite(dir, args, { label: 'tag', fakeStdout: '' });
  let pushed = false;
  if (push && !r.dryRun) { await gitWrite(dir, ['push', 'origin', 'refs/tags/' + tag]); pushed = true; }
  else if (push && r.dryRun) await gitWrite(dir, ['push', 'origin', 'refs/tags/' + tag], { label: 'push tag' });
  return {
    ok: true, dryRun: !!r.dryRun,
    message: (r.dryRun ? 'Would create' : 'Created') + ' tag ' + tag + ((push) ? ' and push it' : ''),
  };
}

async function deleteBranch(dir, branch, { force = false } = {}) {
  const name = refName(branch, 'branch');
  const st = await status(dir);
  if (name === st.branch) bad('You cannot delete the branch you are on');
  const r = await gitWrite(dir, ['branch', force ? '-D' : '-d', '--', name], { label: 'delete branch', fakeStdout: '' });
  return { ok: true, dryRun: !!r.dryRun, message: (r.dryRun ? 'Would delete ' : 'Deleted ') + name };
}

module.exports = {
  status, branches, log, fileDiff, summaryDiff, commit, discard, checkout, sync,
  showCommit, undoLastCommit, amendCommit, stash, merge, tags, createTag, deleteBranch,
};
