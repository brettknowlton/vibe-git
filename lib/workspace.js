'use strict';
/*
 * Read-only access to the checked-out working tree, for the assistant.
 *
 * This module exists because of a specific, repeated failure. The assistant could see the
 * issue tracker and the planning document but never the CODE, so it proposed work that was
 * already finished — "implement dependency tracking" for a tracker whose lib/search.js has
 * had a dependencies() function for weeks. From inside the tracker those two situations look
 * identical: an open issue and no closing commit. The only thing that tells them apart is the
 * repository, and until now nothing let the model look at it.
 *
 * EVERYTHING GOES THROUGH GIT, and that is a security decision rather than a convenience one:
 *
 *   - `git ls-files` lists only TRACKED files. An untracked .env, a stray id_rsa, a
 *     downloaded dump — none of them are listed, none of them are readable, and no
 *     allow-list had to anticipate them. What is in the repository is, by definition, what
 *     the user already publishes to their remote.
 *   - Every path handed back to read is checked against that same list, so path traversal
 *     has nothing to traverse to: "../../.ssh/id_rsa" is simply not a tracked file.
 *   - `git grep` searches the same set, and -I keeps binaries out of the results.
 *
 * Sizes are bounded at every step, because this output is going into a model context window
 * that also has to hold the conversation.
 */

const { git } = require('./exec');

const MAX_FILES = 4000;            // a big repo's tracked list, before any filtering
const MAX_READ_BYTES = 60000;      // one file, into a prompt
const MAX_MATCHES = 60;

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

/* The tracked file list, cached per directory for the life of one request chain. Repeated
 * tool calls in a single conversation turn should not re-run ls-files each time. */
async function trackedFiles(dir) {
  const { stdout } = await git(dir, ['ls-files', '-z']);
  return stdout.split('\0').filter(Boolean).slice(0, MAX_FILES);
}

/*
 * The file list, optionally narrowed. `prefix` matches a directory or path fragment and
 * `ext` a file extension, because those two cover almost every question worth asking
 * ("what is in lib/", "which markdown files exist") without inventing a glob language.
 */
async function listFiles(dir, { prefix = '', ext = '', limit = 200 } = {}) {
  const all = await trackedFiles(dir);
  const want = String(prefix || '').replace(/^\.?\//, '').toLowerCase();
  const suffix = String(ext || '').replace(/^\./, '').toLowerCase();
  const hits = all.filter(f => {
    const low = f.toLowerCase();
    if (want && !low.includes(want)) return false;
    if (suffix && !low.endsWith('.' + suffix)) return false;
    return true;
  });
  return {
    total: all.length,
    matched: hits.length,
    files: hits.slice(0, Math.max(1, Math.min(limit, 400))),
  };
}

/*
 * One tracked file. Line numbers are prefixed because the whole point of reading a file here
 * is to be able to say "lib/search.js:316 already does this" in a proposal, and a model that
 * has to count lines itself will get it wrong.
 */
async function readFile(dir, file, { maxBytes = MAX_READ_BYTES, fromLine = 0, maxLines = 600 } = {}) {
  const rel = String(file || '').replace(/^\.?\//, '');
  if (!rel) return { error: 'read_file needs a path' };
  const all = await trackedFiles(dir);
  if (!all.includes(rel)) {
    // Near-misses are the common case (a guessed path, a wrong directory), and listing them
    // turns a dead end into the next useful call.
    const base = rel.split('/').pop().toLowerCase();
    const near = all.filter(f => f.toLowerCase().includes(base)).slice(0, 8);
    return {
      error: `"${rel}" is not a tracked file in this repository`,
      didYouMean: near,
    };
  }
  // `git show :path` reads the index copy through the same execFile path as everything
  // else, so no filesystem path from the request ever reaches fs.
  const { stdout } = await git(dir, ['show', ':' + rel])
    .catch(async () => git(dir, ['show', 'HEAD:' + rel]));
  const text = stdout.slice(0, Math.max(1000, Math.min(maxBytes, MAX_READ_BYTES)));
  const lines = text.split('\n');
  const start = Math.max(0, Number(fromLine) || 0);
  const take = Math.max(20, Math.min(Number(maxLines) || 600, 1200));
  const slice = lines.slice(start, start + take);
  return {
    path: rel,
    lines: lines.length,
    from: start + 1,
    to: Math.min(lines.length, start + slice.length),
    truncated: stdout.length > text.length || start + slice.length < lines.length,
    content: slice.map((l, k) => `${start + k + 1}\t${l}`).join('\n'),
  };
}

/*
 * Fixed-string search across tracked files. Deliberately NOT a regex: the caller is a model
 * that will happily send an unanchored .* over a large repository, and a literal search is
 * both what it usually means and the one that cannot take a second to run.
 */
async function searchCode(dir, query, { limit = MAX_MATCHES, ext = '' } = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) return { error: 'search_code needs at least two characters' };
  const args = ['grep', '--no-color', '-n', '-I', '-i', '-F',
    '--max-count=4', '-e', q];
  if (ext) args.push('--', '*.' + String(ext).replace(/^\./, ''));
  // git grep exits non-zero with no output when nothing matched, which is not an error here.
  const { stdout } = await git(dir, args).catch(() => ({ stdout: '' }));
  const rows = stdout.split('\n').filter(Boolean).slice(0, Math.max(1, Math.min(limit, MAX_MATCHES)));
  return {
    query: q,
    matches: rows.map(line => {
      const m = /^([^:]+):(\d+):([\s\S]*)$/.exec(line);
      return m
        ? { file: m[1], line: Number(m[2]), text: clip(m[3].trim(), 240) }
        : { file: null, line: null, text: clip(line, 240) };
    }),
    note: rows.length >= MAX_MATCHES ? 'Results were capped; narrow the query.' : null,
  };
}

/*
 * A compact map of the repository for prompts that cannot call tools — the one-shot pipelines
 * (suggest, plan) that get a single turn and no chance to look anything up. Directories with
 * many files are summarised rather than listed, so a node_modules-shaped tree cannot eat the
 * whole budget.
 */
async function fileMap(dir, { maxChars = 2500 } = {}) {
  let all;
  try { all = await trackedFiles(dir); } catch { return null; }
  if (!all.length) return null;
  const byDir = new Map();
  for (const f of all) {
    const at = f.lastIndexOf('/');
    const key = at < 0 ? '.' : f.slice(0, at);
    if (!byDir.has(key)) byDir.set(key, []);
    byDir.get(key).push(f.slice(at + 1));
  }
  const lines = [];
  for (const [folder, files] of [...byDir.entries()].sort()) {
    const shown = files.length > 14 ? files.slice(0, 14).concat(`… +${files.length - 14} more`) : files;
    lines.push(`${folder}/  ${shown.join('  ')}`);
  }
  const out = lines.join('\n');
  return out.length > maxChars ? out.slice(0, maxChars) + '\n… (tree truncated)' : out;
}

module.exports = { trackedFiles, listFiles, readFile, searchCode, fileMap, MAX_READ_BYTES };
