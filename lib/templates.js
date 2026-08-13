'use strict';
/*
 * Issue and pull request templates, read from the repository itself.
 *
 * Every repository that takes contributions defines these, and until now vibe-git ignored
 * them completely: you got an empty box, and filed an issue that skipped the questions the
 * maintainers wrote the template to ask. That is worse than filing on github.com, which is
 * the one thing this app must never be.
 *
 * Read-only, from the working tree, at fixed paths — GitHub's own search order. No traversal
 * is possible because no part of any path comes from a caller: the directory list is a
 * constant and only the leaf names inside a template directory are discovered, filtered to
 * plain files with an expected extension.
 */

const fs = require('fs');
const path = require('path');

/* GitHub looks in these three places, in this order, for both kinds. */
const HOMES = ['.github', '.', 'docs'];
const MD = /\.md$/i;
const YML = /\.ya?ml$/i;
/* Not a template — it configures the chooser itself (blank issues, external contact links). */
const NOT_A_TEMPLATE = /^config\.ya?ml$/i;

const CAP = 64 * 1024;          // a template is a form, not a document
const MAX = 30;                 // a chooser with more entries than this is not a chooser

/*
 * A template must resolve to a file INSIDE the repository.
 *
 * The paths here are constants, so there is no traversal to worry about from a caller — but
 * the repository is not trusted content, and this app will clone one from a URL on request.
 * A symlink at `.github/PULL_REQUEST_TEMPLATE.md` pointing at `~/.ssh/id_rsa` was read and
 * prefilled into the pull request description, where a two-stage confirm was the only thing
 * between it and a public GitHub comment.
 *
 * Containment is the whole boundary, and it is checked in ONE place. Refusing symlinks
 * outright looks like a stronger guard and is not: it buys nothing over resolving the path,
 * because a link that lands inside the repository only reaches content the repository
 * already has — and it breaks the ordinary layout where `docs/PULL_REQUEST_TEMPLATE.md`
 * points at the copy in `.github/`. realpath resolves the entire chain, so a symlinked
 * parent directory is caught by the same test as a symlinked file.
 */
function insideRepo(root, file) {
  try {
    const base = fs.realpathSync(root);
    const real = fs.realpathSync(file);
    return real === base || real.startsWith(base + path.sep);
  } catch { return false; }        // dangling link, or a path that cannot be resolved
}

function readIfFile(root, file) {
  try {
    if (!insideRepo(root, file)) return null;
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > CAP) return null;
    return fs.readFileSync(file, 'utf8').replace(/\r/g, '');
  } catch { return null; }
}

/* Symlinks are listed rather than filtered here, because readIfFile() is where containment
   is decided. Two places deciding it would eventually disagree. */
function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => (e.isFile() || e.isSymbolicLink()) && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch { return []; }
}

/* ── the smallest YAML that reads a GitHub issue form ─────────────── */
/*
 * Deliberately a subset, not a YAML implementation.
 *
 * Issue forms use a narrow and well-documented shape: nested mappings, sequences of
 * mappings, quoted and bare scalars, flow sequences for labels, and block scalars for
 * prose. That is what this reads. Anything outside it comes back as a string rather than
 * as a guess, and the caller falls back to showing the file — a template rendered wrong is
 * worse than a template shown raw, because only one of the two is obvious.
 */
function indentOf(line) { return line.length - line.replace(/^ +/, '').length; }

function scalar(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return '';
  if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) ||
      (v.startsWith("'") && v.endsWith("'") && v.length > 1)) {
    return v.slice(1, -1).replace(/\\n/g, '\n').replace(/''/g, "'");
  }
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map(s => scalar(s)).filter(s => s !== '');
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

/* Lines that carry no structure. A comment inside a block scalar is CONTENT, so comment
   stripping happens here per-line and never inside the block-scalar reader below. */
const skippable = (line) => !line.trim() || /^\s*#/.test(line);

function parseBlock(lines, from, indent) {
  // A sequence if the first structural line at this indent is a "- " item.
  for (let i = from; i < lines.length; i++) {
    if (skippable(lines[i])) continue;
    if (indentOf(lines[i]) < indent) break;
    if (indentOf(lines[i]) !== indent) continue;
    return /^\s*-\s/.test(lines[i]) ? parseSeq(lines, from, indent) : parseMap(lines, from, indent);
  }
  return { value: {}, next: lines.length };
}

function blockScalar(lines, from, parentIndent, fold) {
  const out = [];
  let i = from;
  let base = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { out.push(''); continue; }
    const ind = indentOf(line);
    if (ind <= parentIndent) break;
    if (base == null) base = ind;
    out.push(line.slice(Math.min(base, ind)));
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return { value: fold ? out.join(' ').replace(/\s+/g, ' ').trim() : out.join('\n'), next: i };
}

function parseMap(lines, from, indent) {
  const out = {};
  let i = from;
  while (i < lines.length) {
    const line = lines[i];
    if (skippable(line)) { i++; continue; }
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) { i++; continue; }              // stray deeper line; not ours to read
    const hit = /^\s*([A-Za-z0-9_.-]+)\s*:\s?(.*)$/.exec(line);
    if (!hit) break;
    const [, key, rest] = hit;
    const tail = rest.replace(/\s+#.*$/, '').trim();
    if (tail === '|' || tail === '|-' || tail === '>' || tail === '>-') {
      const block = blockScalar(lines, i + 1, ind, tail.startsWith('>'));
      out[key] = block.value; i = block.next; continue;
    }
    if (tail !== '') { out[key] = scalar(tail); i++; continue; }
    const child = parseBlock(lines, i + 1, nextIndent(lines, i + 1, ind));
    out[key] = child.value; i = child.next;
  }
  return { value: out, next: i };
}

function parseSeq(lines, from, indent) {
  const out = [];
  let i = from;
  while (i < lines.length) {
    const line = lines[i];
    if (skippable(line)) { i++; continue; }
    const ind = indentOf(line);
    if (ind < indent || !/^\s*-\s*/.test(line)) break;
    if (ind > indent) { i++; continue; }
    const inline = line.replace(/^\s*-\s*/, '');
    if (/^[A-Za-z0-9_.-]+\s*:/.test(inline)) {
      // "- key: value" opens a mapping whose remaining keys are indented to the key column.
      const keyCol = line.indexOf(inline);
      const rebuilt = [' '.repeat(keyCol) + inline, ...lines.slice(i + 1)];
      const map = parseMap(rebuilt, 0, keyCol);
      out.push(map.value);
      i = i + map.next;                                // map.next counts the rebuilt line too
    } else {
      out.push(scalar(inline)); i++;
    }
  }
  return { value: out, next: i };
}

/* Where the children of a key that opened a block actually start. */
function nextIndent(lines, from, parentIndent) {
  for (let i = from; i < lines.length; i++) {
    if (skippable(lines[i])) continue;
    const ind = indentOf(lines[i]);
    return ind > parentIndent ? ind : parentIndent + 1;   // no children: an indent nothing matches
  }
  return parentIndent + 1;
}

function readYaml(src) {
  try {
    const lines = String(src).split('\n');
    return parseBlock(lines, 0, 0).value;
  } catch { return null; }
}

/* ── front matter on a markdown template ─────────────────────────── */

function splitFrontMatter(src) {
  const hit = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!hit) return { meta: {}, body: src };
  return { meta: readYaml(hit[1]) || {}, body: src.slice(hit[0].length).replace(/^\n+/, '') };
}

const asList = (v) => (Array.isArray(v) ? v : String(v == null ? '' : v).split(','))
  .map(s => String(s).trim()).filter(Boolean);

/* ── issue forms rendered as a body somebody can actually edit ───── */
/*
 * An issue form is a set of questions GitHub renders as widgets. There is no widget here
 * and inventing one would mean reimplementing a form engine, so the questions become a
 * markdown skeleton — heading per field, its description as context, a blank line to type
 * in. Required fields say so. That is the same thing GitHub falls back to when a form is
 * filed through the API, and it keeps the maintainer's questions in front of the writer,
 * which is the entire point of the template.
 */
function renderForm(doc) {
  const parts = [];
  for (const field of Array.isArray(doc.body) ? doc.body : []) {
    if (!field || typeof field !== 'object') continue;
    const at = (field.attributes && typeof field.attributes === 'object') ? field.attributes : {};
    const required = !!(field.validations && field.validations.required);
    if (field.type === 'markdown') {
      if (at.value) parts.push(String(at.value).trim());
      continue;
    }
    const label = String(at.label || field.id || '').trim();
    if (label) parts.push('### ' + label + (required ? ' *(required)*' : ''));
    if (at.description) parts.push('<!-- ' + String(at.description).trim().replace(/-->/g, '--') + ' -->');
    if (field.type === 'checkboxes') {
      for (const opt of Array.isArray(at.options) ? at.options : []) {
        const text = opt && typeof opt === 'object' ? opt.label : opt;
        if (text) parts.push('- [ ] ' + String(text).trim());
      }
    } else if (field.type === 'dropdown') {
      const opts = (Array.isArray(at.options) ? at.options : []).map(o => String(o).trim()).filter(Boolean);
      parts.push(opts.length ? '<!-- one of: ' + opts.join(' · ') + ' -->\n' : '');
    } else if (at.value) {
      parts.push(String(at.value).trim());
    } else {
      parts.push('');
    }
  }
  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function issueTemplate(name, src, source) {
  if (YML.test(name)) {
    const doc = readYaml(src);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      return { name, title: '', body: src, labels: [], assignees: [], source, raw: true };
    }
    return {
      name: String(doc.name || name).slice(0, 200),
      about: String(doc.description || '').slice(0, 400),
      title: String(doc.title || '').slice(0, 240),
      body: renderForm(doc) || src,
      labels: asList(doc.labels).slice(0, 20),
      assignees: asList(doc.assignees).slice(0, 10),
      source,
      form: true,
    };
  }
  const { meta, body } = splitFrontMatter(src);
  return {
    name: String(meta.name || name.replace(MD, '')).slice(0, 200),
    about: String(meta.about || '').slice(0, 400),
    title: String(meta.title || '').slice(0, 240),
    body,
    labels: asList(meta.labels).slice(0, 20),
    assignees: asList(meta.assignees).slice(0, 10),
    source,
  };
}

/*
 * Everything a repository offers, in GitHub's own precedence order.
 *
 * A directory of templates wins over a single file, because a repository that has both is
 * mid-migration and the directory is the newer half. Nothing here throws: a repository with
 * no templates returns empty lists and the New Issue form behaves exactly as it did before.
 */
function forRepo(dir) {
  const issue = [];
  const pr = [];
  const seen = new Set();

  for (const home of HOMES) {
    const base = path.join(dir, home);

    for (const name of listDir(path.join(base, 'ISSUE_TEMPLATE'))) {
      if (NOT_A_TEMPLATE.test(name) || !(MD.test(name) || YML.test(name))) continue;
      const src = readIfFile(dir, path.join(base, 'ISSUE_TEMPLATE', name));
      const where = path.join(home, 'ISSUE_TEMPLATE', name);
      if (src == null || seen.has(where)) continue;
      seen.add(where);
      if (issue.length < MAX) issue.push(issueTemplate(name, src, where));
    }

    for (const name of ['ISSUE_TEMPLATE.md', 'issue_template.md']) {
      const src = readIfFile(dir, path.join(base, name));
      if (src == null) continue;
      const where = path.join(home, name);
      if (seen.has(where)) continue;
      seen.add(where);
      if (issue.length < MAX) issue.push(issueTemplate(name, src, where));
    }

    for (const name of listDir(path.join(base, 'PULL_REQUEST_TEMPLATE'))) {
      if (!MD.test(name)) continue;
      const src = readIfFile(dir, path.join(base, 'PULL_REQUEST_TEMPLATE', name));
      if (src == null) continue;
      const where = path.join(home, 'PULL_REQUEST_TEMPLATE', name);
      if (seen.has(where)) continue;
      seen.add(where);
      if (pr.length < MAX) pr.push({ name: name.replace(MD, ''), body: splitFrontMatter(src).body, source: where });
    }

    for (const name of ['PULL_REQUEST_TEMPLATE.md', 'pull_request_template.md']) {
      const src = readIfFile(dir, path.join(base, name));
      if (src == null) continue;
      const where = path.join(home, name);
      if (seen.has(where)) continue;
      seen.add(where);
      if (pr.length < MAX) pr.push({ name: name.replace(MD, ''), body: splitFrontMatter(src).body, source: where });
    }
  }

  return { issue, pr };
}

module.exports = { forRepo, readYaml, splitFrontMatter, renderForm, issueTemplate };
