'use strict';
/*
 * The single choke point for every external process this app runs.
 *
 * Two rules, and everything else in the codebase depends on them holding:
 *   1. execFile with an ARGUMENT ARRAY and shell:false. No string is ever handed to a
 *      shell, so a branch name, issue title or commit message containing $(...), backticks,
 *      quotes or newlines is inert data. There is deliberately no "run this command" API.
 *   2. Anything that MUTATES goes through mutate(), which is the one place --dry-run
 *      intercepts. Reads always execute for real.
 */

const { execFile } = require('child_process');

let DRY = false;
const DRY_LOG = [];

const setDryRun = (v) => { DRY = !!v; };
const isDryRun = () => DRY;
const dryLog = () => DRY_LOG.slice(-200);

class ExecError extends Error {
  constructor(message, { cmd, args, exitCode } = {}) {
    super(message);
    this.name = 'ExecError';
    this.cmd = cmd; this.args = args; this.exitCode = exitCode;
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      cwd: opts.cwd || process.cwd(),
      timeout: opts.timeout || 60000,
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
      env: Object.assign({}, process.env, {
        // Keep git from ever trying to open an editor or a credential prompt on a
        // machine where nobody is watching the terminal.
        GIT_TERMINAL_PROMPT: '0',
        GIT_EDITOR: 'true',
      }, opts.env || {}),
    }, (err, stdout, stderr) => {
      const out = String(stdout || '');
      const errOut = String(stderr || '');
      if (err) {
        let msg = errOut.trim() || out.trim() || String(err.message || '').trim();
        if (err.code === 'ENOENT') msg = `${cmd} is not installed or not on PATH`;
        else if (err.killed) msg = `${cmd} timed out after ${(opts.timeout || 60000) / 1000}s`;
        return reject(new ExecError(msg || `${cmd} failed`, { cmd, args, exitCode: err.code }));
      }
      resolve({ stdout: out, stderr: errOut });
    });
  });
}

/* Read-only invocations. */
const git = (dir, args, opts) => run('git', args, Object.assign({ cwd: dir }, opts));
const gh = (dir, args, opts) => run('gh', args, Object.assign({ cwd: dir }, opts));

/*
 * Mutating invocations. In dry-run these never execute — they record the exact argv and
 * hand back whatever the caller says a success looks like, so the UI can be driven
 * end-to-end without touching the repo or GitHub.
 */
function mutate(cmd, dir, args, { fakeStdout = '', label = '' } = {}) {
  if (DRY) {
    const entry = { at: new Date().toISOString(), cmd, args, dir, label };
    DRY_LOG.push(entry);
    console.log('  [dry-run] ' + cmd + ' ' + JSON.stringify(args));
    return Promise.resolve({ stdout: fakeStdout, stderr: '', dryRun: true });
  }
  return run(cmd, args, { cwd: dir });
}
const gitWrite = (dir, args, opts) => mutate('git', dir, args, opts);
const ghWrite = (dir, args, opts) => mutate('gh', dir, args, opts);

/* ── validators shared by the git and github layers ──────────────── */

class BadInput extends Error {
  constructor(msg) { super(msg); this.name = 'BadInput'; this.status = 400; }
}
const bad = (m) => { throw new BadInput(m); };

// A leading "-" would be read as a FLAG by git/gh rather than as data, which is the one
// injection route that survives execFile. Every free-text identifier is checked for it.
function noLeadingDash(v, name) {
  if (String(v).startsWith('-')) bad(`${name} cannot start with "-"`);
  return v;
}

function refName(v, name = 'branch') {
  const s = String(v == null ? '' : v).trim();
  if (!s) bad(`${name} cannot be empty`);
  if (s.length > 255) bad(`${name} is too long`);
  noLeadingDash(s, name);
  // git check-ref-format's rules, tightened: no spaces, no .., no control chars, no ~^:?*[\
  if (/[\s~^:?*\[\\]/.test(s)) bad(`${name} contains characters git does not allow`);
  if (s.includes('..') || s.endsWith('/') || s.endsWith('.lock') || s.startsWith('/')) {
    bad(`"${s}" is not a valid ${name}`);
  }
  return s;
}

function posInt(v, name) {
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) v = Number(v.trim());
  if (!Number.isInteger(v) || v <= 0 || v > 9999999) bad(`${name} must be a positive integer`);
  return v;
}

function text(v, name, max, { required = true } = {}) {
  if (v == null || v === '') {
    if (required) bad(`${name} cannot be empty`);
    return null;
  }
  if (typeof v !== 'string') bad(`${name} must be text`);
  const s = v.trim();
  if (!s && required) bad(`${name} cannot be empty`);
  if (s.length > max) bad(`${name} is too long (max ${max} characters)`);
  return s || null;
}

module.exports = {
  run, git, gh, gitWrite, ghWrite, mutate,
  setDryRun, isDryRun, dryLog,
  ExecError, BadInput, bad,
  refName, posInt, text, noLeadingDash,
};
