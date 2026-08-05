'use strict';
/*
 * Conflict resolution — the part of a merge that GitHub Desktop hands to a text editor.
 *
 * The whole module exists to answer one question the raw markers refuse to answer:
 * WHICH SIDE IS WHICH. `<<<<<<< HEAD` and `>>>>>>> feature/login` are only meaningful if you
 * already know what operation you are in the middle of, and during a rebase they mean the
 * OPPOSITE of what almost everyone assumes — "ours" is the branch you are replaying onto and
 * "theirs" is your own commit. That single inversion is the most common way a conflict gets
 * resolved backwards, and no amount of syntax highlighting fixes it.
 *
 * So nothing here says "ours" or "theirs" to the user. Every side is described by the branch
 * or commit it actually came from, the role it plays in THIS operation, and when it was
 * written — so "keep the newer one" becomes a decision you can make from the screen.
 *
 * Two rules hold throughout:
 *   1. A path is writable only if git JUST reported it as unmerged. Nothing is taken on trust.
 *   2. Nothing is staged until you say so. `git add` on a conflicted file destroys the
 *      recorded stages, and with them the ability to put the markers back — so resolving a
 *      hunk edits the working file and stops there. Every decision stays reversible right up
 *      until Continue, which stages what is finished as its first act.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { git, gitWrite, text, bad, isDryRun } = require('./exec');
const images = require('./images');

const MAX_FILE = 2 * 1024 * 1024;

/* ── what kind of conflict each file has ─────────────────────────── */

/*
 * The XY code on a porcelain-v2 `u` line. "Both modified" is the one everybody pictures; the
 * other six produce a file with no conflict markers in it at all, which is exactly why an
 * editor-only workflow leaves people stuck — there is nothing in the file to edit. Each kind
 * gets its own choices, because "keep their version" is not a coherent instruction about a
 * file the other side deleted.
 */
const KINDS = {
  UU: { kind: 'both-modified', title: 'Both sides changed this file', markers: true },
  AA: { kind: 'both-added', title: 'Both sides added this file independently', markers: true },
  DD: { kind: 'both-deleted', title: 'Both sides deleted this file', markers: false },
  AU: { kind: 'added-by-us', title: 'Added on your side, absent on the other', markers: false },
  UA: { kind: 'added-by-them', title: 'Added on the incoming side, absent on yours', markers: false },
  DU: { kind: 'deleted-by-us', title: 'Deleted on your side, changed on the other', markers: false },
  UD: { kind: 'deleted-by-them', title: 'Changed on your side, deleted on the other', markers: false },
};

/* ── reading git's half-finished state ───────────────────────────── */

async function gitDirOf(dir) {
  const { stdout } = await git(dir, ['rev-parse', '--absolute-git-dir']).catch(() => ({ stdout: '' }));
  return stdout.trim();
}

const readIf = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } };
const existsAt = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

async function commitAt(dir, ref) {
  const { stdout } = await git(dir, ['log', '-1', '--format=%H%x09%h%x09%an%x09%aI%x09%s', ref])
    .catch(() => ({ stdout: '' }));
  if (!stdout.trim()) return null;
  const [sha, short, author, date, subject] = stdout.trim().split('\t');
  return { sha, short, author, date, subject: subject || '' };
}

/*
 * A branch name for a sha, but only when it is genuinely THAT branch's tip. name-rev happily
 * answers "main~4", and labelling the fourth-from-last commit on main as "main" would put a
 * confidently wrong name on the side you are about to discard.
 */
async function exactName(dir, ref) {
  const { stdout } = await git(dir, ['name-rev', '--name-only',
    '--refs=refs/heads/*', '--refs=refs/remotes/*', ref]).catch(() => ({ stdout: '' }));
  const n = stdout.trim();
  if (!n || n === 'undefined' || /[~^]/.test(n)) return null;
  return n.replace(/^remotes\//, '');
}

function makeSide(key, { marker, role, ref, commit, hint, name }) {
  return {
    key, marker, role, hint: hint || null,
    ref: ref || null,
    sha: commit ? commit.sha : null,
    short: commit ? commit.short : null,
    subject: commit ? commit.subject : null,
    author: commit ? commit.author : null,
    date: commit ? commit.date : null,
    age: null,
    // The name to put on a button: a branch when we have one, else the commit, else a short
    // stand-in. Never the role — "Keep The changes being applied on top" is not a button.
    name: ref
      || (commit ? commit.short + (commit.subject ? ` “${commit.subject.slice(0, 44)}”` : '') : null)
      || name || role,
  };
}

/* Which side is more recent, decided once and stated on the sides themselves so no template
   has to compare two ISO strings. A tie is left unmarked rather than guessed. */
function markAges(a, b) {
  if (!a || !b || !a.date || !b.date) return;
  const ta = Date.parse(a.date), tb = Date.parse(b.date);
  if (!Number.isFinite(ta) || !Number.isFinite(tb) || ta === tb) return;
  a.age = ta > tb ? 'newer' : 'older';
  b.age = ta > tb ? 'older' : 'newer';
}

/*
 * Everything the UI needs in order to say what is going on — derived from the operation that
 * is actually in progress, never from the marker text.
 *
 * The rebase branch is why this is longer than a lookup table. Git writes the upstream side
 * into the `<<<<<<<` block and your own replayed commit into the `>>>>>>>` block, backwards
 * from every other operation here. That gets stated in words rather than left to be
 * discovered after twenty files have been resolved the wrong way round.
 */
async function describeOperation(dir) {
  const gd = await gitDirOf(dir);
  const at = (n) => path.join(gd || dir, n);
  const head = await commitAt(dir, 'HEAD');
  const { stdout: brOut } = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ({ stdout: '' }));
  const branch = brOut.trim() === 'HEAD' ? null : brOut.trim();

  const finish = async (kind, ours, theirs, extra) => {
    markAges(ours, theirs);
    let base = null;
    if (ours.sha && theirs.sha) {
      const { stdout } = await git(dir, ['merge-base', ours.sha, theirs.sha]).catch(() => ({ stdout: '' }));
      const mb = stdout.trim();
      if (mb) {
        base = makeSide('base', {
          marker: '|||||||', role: 'The common ancestor — what both sides started from',
          ref: null, commit: await commitAt(dir, mb),
        });
      }
    }
    return Object.assign({ kind, ours, theirs, base, active: true }, extra);
  };

  if (gd && existsAt(at('MERGE_HEAD'))) {
    const heads = (readIf(at('MERGE_HEAD')) || '').split('\n').filter(Boolean);
    const incoming = await commitAt(dir, heads[0] || 'MERGE_HEAD');
    const incomingRef = await exactName(dir, heads[0] || 'MERGE_HEAD');
    const ours = makeSide('ours', {
      marker: '<<<<<<<', role: 'The branch you are on', ref: branch, commit: head,
    });
    const theirs = makeSide('theirs', {
      marker: '>>>>>>>', role: 'The branch being merged in', ref: incomingRef, commit: incoming,
    });
    return finish('merge', ours, theirs, {
      swapped: false,
      headline: `Merging ${theirs.name} into ${ours.name}`,
      direction: `The first block of every conflict (${'<<<<<<<'}) is ${ours.name} — the branch ` +
        `you are on. The second (${'>>>>>>>'}) is ${theirs.name} — the branch you asked to merge in.`,
      octopus: heads.length > 1 ? heads.length : 0,
    });
  }

  if (gd && (existsAt(at('rebase-merge')) || existsAt(at('rebase-apply')))) {
    const d = existsAt(at('rebase-merge')) ? at('rebase-merge') : at('rebase-apply');
    const onto = readIf(path.join(d, 'onto'));
    const headName = (readIf(path.join(d, 'head-name')) || '').replace(/^refs\/heads\//, '');
    const stopped = readIf(path.join(d, 'stopped-sha')) || readIf(path.join(d, 'original-commit'));
    const ontoRef = onto ? await exactName(dir, onto) : null;
    const ours = makeSide('ours', {
      marker: '<<<<<<<',
      role: 'The branch you are replaying onto — not your work',
      ref: ontoRef, commit: onto ? await commitAt(dir, onto) : head,
      hint: 'During a rebase this side is the upstream, even though the marker says HEAD.',
    });
    const theirs = makeSide('theirs', {
      marker: '>>>>>>>',
      role: 'Your own commit, being replayed',
      ref: null, commit: stopped ? await commitAt(dir, stopped) : null,
      hint: 'Your work really is the second block here. Git names the sides from the rebase\'s point of view.',
    });
    return finish('rebase', ours, theirs, {
      swapped: true,
      headline: `Rebasing ${headName || 'this branch'} onto ${ours.name}`,
      direction: `Careful — a rebase reverses the usual sides. The first block (${'<<<<<<<'}) is ` +
        `${ours.name}, the branch you are replaying onto. The second (${'>>>>>>>'}) is ` +
        `${theirs.name} — your own commit. Keeping the block marked HEAD throws away YOUR change.`,
    });
  }

  if (gd && existsAt(at('CHERRY_PICK_HEAD'))) {
    const picked = readIf(at('CHERRY_PICK_HEAD'));
    const ours = makeSide('ours', { marker: '<<<<<<<', role: 'The branch you are on', ref: branch, commit: head });
    const theirs = makeSide('theirs', {
      marker: '>>>>>>>', role: 'The commit being cherry-picked in',
      ref: null, commit: picked ? await commitAt(dir, picked) : null,
    });
    return finish('cherry-pick', ours, theirs, {
      swapped: false,
      headline: `Cherry-picking ${theirs.name} onto ${ours.name}`,
      direction: `The first block (${'<<<<<<<'}) is ${ours.name} as it stands. The second ` +
        `(${'>>>>>>>'}) is the commit you are copying in.`,
    });
  }

  if (gd && existsAt(at('REVERT_HEAD'))) {
    const reverted = readIf(at('REVERT_HEAD'));
    const ours = makeSide('ours', { marker: '<<<<<<<', role: 'The branch you are on', ref: branch, commit: head });
    const theirs = makeSide('theirs', {
      marker: '>>>>>>>', role: 'The undo of the reverted commit',
      ref: null, commit: reverted ? await commitAt(dir, reverted) : null,
      hint: 'This side is that commit run backwards — what the file looked like before it landed.',
    });
    return finish('revert', ours, theirs, {
      swapped: false,
      headline: `Reverting ${theirs.name}`,
      direction: `The first block (${'<<<<<<<'}) is your branch now. The second (${'>>>>>>>'}) ` +
        'is the state the revert wants to put back.',
    });
  }

  /*
   * No operation file, but unmerged paths — which is what `git stash pop` onto a moved tree
   * leaves behind. Worth its own branch because `--abort` does not exist for it: someone
   * hunting for the Abort button will not find one, so this says the stash is still intact
   * instead of leaving them to work that out.
   */
  const ours = makeSide('ours', {
    marker: '<<<<<<<', role: 'Your branch as it is now', ref: branch, commit: head,
  });
  const theirs = makeSide('theirs', {
    marker: '>>>>>>>', role: 'The changes being applied on top', ref: null, commit: null,
    name: 'the incoming changes',
    hint: 'Usually a stash being restored, or a patch being applied.',
  });
  const out = await finish('apply', ours, theirs, {
    swapped: false,
    headline: 'Applying changes onto ' + (ours.name || 'this branch'),
    direction: `The first block (${'<<<<<<<'}) is your branch. The second (${'>>>>>>>'}) is ` +
      'the incoming change being laid on top.',
    noAbort: true,
    note: 'Nothing to abort here — if this came from a stash, the stash is still in the list ' +
      'until you drop it.',
  });
  out.active = false;
  return out;
}

/* ── the conflict marker parser ──────────────────────────────────── */

const RE_START = /^<{7}(?:\s(.*))?$/;
const RE_BASE = /^\|{7}(?:\s(.*))?$/;
const RE_MID = /^={7}$/;
const RE_END = /^>{7}(?:\s(.*))?$/;

/* Cheap pre-check for "does this file still have anything to resolve", used where parsing
   the whole thing would be wasted work. */
const HAS_MARKERS = /^<{7}(\s|$)/m;

/*
 * Split a working-tree file into alternating plain text and conflict regions.
 *
 * Deliberately literal: a marker counts only at the very start of a line and only with
 * exactly seven characters, which is what git writes. Anything looser starts eating prose
 * that talks ABOUT conflict markers — including this repository's own README.
 */
function parseConflicts(content) {
  const lines = String(content == null ? '' : content).split('\n');
  const parts = [];
  let plain = [];
  let i = 0;
  const flush = () => { if (plain.length) { parts.push({ type: 'text', lines: plain }); plain = []; } };

  while (i < lines.length) {
    const m = RE_START.exec(lines[i]);
    if (!m) { plain.push(lines[i]); i++; continue; }
    const start = i;
    const ours = [], base = [], theirs = [];
    let bucket = ours, sawBase = false, closed = false;
    const oursLabel = (m[1] || '').trim();
    let baseLabel = '', theirsLabel = '';
    i++;
    while (i < lines.length) {
      const l = lines[i];
      const mb = RE_BASE.exec(l);
      if (mb && bucket === ours) { sawBase = true; baseLabel = (mb[1] || '').trim(); bucket = base; i++; continue; }
      if (RE_MID.test(l) && bucket !== theirs) { bucket = theirs; i++; continue; }
      const me = RE_END.exec(l);
      if (me && bucket === theirs) { theirsLabel = (me[1] || '').trim(); closed = true; i++; break; }
      bucket.push(l);
      i++;
    }
    if (!closed) {
      // An unterminated marker means a damaged file, not a conflict. Put the lines back
      // verbatim rather than silently rewriting whatever followed.
      plain.push(...lines.slice(start, i));
      continue;
    }
    flush();
    parts.push({
      type: 'conflict', ours, theirs, base: sawBase ? base : null,
      labels: { ours: oursLabel, base: baseLabel, theirs: theirsLabel },
      startLine: start + 1, endLine: i,
    });
  }
  flush();
  return parts;
}

const CHOICES = new Set(['ours', 'theirs', 'both', 'both-reversed', 'base', 'custom']);

/* Turn one conflict region back into ordinary lines, according to a decision. */
function applyChoice(part, choice, custom) {
  if (choice === 'ours') return part.ours;
  if (choice === 'theirs') return part.theirs;
  if (choice === 'both') return part.ours.concat(part.theirs);
  if (choice === 'both-reversed') return part.theirs.concat(part.ours);
  if (choice === 'base') {
    if (!part.base) bad('That conflict has no recorded common ancestor to fall back to');
    return part.base;
  }
  if (choice === 'custom') return String(custom == null ? '' : custom).split('\n');
  bad('Unknown resolution choice');
  return [];
}

/*
 * Serialize back to file text.
 *
 * The conflict branch is not optional and its absence is not a cosmetic bug: resolving one
 * hunk in a file that has three would write out only the resolved one and SILENTLY DELETE the
 * other two, markers, both sides and all. Anything still unresolved has to come back exactly
 * as git wrote it, down to the marker labels, so a partial resolution is genuinely partial.
 */
function renderParts(parts) {
  const out = [];
  for (const p of parts) {
    if (p.type === 'text') { out.push(...p.lines); continue; }
    const tail = (s) => (s ? ' ' + s : '');
    out.push('<<<<<<<' + tail(p.labels.ours));
    out.push(...p.ours);
    if (p.base) {
      out.push('|||||||' + tail(p.labels.base));
      out.push(...p.base);
    }
    out.push('=======');
    out.push(...p.theirs);
    out.push('>>>>>>>' + tail(p.labels.theirs));
  }
  return out.join('\n');
}

const fingerprint = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16);

/* ── path safety ─────────────────────────────────────────────────── */

/*
 * Every write below starts here. A path is acceptable only if git just said it is unmerged,
 * which makes the writable set exactly the set of files the conflict created — a traversal
 * string or a path outside the repository cannot survive the membership test.
 */
const NO_BLOB = '0000000000000000000000000000000000000000';

async function unmergedFiles(dir) {
  const { stdout } = await git(dir, ['status', '--porcelain=v2', '--untracked-files=no']);
  const out = [];
  for (const line of stdout.split('\n')) {
    if (!line || line[0] !== 'u') continue;
    // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
    const parts = line.split(' ');
    const xy = parts[1] || '';
    const blobs = { base: parts[7], ours: parts[8], theirs: parts[9] };
    const p = parts.slice(10).join(' ');
    const info = KINDS[xy] || { kind: 'both-modified', title: 'Both sides changed this file', markers: true };
    /*
     * The two sides can be byte-for-byte identical and still be reported as a conflict.
     *
     * It happens whenever the disagreement is about the PATH rather than the contents — both
     * branches moving the same file into differently-named folders, or both adding the same
     * asset in different places. Git records a conflict because it cannot decide where the
     * file belongs, and the status letters say "both added" or "both modified" without ever
     * mentioning that the content question has no question in it.
     *
     * Left unsaid this is genuinely baffling: the view offers a choice between two things
     * that are the same, and neither the diff nor an image preview shows any difference,
     * because there is none. So it gets said, and the choice gets marked as free.
     */
    const identical = blobs.ours !== NO_BLOB && blobs.ours === blobs.theirs;
    out.push({
      path: p, xy, kind: info.kind, title: info.title, expectMarkers: info.markers,
      blobs,
      identical,
      // Stronger still: nothing changed on either side relative to the ancestor.
      untouched: identical && blobs.base === blobs.ours,
    });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

async function assertUnmerged(dir, file) {
  const p = String(file || '');
  if (!p) bad('file is required');
  const hit = (await unmergedFiles(dir)).find(f => f.path === p);
  if (!hit) bad(`"${p}" is not one of the conflicted files — refresh and try again`);
  return hit;
}

function absoluteInside(dir, file) {
  const root = path.resolve(dir);
  const abs = path.resolve(root, file);
  if (abs !== root && !abs.startsWith(root + path.sep)) bad('That path is outside the repository');
  return abs;
}

/*
 * Is this file finished?
 *
 * The `expectMarkers` half is the whole point. A modify/delete conflict leaves one side's
 * file sitting in the working tree with no markers in it at all, so "no markers left" reads
 * as done and is not — the disagreement is about whether the file should exist, and that
 * answer lives in the index, not in the text. Judging by markers alone let Continue sail
 * straight past an undecided deletion and commit one side by accident.
 */
function isReady(dir, info) {
  if (!info.expectMarkers) return false;
  const w = readWorking(dir, info.path);
  /*
   * No readable text means readiness cannot be observed from the file, and answering "false"
   * here without also making the decision stage the file is a DEAD END: a conflicted PNG has
   * no markers to remove, so it could never become ready, so Continue refused forever and
   * "Mark resolved" refused too — with "still has conflict markers in it", about a file that
   * has never had one. resolveFile() stages these instead, so a decided binary leaves the
   * unmerged list entirely rather than needing to be called ready.
   */
  return w.content != null && !HAS_MARKERS.test(w.content);
}

/* Whether a decision about this file has to be recorded in the index rather than shown in the
   working tree. True for binary, for anything too large to read, and for the kinds that are
   about the file's existence rather than its contents. */
function needsIndexDecision(dir, info) {
  if (!info.expectMarkers) return true;
  const w = readWorking(dir, info.path);
  return w.content == null;
}

/* Read a working file, tolerating the several legitimate ways it may not be readable. */
function readWorking(dir, filePath) {
  const abs = absoluteInside(dir, filePath);
  try {
    const st = fs.statSync(abs);
    if (st.size > MAX_FILE) return { tooBig: true, binary: false, content: null };
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return { tooBig: false, binary: true, content: null };
    return { tooBig: false, binary: false, content: buf.toString('utf8') };
  } catch {
    return { tooBig: false, binary: false, content: null, missing: true };
  }
}

/* ── the resolution options a given conflict kind actually has ───── */

/*
 * Built on the server, because the server is the only side that knows the branch names. A
 * button reading "Use all of origin/main" is a decision; a button reading "Use theirs" is a
 * coin flip.
 *
 * `destructive` marks the options that cannot be reopened afterwards — anything that removes
 * the file from the index takes the recorded stages with it. The UI arms those.
 */
/*
 * The sentence to print when the two sides are not actually in dispute.
 *
 * Written out in full because the situation reads as a bug in the tool. Someone looking at
 * two identical sprites, told to choose between them, reasonably concludes the app is
 * confused — when in fact git is asking a question about the file's PATH and has no way to
 * say so in a status letter.
 */
function describeSameness(f, op) {
  if (!f.identical) return null;
  const what = f.untouched
    ? 'Neither branch changed this file — the ancestor, ' +
      `${op.ours.name} and ${op.theirs.name} are all the same bytes.`
    : `${op.ours.name} and ${op.theirs.name} hold byte-for-byte identical contents here.`;
  /*
   * Naming git's own term matters. "CONFLICT (file location)" is what it printed during the
   * merge and then threw away — the porcelain status keeps only "both added", which describes
   * the symptom and hides the cause. Someone searching for why two identical sprites conflict
   * needs the phrase git uses, not ours.
   */
  const why = f.kind === 'both-added'
    ? ' Both branches added it independently, at paths that only agreed after git worked out ' +
      'that one side had renamed the folder around it.'
    : ' The two branches moved it into differently-named folders.';
  return {
    identical: true,
    untouched: !!f.untouched,
    headline: 'Identical on both sides — the disagreement is about where the file goes',
    detail: what + why +
      ' Git calls this a "file location" conflict; it cannot pick a folder for you, so it ' +
      'stops. There is nothing to compare and nothing to lose: either option leaves exactly ' +
      `the same file at ${f.path}.`,
  };
}

function optionsFor(kind, op) {
  const ours = op.ours.name, theirs = op.theirs.name;
  const opt = (id, label, hint, destructive) => ({ id, label, hint: hint || '', destructive: !!destructive });
  if (kind === 'both-modified' || kind === 'both-added') {
    return [
      opt('ours', `Use all of ${ours}`, `Every change from ${theirs} in this file is dropped.`),
      opt('theirs', `Use all of ${theirs}`, `Every change from ${ours} in this file is dropped.`),
    ];
  }
  if (kind === 'deleted-by-them') {
    return [
      opt('keep', `Keep the file — ${ours} still changes it`, `The deletion from ${theirs} is dropped.`, true),
      opt('delete', `Accept the deletion from ${theirs}`, `Your changes on ${ours} go with it.`, true),
    ];
  }
  if (kind === 'deleted-by-us') {
    return [
      opt('delete', `Keep it deleted, as on ${ours}`, `The changes from ${theirs} go with it.`, true),
      opt('keep-theirs', `Restore the file from ${theirs}`, 'Your deletion is undone.', true),
    ];
  }
  if (kind === 'added-by-us') {
    return [
      opt('keep', `Keep the file added on ${ours}`, '', true),
      opt('delete', `Drop it — ${theirs} does not have it`, '', true),
    ];
  }
  if (kind === 'added-by-them') {
    return [
      opt('keep-theirs', `Take the file added on ${theirs}`, '', true),
      opt('delete', 'Do not add it', `It stays absent, as on ${ours}.`, true),
    ];
  }
  if (kind === 'both-deleted') {
    return [opt('delete', 'Confirm the deletion', 'Both sides deleted it; this records that.', true)];
  }
  return [];
}

/* ── read: the whole picture ─────────────────────────────────────── */

/*
 * The list the sidebar draws. `ready` is the thing that makes the list navigable: a file
 * whose markers are all gone is finished even though git still calls it unmerged, and
 * without that distinction the list is a flat wall of red that never visibly shrinks.
 */
async function state(dir) {
  const files = await unmergedFiles(dir);
  const op = await describeOperation(dir);
  const rows = files.map((f) => {
    const w = readWorking(dir, f.path);
    const parsed = w.content == null ? null : parseConflicts(w.content);
    const open = parsed ? parsed.filter(p => p.type === 'conflict').length : 0;
    return Object.assign({}, f, {
      options: optionsFor(f.kind, op),
      binary: w.binary, tooBig: w.tooBig, missing: !!w.missing,
      image: images.isImage(f.path),
      hunks: open,
      ready: isReady(dir, f),
      note: describeSameness(f, op),
    });
  });
  const ready = rows.filter(r => r.ready).length;
  return {
    ok: true,
    inProgress: files.length > 0 || op.active,
    operation: op,
    files: rows,
    total: rows.length,
    ready,
    remaining: rows.length - ready,
    canContinue: rows.length > 0 && rows.length === ready,
    // Nothing unmerged left at all: everything is staged and the operation just needs closing.
    canFinish: rows.length === 0 && op.active,
    continueLabel: op.kind === 'merge' ? 'Commit the merge'
      : op.kind === 'rebase' ? 'Continue the rebase'
        : op.kind === 'cherry-pick' ? 'Continue the cherry-pick'
          : op.kind === 'revert' ? 'Continue the revert'
            : 'Finish up',
    canAbort: !op.noAbort && op.active,
    canSkip: op.kind === 'rebase' || op.kind === 'cherry-pick' || op.kind === 'revert',
  };
}

/*
 * One conflicted file, parsed into decisions.
 *
 * The three stage blobs come along even when the file has markers, because "show me their
 * whole file" is a question markers cannot answer — a conflict only ever shows the disputed
 * regions, and the surrounding agreement is often the context that decides it.
 */
async function file(dir, filePath) {
  const info = await assertUnmerged(dir, filePath);
  const op = await describeOperation(dir);

  const stageText = async (n) => {
    const { stdout } = await git(dir, ['show', `:${n}:${info.path}`]).catch(() => ({ stdout: null }));
    return stdout == null ? null : stdout.slice(0, MAX_FILE);
  };
  const [baseText, oursText, theirsText] = await Promise.all([stageText(1), stageText(2), stageText(3)]);

  const w = readWorking(dir, info.path);
  const parts = w.content == null ? [] : parseConflicts(w.content);
  const hunks = [];
  parts.forEach((p, idx) => {
    if (p.type !== 'conflict') return;
    hunks.push({
      index: idx,
      n: hunks.length + 1,
      startLine: p.startLine, endLine: p.endLine,
      ours: p.ours, theirs: p.theirs, base: p.base,
      // Git's own marker text, kept so this screen can be lined up against an editor showing
      // the same file. Shown as a footnote, never as the authoritative label.
      labels: p.labels,
      identical: p.ours.join('\n') === p.theirs.join('\n'),
      context: { before: contextBefore(parts, idx, 3), after: contextAfter(parts, idx, 3) },
    });
  });

  return {
    ok: true,
    path: info.path,
    kind: info.kind, title: info.title, expectMarkers: info.expectMarkers,
    operation: op,
    options: optionsFor(info.kind, op),
    binary: w.binary, tooBig: w.tooBig, missing: !!w.missing,
    image: images.isImage(info.path),
    identical: !!info.identical, untouched: !!info.untouched,
    note: describeSameness(info, op),
    hunks, hunkCount: hunks.length,
    content: w.content,
    fingerprint: w.content == null ? null : fingerprint(w.content),
    sides: { base: baseText, ours: oursText, theirs: theirsText },
    // No markers left: one click from done, and saying so is the difference between "why is
    // this still red" and a button.
    ready: isReady(dir, info),
  };
}

function contextBefore(parts, idx, n) {
  const prev = parts[idx - 1];
  return prev && prev.type === 'text' ? prev.lines.slice(-n) : [];
}
function contextAfter(parts, idx, n) {
  const next = parts[idx + 1];
  return next && next.type === 'text' ? next.lines.slice(0, n) : [];
}

/* ── write ───────────────────────────────────────────────────────── */

/*
 * Writing the working file is the one mutation here that is not a git subprocess, so it
 * cannot ride on gitWrite's --dry-run interception and has to check for itself. Missing this
 * would make dry-run silently destructive, which is worse than not offering dry-run at all.
 */
function writeWorking(dir, filePath, content) {
  if (isDryRun()) return { dryRun: true };
  fs.writeFileSync(absoluteInside(dir, filePath), content, 'utf8');
  return { dryRun: false };
}

/*
 * Resolve some or all of a file's conflicts, in place, without staging.
 *
 * `expect` is the fingerprint the browser last saw. Changes polls every four seconds and
 * people edit these files in a real editor at the same time, so writing back a decision made
 * against content that has since moved would silently revert their edit. A mismatch is a
 * refusal, not a merge.
 */
async function resolveHunks(dir, filePath, choices, { expect = null } = {}) {
  const info = await assertUnmerged(dir, filePath);
  const w = readWorking(dir, info.path);
  if (w.content == null) {
    bad('That file has no text to edit — use one of the whole-file options instead');
  }
  const now = fingerprint(w.content);
  if (expect && expect !== now) {
    bad('The file changed since this screen was drawn — reopen the conflict and choose again');
  }
  const parts = parseConflicts(w.content);
  const list = Array.isArray(choices) ? choices : [];
  if (!list.length) bad('No resolution was chosen');
  if (list.length > 500) bad('That is more conflicts than one request should carry');

  for (const c of list) {
    const idx = Number(c && c.index);
    if (!Number.isInteger(idx) || !parts[idx] || parts[idx].type !== 'conflict') {
      bad('That conflict is no longer at that position — reopen the file and choose again');
    }
    const choice = String((c && c.choice) || '');
    if (!CHOICES.has(choice)) bad('Unknown resolution choice');
    const custom = choice === 'custom'
      ? (text(c.text == null ? '' : c.text, 'replacement text', 200000, { required: false }) || '')
      : null;
    parts[idx] = { type: 'text', lines: applyChoice(parts[idx], choice, custom) };
  }

  const next = renderParts(parts);
  const written = writeWorking(dir, info.path, next);
  const left = parseConflicts(next).filter(p => p.type === 'conflict').length;
  return {
    ok: true, dryRun: !!written.dryRun, path: info.path,
    remaining: left, fingerprint: fingerprint(next),
    message: written.dryRun
      ? `Would resolve ${list.length} conflict${list.length === 1 ? '' : 's'} in ${info.path}`
      : left === 0
        ? `${info.path} has no conflicts left`
        : `Resolved ${list.length} — ${left} still open in ${info.path}`,
  };
}

/* Replace the whole file with hand-edited text. The marker check is a guard rail, not a rule:
   someone deliberately keeping a marker can say so and save anyway. */
async function resolveText(dir, filePath, raw, { expect = null, force = false } = {}) {
  const info = await assertUnmerged(dir, filePath);
  if (typeof raw !== 'string') bad('text is required');
  if (raw.length > MAX_FILE) bad('That is larger than this editor will write back');
  if (expect) {
    const current = readWorking(dir, info.path);
    if (fingerprint(current.content == null ? '' : current.content) !== expect) {
      bad('The file changed since you started editing — reopen it so you do not overwrite that change');
    }
  }
  const left = parseConflicts(raw).filter(p => p.type === 'conflict').length;
  if (left && !force) {
    bad(`That still contains ${left} conflict block${left === 1 ? '' : 's'}. Remove them, ` +
      'or save again with "keep the markers" if you meant to.');
  }
  const written = writeWorking(dir, info.path, raw);
  return {
    ok: true, dryRun: !!written.dryRun, path: info.path, remaining: left,
    fingerprint: fingerprint(raw),
    message: written.dryRun ? `Would save ${info.path}`
      : left ? `Saved ${info.path} — ${left} conflict block${left === 1 ? '' : 's'} left in it`
        : `${info.path} saved with no conflicts left`,
  };
}

/*
 * Whole-file decisions, including the four kinds that have no markers to choose between.
 *
 * `git checkout --ours` is right only for both-modified and both-added; for a delete/modify
 * conflict it fails with "does not have our version", which reads as a bug in the app rather
 * than as "that side deleted the file". So each kind gets the command that actually expresses
 * the decision — and the two content options deliberately stop short of `git add`, leaving
 * the file reopenable.
 */
async function resolveFile(dir, filePath, optionId) {
  const info = await assertUnmerged(dir, filePath);
  const id = String(optionId || '');
  const valid = new Set(optionsFor(info.kind, await describeOperation(dir)).map(o => o.id));
  if (!valid.has(id)) bad('That option does not apply to this conflict');
  const label = `resolve ${info.path}`;
  let reopenable = true;

  if (id === 'ours' || id === 'theirs') {
    await gitWrite(dir, ['checkout', '--' + id, '--', info.path], { label, fakeStdout: '' });
    /*
     * A text file is left unstaged so the markers can be put back. A binary one cannot show
     * that a choice was made — the working file looks the same either way — so the choice is
     * recorded in the index immediately. Otherwise the file stays unmerged with nothing
     * observable to distinguish "decided" from "untouched", and the merge cannot finish.
     */
    if (needsIndexDecision(dir, info)) {
      await gitWrite(dir, ['add', '--', info.path], { label: 'record choice', fakeStdout: '' });
      reopenable = false;
    }
  } else if (id === 'delete') {
    await gitWrite(dir, ['rm', '-f', '--', info.path], { label, fakeStdout: '' });
    reopenable = false;
  } else if (id === 'keep') {
    // Our side's content is already on disk; recording it in the index IS the decision.
    await gitWrite(dir, ['add', '--', info.path], { label, fakeStdout: '' });
    reopenable = false;
  } else if (id === 'keep-theirs') {
    const { stdout } = await git(dir, ['show', `:3:${info.path}`]).catch(() => ({ stdout: null }));
    if (stdout == null) bad('The incoming side has no version of that file to restore');
    writeWorking(dir, info.path, stdout);
    await gitWrite(dir, ['add', '--', info.path], { label, fakeStdout: '' });
    reopenable = false;
  }

  /*
   * Count what still needs a DECISION, not what is still unmerged. A file whose markers are
   * gone but which has not been staged yet is finished as far as the person is concerned, and
   * telling them three files are still conflicted when two of them are done is how a progress
   * count stops being believed.
   */
  const left = (await unmergedFiles(dir)).filter(f => !isReady(dir, f));
  return {
    ok: true, dryRun: isDryRun(), path: info.path, reopenable,
    remaining: left.length,
    message: (isDryRun() ? 'Would resolve ' : 'Resolved ') + info.path +
      (left.length ? ` — ${left.length} file${left.length === 1 ? '' : 's'} still to decide`
        : ' — every conflict is resolved'),
  };
}

/*
 * Put a file back the way the conflict left it.
 *
 * The escape hatch for a decision made too fast: `checkout --merge` regenerates the markers
 * from the stages git recorded, so trying an option and changing your mind costs nothing.
 * `--conflict=diff3` does the same and adds the common ancestor between the two sides, which
 * is the single most useful thing you can do to a conflict you cannot read — it shows what
 * each side actually CHANGED rather than only what each side ended up with.
 */
async function reopen(dir, filePath, { withAncestor = false } = {}) {
  const info = await assertUnmerged(dir, filePath);
  if (!info.expectMarkers) {
    bad('That conflict is about whether the file exists, not about its contents — there are no markers to restore');
  }
  const args = ['checkout', withAncestor ? '--conflict=diff3' : '--merge', '--', info.path];
  await gitWrite(dir, args, { label: 'reopen conflict', fakeStdout: '' });
  return {
    ok: true, dryRun: isDryRun(), path: info.path,
    message: (isDryRun() ? 'Would restore ' : 'Restored ') + info.path + ' to its conflicted state' +
      (withAncestor ? ', with the common ancestor shown between the two sides' : ''),
  };
}

/*
 * Stage the files whose markers are gone. Separate from proceed() because "record what I have
 * finished" and "close the operation" are different intentions, and only the first is safe to
 * do while you are still working.
 */
async function markResolved(dir, paths) {
  const list = (Array.isArray(paths) ? paths : []).map(String).filter(Boolean);
  if (!list.length) bad('Pick at least one file');
  const known = new Map((await unmergedFiles(dir)).map(f => [f.path, f]));
  for (const p of list) {
    const info = known.get(p);
    if (!info) bad(`"${p}" is not one of the conflicted files`);
    // "Still has conflict markers" is the wrong complaint about a PNG, which has never had
    // one. Point at the options that actually apply instead.
    if (needsIndexDecision(dir, info)) {
      bad(`"${p}" has no text to mark as done — ${info.title.toLowerCase()}. ` +
        'Pick one of its whole-file options instead.');
    }
    if (!isReady(dir, info)) bad(`"${p}" still has conflict markers in it — resolve them first`);
  }
  await gitWrite(dir, ['add', '--', ...list], { label: 'mark resolved', fakeStdout: '' });
  const left = (await unmergedFiles(dir)).filter(f => !isReady(dir, f)).length;
  return {
    ok: true, dryRun: isDryRun(), remaining: left,
    message: `Marked ${list.length} file${list.length === 1 ? '' : 's'} resolved` +
      (left ? ` — ${left} still to decide` : ' — every conflict is resolved'),
  };
}

/*
 * Finish the operation.
 *
 * Staging is done here rather than at each resolution, so every decision stays reversible for
 * as long as possible. Anything still carrying markers is a refusal by name — git's own
 * refusal is three lines of porcelain deep and is where people give up and open a terminal.
 */
async function proceed(dir, { subject, body } = {}) {
  const unmerged = await unmergedFiles(dir);
  const stuck = [];
  const finished = [];
  for (const f of unmerged) {
    if (isReady(dir, f)) finished.push(f.path);
    else stuck.push(f.path);
  }
  if (stuck.length) {
    bad(`${stuck.length} file${stuck.length === 1 ? ' is' : 's are'} still unresolved: ` +
      stuck.slice(0, 4).join(', ') + (stuck.length > 4 ? '…' : ''));
  }
  if (finished.length) {
    await gitWrite(dir, ['add', '--', ...finished], { label: 'stage resolved files', fakeStdout: '' });
  }

  const op = await describeOperation(dir);
  if (op.kind === 'merge') {
    const subj = text(subject, 'Commit summary', 500, { required: false });
    const args = subj ? ['commit', '-m', subj] : ['commit', '--no-edit'];
    if (subj) {
      const desc = text(body, 'Description', 20000, { required: false });
      if (desc) args.push('-m', desc);
    }
    const r = await gitWrite(dir, args, { label: 'finish merge', fakeStdout: '' });
    return {
      ok: true, dryRun: !!r.dryRun, done: true,
      message: (r.dryRun ? 'Would commit' : 'Committed') + ' the merge',
      detail: (r.stderr || r.stdout || '').trim().slice(0, 400),
    };
  }
  const verb = op.kind === 'rebase' ? 'rebase'
    : op.kind === 'cherry-pick' ? 'cherry-pick'
      : op.kind === 'revert' ? 'revert' : null;
  if (!verb) {
    // Applying a stash leaves nothing to continue — recording the files IS the finish.
    return {
      ok: true, done: true,
      message: 'Every conflict is resolved. Commit the result from the Changes view when you are ready.',
    };
  }
  const r = await gitWrite(dir, [verb, '--continue'], { label: 'continue ' + verb, fakeStdout: '' });
  const still = await unmergedFiles(dir);
  return {
    ok: true, dryRun: !!r.dryRun, done: still.length === 0, remaining: still.length,
    message: r.dryRun ? `Would continue the ${verb}`
      : still.length
        ? `Continued the ${verb} — the next commit conflicts too, in ${still.length} file(s)`
        : `Continued the ${verb}`,
    detail: (r.stderr || r.stdout || '').trim().slice(0, 400),
  };
}

/* A rebase can also be got past by dropping the commit that will not apply. Nothing else here
   has that shape, so it is its own action rather than a flag on proceed(). */
async function skip(dir) {
  const op = await describeOperation(dir);
  const verb = op.kind === 'rebase' ? 'rebase'
    : op.kind === 'cherry-pick' ? 'cherry-pick'
      : op.kind === 'revert' ? 'revert' : null;
  if (!verb) bad('There is nothing to skip in this operation');
  const r = await gitWrite(dir, [verb, '--skip'], { label: 'skip ' + verb, fakeStdout: '' });
  return {
    ok: true, dryRun: !!r.dryRun,
    message: (r.dryRun ? 'Would drop' : 'Dropped') +
      ' the conflicting commit and carried on with the ' + verb,
  };
}

/*
 * Bounded context for the assistant. The sides go over as blocks labelled with the branch
 * names already substituted, so the model is never asked to work out which of "ours" and
 * "theirs" means what — the same mistake this whole module exists to prevent.
 */
async function aiContext(dir, filePath, hunkIndex) {
  const detail = await file(dir, filePath);
  if (!detail.hunks.length) bad('That file has no conflict markers left to resolve');
  const wanted = hunkIndex == null || hunkIndex === ''
    ? detail.hunks
    : detail.hunks.filter(hunk => hunk.index === Number(hunkIndex));
  if (!wanted.length) bad('That conflict is no longer there — reopen the file and try again');
  const cap = 6;
  const clip = (lines, max) => {
    const joined = (lines || []).join('\n');
    return joined.length > max ? joined.slice(0, max) + '\n… (truncated)' : joined;
  };
  return {
    path: detail.path,
    operation: detail.operation,
    truncated: wanted.length > cap,
    hunks: wanted.slice(0, cap).map(hunk => ({
      index: hunk.index, n: hunk.n,
      before: clip(hunk.context.before, 700),
      after: clip(hunk.context.after, 700),
      ours: clip(hunk.ours, 4000),
      theirs: clip(hunk.theirs, 4000),
      base: hunk.base ? clip(hunk.base, 4000) : null,
    })),
  };
}

module.exports = {
  state, file, resolveHunks, resolveText, resolveFile, reopen, markResolved,
  proceed, skip, aiContext,
  parseConflicts, describeOperation, unmergedFiles,
};
