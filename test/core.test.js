'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const { phaseOf, countBoxes } = require('../lib/issues');
const { refName, posInt, text } = require('../lib/exec');
const { Repos, describe } = require('../lib/repos');
const llm = require('../lib/llm');
const gitOps = require('../lib/git');
const {
  dateOnly, milestonePhases, assignIssuePhases, prioritizeIssues,
  completeRanking, normalizeGeneratedGaps, mergeRankedGaps,
  hydratePlan, programmaticPlan,
} = require('../lib/plans');

test('issue helpers normalize phases and task-list progress', () => {
  assert.equal(phaseOf({ title: 'Phase 3 — Polish' }), 3);
  assert.equal(phaseOf({ title: 'Backlog' }), null);
  assert.deepEqual(countBoxes('- [x] done\n  * [ ] later\n+ [X] also done'), [2, 3]);
});

test('plans match ordinary milestone names without a Phase N prefix', () => {
  const milestones = [
    { number: 1, title: 'Development Environment Setup', state: 'open', dueOn: null },
    { number: 2, title: 'User Documentation', state: 'open', dueOn: null },
    { number: 3, title: 'Testing and CI/CD', state: 'open', dueOn: null },
  ];
  const phases = milestonePhases(milestones);
  assert.deepEqual(phases.map(p => [p.n, p.title, p.e]), [
    [0, 'Development Environment Setup', null],
    [1, 'User Documentation', null],
    [2, 'Testing and CI/CD', null],
  ]);

  const issues = assignIssuePhases([
    { n: 1, st: 'OPEN', ms: 'Development Environment Setup' },
    { n: 2, st: 'OPEN', ms: 'Testing and CI/CD' },
    { n: 3, st: 'OPEN', ms: 'Not a live milestone' },
  ], phases);
  assert.deepEqual(issues.map(i => i.p), [0, 2, null]);
});

test('programmatic plans use live dates and deterministically fill model omissions', () => {
  const milestones = [
    { number: 8, title: 'Later backlog', state: 'open', dueOn: null },
    { number: 4, title: 'Release checks', state: 'open', dueOn: '2026-09-15', description: 'Ship safely. Extra detail.' },
  ];
  const issues = [
    { n: 10, t: 'Finish active work', st: 'OPEN', ms: 'Later backlog', bx: [1, 3], bl: [] },
    { n: 11, t: 'Verify release', st: 'OPEN', ms: 'Release checks', bx: [0, 2], bl: [] },
    { n: 12, t: 'Closed reference', st: 'CLOSED', ms: 'Release checks', bx: [2, 2], bl: [] },
  ];
  const phases = milestonePhases(milestones);
  assert.deepEqual(phases.map(p => p.title), ['Release checks', 'Later backlog']);
  assert.equal(phases[0].gate, 'Ship safely.');
  assert.equal(phases[0].e, '2026-09-15');
  assert.equal(phases[1].e, null);

  const ordered = prioritizeIssues(assignIssuePhases(issues, phases), milestones, phases);
  assert.deepEqual(ordered.map(i => i.n), [10, 11]);
  const completed = completeRanking([
    { ns: [999], tag: 'invalid', why: 'not live' },
    { ns: [11], tag: 'editorial', why: 'A reviewed choice.' },
  ], ordered, milestones, phases, 2, assignIssuePhases(issues, phases));
  assert.deepEqual(completed.map(r => r.ns), [[11], [10]]);

  const plan = programmaticPlan('owner/repo', milestones, issues, 10);
  assert.equal(plan.hoursPerWeek, null);
  assert.equal(plan.beta, '2026-09-15');
  assert.deepEqual(plan.ranked.map(r => r.ns[0]), [10, 11]);
});

test('generated plans hydrate stale facts and retain completed recommendations', () => {
  const milestones = [
    { number: 1, title: 'Documentation', state: 'open', dueOn: null },
  ];
  const issues = [
    { n: 2, t: 'Write guide', st: 'CLOSED', ms: 'Documentation', bx: [1, 1], bl: [] },
  ];
  const plan = hydratePlan({
    generated: true,
    requestedCount: 1,
    hoursPerWeek: 40,
    phases: [{ n: 9, title: 'Phase 9 — stale', s: '2020-01-01', e: '2020-01-02' }],
    ranked: [{ ns: [2], tag: 'reviewed', why: 'Keep history visible.' }],
  }, milestones, issues);
  assert.equal(plan.phases[0].title, 'Documentation');
  assert.equal(plan.phases[0].e, null);
  assert.equal(plan.ranked[0].ns[0], 2);
  assert.equal(plan.hoursPerWeek, null);
  assert.equal(dateOnly('2026-02-31'), null);
});

test('generated missing-work insights are validated and placed programmatically', () => {
  const milestones = [
    { number: 1, title: 'Release Readiness', state: 'open', dueOn: '2026-10-02' },
  ];
  const phases = milestonePhases(milestones);
  const gaps = normalizeGeneratedGaps([
    {
      title: '[Release Readiness] Document rollback procedure',
      body: '- [ ] Record rollback steps\n- [ ] Test them',
      milestone: 'Release Readiness', labels: ['invented', 'documentation'],
      tag: 'release risk', rationale: 'No tracked issue owns the rollback procedure.',
      impact: 'A failed release would have no rehearsed recovery path.', risk: true, priority: 2,
    },
    {
      title: 'Configure CI pipeline for automated tests', body: '- [ ] Configure CI',
      milestone: 'Release Readiness', labels: [], tag: 'duplicate',
      rationale: 'Should be rejected as existing work.', impact: 'None', risk: false, priority: 1,
    },
  ], {
    milestones, phases,
    issues: [{ n: 5, t: 'Configure CI/CD pipeline for automated testing' }],
    labels: [{ name: 'documentation' }],
    limit: 5,
  });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].t, 'Document rollback procedure');
  assert.equal(gaps[0].p, 0);
  assert.equal(gaps[0].milestone, 'Release Readiness');
  assert.equal(gaps[0].when, 'Before 2026-10-02');
  assert.equal(gaps[0].lbl, 'documentation');

  const merged = mergeRankedGaps([
    { ns: [1], tag: 'first', why: 'First issue.' },
    { ns: [2], tag: 'second', why: 'Second issue.' },
  ], gaps);
  assert.deepEqual(merged.map(item => item.gap || item.ns[0]), [1, 'Document rollback procedure', 2]);

  const refreshed = hydratePlan({
    schemaVersion: 2, generated: true, requestedCount: 3, ranked: merged, gaps,
  }, [
    { number: 2, title: 'Preflight', state: 'open', dueOn: '2026-09-01' },
    { number: 1, title: 'Release Readiness', state: 'open', dueOn: '2026-11-03' },
  ], [
    { n: 1, t: 'First', st: 'OPEN', ms: 'Preflight', bx: [0, 0], bl: [] },
    { n: 2, t: 'Second', st: 'OPEN', ms: 'Release Readiness', bx: [0, 0], bl: [] },
  ]);
  assert.equal(refreshed.gaps[0].p, 1);
  assert.equal(refreshed.gaps[0].when, 'Before 2026-11-03');
  assert.equal(refreshed.ranked.find(item => item.gap).p, 1);
});

test('assistant plan generation returns ranking and missing-work insights', async (t) => {
  let requestPayload = null;
  const mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requestPayload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const planResult = {
        ranked: [
          { numbers: [1, 999], tag: 'first', why: 'First valid issue.' },
          { numbers: [1, 2], tag: 'second', why: 'Duplicate one is removed.' },
        ],
        gaps: [{
          title: 'Document recovery procedure', body: '- [ ] Write it',
          milestone: 'Release', labels: ['documentation'], tag: 'release risk',
          rationale: 'The milestone promises recovery but no issue owns it.',
          impact: 'Operators could not recover a failed release.', risk: true, priority: 2,
        }],
      };
      const commitResult = {
        subject: 'Summarize selected changes into a clear and intentionally overlong commit subject line.',
        body: 'Explain the important implementation details.',
      };
      const content = JSON.stringify(requestPayload.format.properties.subject ? commitResult : planResult);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: { content } }));
    });
  });
  try {
    await new Promise((resolve, reject) => {
      mock.once('error', reject);
      mock.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (error && error.code === 'EPERM') {
      t.skip('this environment does not permit loopback listeners');
      return;
    }
    throw error;
  }
  t.after(() => new Promise(resolve => mock.close(resolve)));

  const result = await llm.planInsights({
    endpoint: `http://127.0.0.1:${mock.address().port}`, model: 'test-model', timeoutMs: 5000,
  }, {
    issues: [
      { n: 1, t: 'First', st: 'OPEN', ms: 'Release', bx: [0, 0], bl: [], body: '' },
      { n: 2, t: 'Second', st: 'OPEN', ms: 'Release', bx: [0, 0], bl: [], body: '' },
    ],
    milestones: [{ title: 'Release', dueOn: null, description: 'Ready to release.' }],
    labels: [{ name: 'documentation' }], count: 5, gapCount: 3,
  });
  assert.deepEqual(result.ranked.map(item => item.ns), [[1], [2]]);
  assert.equal(result.gaps[0].title, 'Document recovery procedure');
  assert.ok(requestPayload.format.properties.gaps);

  const summary = await llm.summarizeCommit({
    endpoint: `http://127.0.0.1:${mock.address().port}`, model: 'test-model', timeoutMs: 5000,
  }, {
    files: ['lib/example.js'], branch: 'feature/summary', truncated: false,
    patch: 'diff --git a/lib/example.js b/lib/example.js\n+const enabled = true;',
  });
  assert.ok(summary.subject.length <= 72);
  assert.doesNotMatch(summary.subject, /\.$/);
  assert.equal(summary.body, 'Explain the important implementation details.');
  assert.ok(requestPayload.format.properties.subject);
});

test('shared validators reject option smuggling and malformed values', () => {
  assert.throws(() => refName('--force'), /cannot start/);
  assert.throws(() => refName('feature bad'), /does not allow/);
  assert.equal(refName('feature/safe-name'), 'feature/safe-name');
  assert.equal(posInt('42', 'number'), 42);
  assert.throws(() => posInt(0, 'number'), /positive integer/);
  assert.equal(text('  hello  ', 'value', 10), 'hello');
});

test('repository descriptions expose a safe slug, never a credentialed remote', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-git-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  try { execFileSync('git', ['init', '--quiet', dir]); }
  catch (error) {
    if (error && error.code === 'EPERM') {
      t.skip('this environment does not permit child processes');
      return;
    }
    throw error;
  }
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://user@github.com/owner/project.git']);
  const normal = await describe(dir);
  assert.equal(normal.github, 'owner/project');
  assert.equal(Object.hasOwn(normal, 'remote'), false);

  execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', 'https://github.com/owner/project/../../escape']);
  assert.equal((await describe(dir)).github, null);
});

test('commit summary diffs include only validated selected files', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-git-summary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  try { execFileSync('git', ['init', '--quiet', dir]); }
  catch (error) {
    if (error && error.code === 'EPERM') {
      t.skip('this environment does not permit child processes');
      return;
    }
    throw error;
  }
  fs.writeFileSync(path.join(dir, 'selected.txt'), 'before\n');
  fs.writeFileSync(path.join(dir, 'excluded.txt'), 'original\n');
  execFileSync('git', ['-C', dir, 'add', '--', 'selected.txt', 'excluded.txt']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    'commit', '--quiet', '-m', 'initial']);
  fs.writeFileSync(path.join(dir, 'selected.txt'), 'after\n');
  fs.writeFileSync(path.join(dir, 'excluded.txt'), 'not selected\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new selected file\n');

  const summary = await gitOps.summaryDiff(dir, ['selected.txt', 'new.txt'], 6000);
  assert.deepEqual(summary.files, ['selected.txt', 'new.txt']);
  assert.match(summary.patch, /FILE: selected\.txt \(modified\)/);
  assert.match(summary.patch, /FILE: new\.txt \(untracked\)/);
  assert.doesNotMatch(summary.patch, /excluded\.txt/);
  await assert.rejects(() => gitOps.summaryDiff(dir, ['excluded-from-status.txt']), /not one of the current changes/);
});

test('removing a tracked repository preserves its local folder and prevents rediscovery', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-git-untrack-'));
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'still here');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const repos = Object.create(Repos.prototype);
  Object.assign(repos, {
    manifest: [dir], recents: [dir], removedRepos: [],
    selected: { path: dir }, list: [{ path: dir }],
  });
  let persisted = 0;
  repos._persist = () => { persisted++; };

  assert.throws(() => repos.remove(''), /Choose a repository/);
  repos.remove(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'still here');
  assert.deepEqual(repos.manifest, []);
  assert.deepEqual(repos.recents, []);
  assert.deepEqual(repos.removedRepos, [dir]);
  assert.equal(repos.selected, null);
  assert.equal(persisted, 1);

  repos._maybeSeed(dir);
  assert.deepEqual(repos.manifest, []);
  const added = repos.addRepos(dir);
  assert.equal(added.added, 1);
  assert.deepEqual(repos.manifest, [dir]);
  assert.deepEqual(repos.removedRepos, []);
});

function request(port, pathname, headers = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: options.method || 'GET',
      headers: Object.assign({ Host: '127.0.0.1:' + port }, headers,
        payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(err => err ? reject(err) : resolve(port));
    });
  });
}

test('server protects its boot token and API on loopback', { timeout: 15000 }, async (t) => {
  const port = await freePort().catch((error) => {
    if (error && error.code === 'EPERM') {
      t.skip('this environment does not permit loopback listeners');
      return null;
    }
    throw error;
  });
  if (port == null) return;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-git-test-'));
  const child = spawn(process.execPath, ['server.js', '--dry-run', '--port', String(port), '--repo', ROOT], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { HOME: tempHome }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (!child.killed) child.kill('SIGTERM');
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('server did not become ready:\n' + output)), 10000);
    const onData = chunk => {
      output += chunk.toString();
      if (output.includes('ready →')) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', code => reject(new Error('server exited early with ' + code + ':\n' + output)));
  });

  const page = await request(port, '/');
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>vibe-git<\/title>/);
  assert.doesNotMatch(page.headers['content-security-policy'], /script-src[^;]*unsafe-inline/);
  const token = /window\.__VIBE_GIT__=\{"token":"([a-f0-9]+)"/.exec(page.body)[1];
  const nonce = /<script nonce="([^"]+)">/.exec(page.body)[1];
  assert.match(page.headers['content-security-policy'], new RegExp("nonce-" + nonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  assert.equal((await request(port, '/api/dry-log')).status, 401);
  assert.equal((await request(port, '/', { Host: 'attacker.example' })).status, 403);
  assert.equal((await request(port, '/api/dry-log', {
    'X-Vibe-Git-Token': token,
    Origin: 'http://attacker.example',
  })).status, 403);
  assert.equal((await request(port, '/api/dry-log', { 'X-Vibe-Git-Token': token })).status, 200);

  const removed = await request(port, '/api/repos/remove', { 'X-Vibe-Git-Token': token }, {
    method: 'POST', body: { path: ROOT },
  });
  assert.equal(removed.status, 200);
  const removedState = JSON.parse(removed.body);
  assert.equal(removedState.selected, null);
  assert.equal(removedState.repos.some(repo => repo.path === ROOT), false);
  assert.match(removedState.message, /folder and files were not deleted/i);
  assert.equal(fs.existsSync(path.join(ROOT, 'README.md')), true);
  const saved = JSON.parse(fs.readFileSync(path.join(tempHome, '.config', 'vibe-git', 'config.json'), 'utf8'));
  assert.equal(saved.manifest.includes(ROOT), false);
  assert.equal(saved.removedRepos.includes(ROOT), true);
});
