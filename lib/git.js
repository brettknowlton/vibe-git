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

/*
 * An error that knows how to get out of the situation it describes.
 *
 * "Commit or discard your changes before pulling" is accurate and useless: the person has
 * uncommitted work precisely because they are not ready to commit it, and discarding it is
 * the one thing they definitely do not want. The way out is stash → pull → restore, which is
 * three commands nobody should have to remember mid-interruption. So the failure carries the
 * recipe, and the front-end can offer it as a button instead of a sentence.
 */
class RecoverableError extends Error {
  constructor(message, recovery) {
    super(message);
    this.name = 'RecoverableError';
    this.status = 400;
    this.recovery = recovery;
  }
}

const STASH_PULL_RESTORE = {
  action: 'stash-pull-restore',
  title: 'Stash, pull, restore',
  steps: [
    'git stash push --include-untracked   — park your changes',
    'git pull --ff-only                   — take the new commits',
    'git stash pop                        — put your changes back on top',
  ],
  note: 'If the restore hits a conflict your work is still safe in the stash; nothing is discarded.',
};

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
    git(dir, ['for-each-ref', '--format=%(refname)%09%(refname:short)', '--sort=-committerdate', 'refs/remotes']),
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ({ stdout: '' })),
  ]);
  const current = cur.stdout.trim();
  const parse = (s) => s.stdout.split('\n').filter(Boolean).map(l => {
    const [name, upstream, date, sha, subject] = l.split('\t');
    return { name, upstream: upstream || null, date, sha, subject: subject || '' };
  });
  const locals = parse(local).map(b => Object.assign(b, { current: b.name === current }));
  /*
   * refs/remotes/origin/HEAD is a symref at the remote's default branch, not a branch of
   * its own — and git abbreviates it to plain "origin", so filtering the SHORT name for a
   * /HEAD suffix never matched it and every clone carried a phantom branch called after
   * its remote. Filter the full refname, where the suffix is actually present.
   */
  const remotes = remote.stdout.split('\n').filter(Boolean)
    .map(l => { const [ref, short] = l.split('\t'); return { ref, name: short || ref }; })
    .filter(r => !r.ref.endsWith('/HEAD'))
    .map(r => ({ name: r.name }));
  // Remote branches with no local counterpart are offerable as "check out a copy of".
  const haveLocal = new Set(locals.map(b => b.name));
  const remoteOnly = remotes
    .filter(r => r.name.includes('/'))
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
  const patch = stdout.slice(0, 200000);
  return {
    path: p, untracked: false, patch,
    // A conflicted file's diff contains the markers git wrote INTO the file. The viewer needs
    // telling, because as plain diff lines they render as ordinary additions — which is how
    // "<<<<<<< HEAD" ends up looking like a line somebody chose to add.
    conflicted: known.status === 'conflicted' || /^<{7} /m.test(patch),
  };
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
    if (!st.upstream) bad('This branch has no upstream to pull from.');
    if (st.files.some(f => f.status !== 'untracked')) {
      throw new RecoverableError(
        'You have uncommitted changes, so a fast-forward pull would overwrite them.',
        STASH_PULL_RESTORE);
    }
    try {
      const r = await gitWrite(dir, ['pull', '--ff-only'], { label: 'pull', fakeStdout: '' });
      return {
        ok: true, dryRun: !!r.dryRun,
        message: r.dryRun ? 'Would pull (fast-forward only)' : 'Pulled',
        detail: (r.stderr || r.stdout || '').trim().slice(0, 400),
      };
    } catch (e) {
      /*
       * A clean tree can still fail --ff-only, and the two reasons want opposite advice:
       * diverged history needs a merge or rebase decision, while a local change git noticed
       * after our own status check needs the stash dance. Read git's own words rather than
       * guessing, because offering "stash your changes" to someone with none is worse than
       * offering nothing.
       */
      const said = String(e.message || '');
      if (/would be overwritten|local changes/i.test(said)) {
        throw new RecoverableError(
          'The pull would overwrite local changes: ' + said.split('\n')[0].slice(0, 200),
          STASH_PULL_RESTORE);
      }
      if (/not possible to fast-forward|diverging|divergent/i.test(said)) {
        throw new RecoverableError(
          'Your branch and its upstream have both moved, so this cannot fast-forward.',
          {
            action: null,
            title: 'This needs a merge decision',
            steps: [
              `git merge ${st.upstream || 'the upstream'}   — keep both histories, one merge commit`,
              `git rebase ${st.upstream || 'the upstream'}  — replay your commits on top instead`,
            ],
            note: 'vibe-git will not choose for you: the two produce different history and only you know which this branch wants.',
          });
      }
      throw e;
    }
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

/*
 * The three commands of the stash dance, run in order, reporting where it got to.
 *
 * Each step is checked rather than assumed: a pull that fails after a successful stash must
 * NOT go on to pop, because popping onto the unchanged tree would look like the pull worked.
 * The stash is left in place instead and named in the message, so the work is one `git stash
 * pop` away rather than lost somewhere the user has to go looking for it.
 */
async function recover(dir, action) {
  if (action !== 'stash-pull-restore') bad('Unknown recovery action');
  const st = await status(dir);
  if (st.clean) bad('There is nothing to stash — try pulling again');
  if (!st.upstream) bad('This branch has no upstream to pull from.');

  const done = [];
  const stashed = await gitWrite(dir, ['stash', 'push', '--include-untracked'],
    { label: 'stash before pull', fakeStdout: '' });
  done.push('stashed your changes');
  if (stashed.dryRun) {
    await gitWrite(dir, ['pull', '--ff-only'], { label: 'pull', fakeStdout: '' });
    await gitWrite(dir, ['stash', 'pop'], { label: 'restore', fakeStdout: '' });
    return { ok: true, dryRun: true, steps: done, message: 'Would stash, pull, then restore your changes' };
  }

  try {
    await gitWrite(dir, ['pull', '--ff-only'], { label: 'pull' });
    done.push('pulled');
  } catch (e) {
    return {
      ok: false, steps: done, stashKept: true,
      message: 'Stashed your changes, but the pull failed: ' + String(e.message).split('\n')[0].slice(0, 200),
      detail: 'Your work is safe in stash@{0}. Run `git stash pop` to put it back.',
    };
  }

  try {
    await gitWrite(dir, ['stash', 'pop'], { label: 'restore' });
    done.push('restored your changes');
  } catch (e) {
    const after = await status(dir).catch(() => null);
    return {
      ok: false, steps: done, stashKept: true,
      conflicted: after ? after.conflicted : 0,
      message: 'Pulled, but restoring your changes hit a conflict' +
        (after && after.conflicted ? ` in ${after.conflicted} file(s)` : ''),
      detail: 'The stash was kept. Resolve the conflicts, then `git stash drop` when you are happy: ' +
        String(e.message).split('\n')[0].slice(0, 200),
    };
  }
  return { ok: true, steps: done, message: 'Stashed, pulled, and restored your changes' };
}

/*
 * A merge that conflicts is a NORMAL outcome, and git says so by exiting 1.
 *
 * lib/exec.js rejects on any nonzero exit, which meant the carefully worded "merged with N
 * conflicts" result below could never be reached — the throw happened first and the user got
 * git's raw "Automatic merge failed" in a red toast, with no count and no next step. So the
 * merge is run inside a try and the working tree is asked what actually happened, which is
 * the only reliable answer: conflicted paths are in the status either way.
 */
async function merge(dir, branch) {
  const name = refName(branch, 'branch');
  const st = await status(dir);
  if (st.files.some(f => f.status !== 'untracked')) {
    throw new RecoverableError('Commit or stash your changes before merging.', {
      action: null,
      title: 'Park your changes first',
      steps: ['Stash them from the Changes view, or commit them, then merge again.'],
    });
  }
  if (name === st.branch) bad('You cannot merge a branch into itself');

  let r, failure = null;
  try {
    r = await gitWrite(dir, ['merge', '--no-ff', '--', name], { label: 'merge', fakeStdout: '' });
  } catch (e) {
    failure = e;
    r = { dryRun: false, stdout: '', stderr: String(e.message || '') };
  }
  const after = await status(dir).catch(() => null);
  const conflicted = after ? after.conflicted : 0;

  if (failure && !conflicted) throw failure;      // a real failure, not a conflicted merge

  return {
    ok: true, dryRun: !!r.dryRun, conflicted,
    merging: conflicted > 0,
    message: r.dryRun ? `Would merge ${name} into ${st.branch}`
      : (conflicted
        ? `Merged with ${conflicted} conflict${conflicted === 1 ? '' : 's'} — resolve them, then commit, or abort the merge`
        : `Merged ${name} into ${st.branch}`),
    recovery: conflicted ? {
      action: 'merge-abort',
      title: `${conflicted} file${conflicted === 1 ? '' : 's'} conflicted`,
      steps: [
        'Open each conflicted file and pick what survives between the <<<<<<< and >>>>>>> markers.',
        'Commit the result to finish the merge.',
        'Or abort, which puts the branch back exactly as it was before the merge.',
      ],
    } : null,
    detail: (r.stderr || r.stdout || '').trim().slice(0, 400),
  };
}

/*
 * Whether a merge, rebase, cherry-pick or revert is half-finished. The Changes view needs
 * this to say "you are in the middle of a merge" rather than showing a pile of conflicted
 * files with no explanation of how they got there.
 */
async function mergeState(dir) {
  const { stdout } = await git(dir, ['rev-parse', '--git-dir']).catch(() => ({ stdout: '' }));
  const gitDir = stdout.trim();
  if (!gitDir) return { inProgress: false, kind: null };
  const fs = require('fs');
  const at = (name) => path.resolve(dir, gitDir, name);
  const has = (name) => { try { fs.accessSync(at(name)); return true; } catch { return false; } };
  if (has('MERGE_HEAD')) return { inProgress: true, kind: 'merge' };
  if (has('rebase-merge') || has('rebase-apply')) return { inProgress: true, kind: 'rebase' };
  if (has('CHERRY_PICK_HEAD')) return { inProgress: true, kind: 'cherry-pick' };
  if (has('REVERT_HEAD')) return { inProgress: true, kind: 'revert' };
  return { inProgress: false, kind: null };
}

/*
 * Abandon a half-finished merge. `--abort` restores the pre-merge state including the working
 * tree, which is why this is offered as a button at all: unlike a reset it cannot take
 * uncommitted work with it, because a merge cannot start with uncommitted work.
 */
async function abortMerge(dir) {
  const state = await mergeState(dir);
  if (!state.inProgress) bad('No merge is in progress');
  const verb = state.kind === 'merge' ? 'merge' : state.kind;
  const r = await gitWrite(dir, [verb, '--abort'], { label: 'abort ' + verb, fakeStdout: '' });
  return {
    ok: true, dryRun: !!r.dryRun,
    message: (r.dryRun ? 'Would abort' : 'Aborted') + ' the ' + verb + ' — the branch is back as it was',
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
  status, branches, log, fileDiff, summaryDiff, commit, discard, checkout, sync, recover,
  showCommit, undoLastCommit, amendCommit, stash, merge, mergeState, abortMerge,
  tags, createTag, deleteBranch, RecoverableError, STASH_PULL_RESTORE,
};
