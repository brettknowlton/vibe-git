'use strict';
/*
 * Repository discovery and selection — the "Current repository" dropdown.
 *
 * Keeps an explicit manifest of repositories the user added. A directory containing
 * repositories is walked once when added, then only the discovered repositories are
 * remembered. Selection is validated as a real Git worktree before it reaches git.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, git, gh, bad } = require('./exec');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'vibe-git');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const LEGACY_CONFIG_DIR = path.join(os.homedir(), '.config', 'issue-board');
const LEGACY_CONFIG_FILE = path.join(LEGACY_CONFIG_DIR, 'config.json');

/*
 * No blind filesystem scanning. The app tracks an explicit MANIFEST of repositories the
 * user added — by picking a folder, adding a folder of repos, or cloning. Walking the
 * home directory guessing at "Projects" and "src" was both slow and presumptuous.
 *
 * A folder added via addRoot is expanded ONCE into the repos it contains; the repos are
 * remembered, the folder is not re-walked on every launch.
 */

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch {
    // One-way compatibility for installs created before the project was renamed. New
    // writes always go to ~/.config/vibe-git, leaving the old data untouched.
    try { return JSON.parse(fs.readFileSync(LEGACY_CONFIG_FILE, 'utf8')); }
    catch { return {}; }
  }
}
function writeConfig(cfg) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  } catch (e) { console.error('  ! could not save config: ' + e.message); }
}

/* Walk roots looking for .git, not descending into a repo once found. */
function scan(roots, maxDepth = 4) {
  const found = [];
  const seen = new Set();
  const walk = (dir, depth) => {
    if (depth > maxDepth || found.length > 400) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    if (entries.some(e => e.name === '.git')) {
      const real = fs.realpathSync(dir);
      if (!seen.has(real)) { seen.add(real); found.push(real); }
      return;                                     // don't descend into a repo
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'target') continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  for (const r of roots) {
    try { if (fs.statSync(r).isDirectory()) walk(r, 0); } catch { /* root absent */ }
  }
  return found;
}

async function describe(dir) {
  const out = { path: dir, name: path.basename(dir), branch: null, github: null, ahead: 0, behind: 0 };
  try {
    const r = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    out.branch = r.stdout.trim();
  } catch { /* empty repo */ }
  try {
    const r = await git(dir, ['remote', 'get-url', 'origin']);
    // Keep the raw remote local to this function: HTTPS remotes can contain embedded
    // credentials, while the rest of the app only needs the sanitized owner/repo slug.
    const remote = r.stdout.trim();
    const m = /github\.com[:/]+([A-Za-z0-9][A-Za-z0-9.-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*?)(?:\.git)?$/.exec(remote);
    if (m) out.github = m[1] + '/' + m[2];
  } catch { /* no origin */ }
  return out;
}

class Repos {
  constructor(seed = []) {
    const cfg = readConfig();
    this.manifest = cfg.manifest || [];
    this.recents = cfg.recents || [];
    this.removedRepos = cfg.removedRepos || [];
    this.selected = null;
    this.list = [];
    // A --repo/--scan argument or the cwd is offered once, not scanned repeatedly.
    for (const d of seed) this._maybeSeed(d);
  }

  _maybeSeed(dir) {
    try {
      const p = path.resolve(dir);
      if (this.removedRepos.includes(p)) return;
      const g = path.join(p, '.git');
      const st = fs.statSync(g);
      if ((st.isDirectory() || st.isFile()) && !this.manifest.includes(p)) this.manifest.push(p);
    } catch { /* not a repo; ignore silently */ }
  }

  _persist() {
    const cfg = readConfig();
    writeConfig(Object.assign(cfg, {
      manifest: this.manifest, recents: this.recents,
      removedRepos: this.removedRepos,
      lastRepo: this.selected
        ? this.selected.path
        : (this.manifest.includes(cfg.lastRepo) ? cfg.lastRepo : null),
    }));
  }

  /* Only what's in the manifest. Entries that no longer exist are pruned. */
  async refresh() {
    const alive = this.manifest.filter(d => {
      try { const g = fs.statSync(path.join(d, '.git')); return g.isDirectory() || g.isFile(); }
      catch { return false; }
    });
    if (alive.length !== this.manifest.length) { this.manifest = alive; this._persist(); }
    this.list = await Promise.all(alive.map(describe));
    this.list.sort((a, b) => {
      const ar = this.recents.indexOf(a.path), br = this.recents.indexOf(b.path);
      if (ar !== br) return (ar < 0 ? 1e9 : ar) - (br < 0 ? 1e9 : br);
      return a.name.localeCompare(b.name);
    });
    return this.list;
  }

  /* Add one repo, or a folder containing several (scanned once, then remembered). */
  addRepos(dir) {
    const p = path.resolve(String(dir || ''));
    try { if (!fs.statSync(p).isDirectory()) bad('That is not a directory'); }
    catch { bad('That directory does not exist: ' + p); }

    let found = [];
    try {
      const g = fs.statSync(path.join(p, '.git'));
      if (g.isDirectory() || g.isFile()) found = [p];
    } catch { found = scan([p], 3); }        // a folder OF repos, walked exactly once

    if (!found.length) bad('No git repositories found in ' + p);
    let added = 0;
    for (const f of found) {
      this.removedRepos = this.removedRepos.filter(item => item !== f);
      if (!this.manifest.includes(f)) { this.manifest.push(f); added++; }
    }
    this._persist();
    return { added, found: found.length, paths: found };
  }

  remove(dir) {
    const raw = String(dir || '').trim();
    if (!raw) bad('Choose a repository to stop tracking');
    const p = path.resolve(raw);
    const before = this.manifest.length;
    this.manifest = this.manifest.filter(x => x !== p);
    this.recents = this.recents.filter(x => x !== p);
    if (this.manifest.length === before) bad('That repository is not in the list');
    if (!this.removedRepos.includes(p)) this.removedRepos.push(p);
    if (this.selected && this.selected.path === p) this.selected = null;
    this._persist();
    return this.manifest;
  }

  /* Only a path we actually discovered can be selected. */
  async select(dir) {
    const want = path.resolve(String(dir || ''));
    if (!this.list.length) await this.refresh();
    let hit = this.list.find(r => r.path === want);
    if (!hit) {
      // Allow a fresh path the user points at, but prove it's a real repo first.
      try {
        const top = (await git(want, ['rev-parse', '--show-toplevel'])).stdout.trim();
        if (top) { hit = await describe(top); this.list.unshift(hit); }
      } catch { /* fall through */ }
    }
    if (!hit) bad('That directory is not a git repository this tool can see');
    this.selected = hit;
    this.removedRepos = this.removedRepos.filter(p => p !== hit.path);
    if (!this.manifest.includes(hit.path)) this.manifest.push(hit.path);
    this.recents = [hit.path, ...this.recents.filter(p => p !== hit.path)].slice(0, 12);
    this._persist();
    return hit;
  }

  /*
   * Opening order, most specific first. The "has a github remote" step matters: a repo
   * with no remote can't show issues at all, so landing on one at startup looks broken
   * even though nothing is.
   */
  async autoSelect(preferred) {
    await this.refresh();
    const cfg = readConfig();
    let cwdRepo = null;
    try { cwdRepo = (await git(process.cwd(), ['rev-parse', '--show-toplevel'])).stdout.trim(); }
    catch { /* not inside a repo */ }
    const withRemote = this.list.find(r => r.github);
    const candidates = [
      preferred,
      cfg.lastRepo,
      cwdRepo,
      ...this.recents,
      withRemote && withRemote.path,
      this.list[0] && this.list[0].path,
    ];
    for (const c of candidates) {
      if (!c) continue;
      // An explicit --repo overrides a previous removal. Ambient cwd discovery does
      // not, otherwise a repository would reappear whenever the server starts inside it.
      if (c !== preferred && this.removedRepos.includes(path.resolve(c))) continue;
      try { return await this.select(c); } catch { /* try the next one */ }
    }
    return null;
  }

  /*
   * Clone from a URL or "owner/repo" into one of the scan roots, then select it.
   * The spec is parsed into owner/name and rebuilt from scratch rather than passed
   * through, so nothing that looks like a flag or a path can reach git.
   */
  async clone(spec, intoDir) {
    const raw = String(spec || '').trim();
    if (!raw) bad('Paste a repository URL or owner/name');

    let owner = null, name = null, host = 'github.com';
    let m = /^(?:https?:\/\/|git@)([^/:]+)[/:]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(raw);
    if (m) { host = m[1]; owner = m[2]; name = m[3]; }
    else {
      m = /^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*?)(?:\.git)?$/.exec(raw);
      if (m) { owner = m[1]; name = m[2]; }
    }
    if (!owner || !name) bad('Could not read that as a repository — try https://github.com/owner/name or owner/name');
    if (!/^[A-Za-z0-9][\w.-]*$/.test(owner) || !/^[A-Za-z0-9][\w.-]*$/.test(name)) {
      bad('That owner or repository name has characters git would not accept');
    }

    const parent = path.resolve(intoDir ? String(intoDir)
      : (this.manifest.length ? path.dirname(this.manifest[0]) : os.homedir()));
    try { if (!fs.statSync(parent).isDirectory()) bad('Destination is not a directory'); }
    catch { bad('Destination directory does not exist: ' + parent); }

    const dest = path.join(parent, name);
    try {
      fs.statSync(dest);
      // Already there — adopt it instead of failing, if it really is that repo.
      const existing = await describe(dest);
      if (existing.github && existing.github.toLowerCase() === (owner + '/' + name).toLowerCase()) {
        this.list.unshift(existing);
        return { cloned: false, adopted: true, repo: await this.select(dest) };
      }
      bad(dest + ' already exists and is not ' + owner + '/' + name);
    } catch (e) {
      if (e && e.status === 400) throw e;          // our own bad(), not a missing path
    }

    const url = 'https://' + host + '/' + owner + '/' + name + '.git';
    await run('git', ['clone', '--', url, dest], { cwd: parent, timeout: 600000 });
    const info = await describe(dest);
    this.list.unshift(info);
    return { cloned: true, adopted: false, repo: await this.select(dest) };
  }


}

module.exports = {
  Repos, describe, CONFIG_DIR, CONFIG_FILE, LEGACY_CONFIG_DIR, readConfig, writeConfig,
};
