'use strict';
/*
 * Staged issue changes.
 *
 * The whole point of this module: editing an issue in the UI does NOT hit GitHub. It
 * appends a pending change here, exactly like staging a file. Nothing reaches the API
 * until you push, and then the changes go in order with a per-item result — so a
 * mistake is a "remove from the queue" rather than an "undo on GitHub".
 *
 * Queues persist per repo, so closing the browser doesn't lose staged work.
 */

const fs = require('fs');
const path = require('path');
const { ghWrite, bad, posInt, text, noLeadingDash } = require('./exec');
const { CONFIG_DIR, LEGACY_CONFIG_DIR } = require('./repos');

const QUEUE_FILE = path.join(CONFIG_DIR, 'queues.json');
const LEGACY_QUEUE_FILE = path.join(LEGACY_CONFIG_DIR, 'queues.json');

function loadAll() {
  try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); }
  catch {
    try { return JSON.parse(fs.readFileSync(LEGACY_QUEUE_FILE, 'utf8')); }
    catch { return {}; }
  }
}
function saveAll(all) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
  } catch (e) { console.error('  ! could not persist queue: ' + e.message); }
}

let seq = 0;
const newId = () => Date.now().toString(36) + '-' + (++seq).toString(36);

const CLOSE_REASONS = new Set(['completed', 'not planned']);

/*
 * Each kind knows how to validate itself, describe itself in one line for the UI, and
 * build the argv that applies it. Adding a new operation means adding one entry here.
 */
const KINDS = {
  close: {
    validate(p, ctx) {
      const n = posInt(p.number, 'issue number');
      const reason = p.reason ? text(p.reason, 'reason', 40) : 'completed';
      if (!CLOSE_REASONS.has(reason)) bad('reason must be "completed" or "not planned"');
      const comment = text(p.comment, 'comment', 8000, { required: false });
      return { number: n, reason, comment: comment || null };
    },
    describe: (p, ctx) => `Close #${p.number}${p.reason === 'not planned' ? ' (not planned)' : ''}` + titleOf(ctx, p.number),
    argv(p) {
      const a = ['issue', 'close', String(p.number), '--reason', p.reason];
      if (p.comment) a.push('--comment', p.comment);
      return a;
    },
  },

  reopen: {
    validate: (p) => ({ number: posInt(p.number, 'issue number') }),
    describe: (p, ctx) => `Reopen #${p.number}` + titleOf(ctx, p.number),
    argv: (p) => ['issue', 'reopen', String(p.number)],
  },

  comment: {
    validate: (p) => ({ number: posInt(p.number, 'issue number'), body: text(p.body, 'comment', 60000) }),
    describe: (p, ctx) => `Comment on #${p.number}` + titleOf(ctx, p.number),
    argv: (p) => ['issue', 'comment', String(p.number), '--body', p.body],
  },

  edit: {
    validate(p, ctx) {
      const n = posInt(p.number, 'issue number');
      const out = { number: n };
      if (p.title != null && p.title !== '') out.title = noLeadingDash(text(p.title, 'title', 256), 'title');
      if (p.body != null) out.body = text(p.body, 'body', 60000, { required: false }) || '';
      if (p.milestone !== undefined) {
        if (p.milestone === null || p.milestone === '') out.removeMilestone = true;
        else {
          const m = text(p.milestone, 'milestone', 200);
          if (ctx && ctx.milestones && !ctx.milestones.some(x => x.title === m)) {
            bad(`No milestone named "${m}" in this repo`);
          }
          out.milestone = m;
        }
      }
      for (const key of ['addLabels', 'removeLabels']) {
        if (!p[key]) continue;
        if (!Array.isArray(p[key])) bad(key + ' must be a list');
        out[key] = p[key].map(l => {
          const name = text(l, 'label', 80);
          if (ctx && ctx.labels && !ctx.labels.some(x => x.name === name)) bad(`No label named "${name}" in this repo`);
          return name;
        });
      }
      for (const key of ['addAssignees', 'removeAssignees']) {
        if (!p[key]) continue;
        if (!Array.isArray(p[key])) bad(key + ' must be a list');
        out[key] = p[key].map(l => {
          const who = text(l, 'assignee', 39);
          if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(who)) bad(`"${who}" is not a valid GitHub login`);
          return who;
        });
      }
      const touched = Object.keys(out).filter(k => k !== 'number');
      if (!touched.length) bad('That edit does not change anything');
      return out;
    },
    describe(p, ctx) {
      const bits = [];
      if (p.title) bits.push('retitle');
      if (p.body != null) bits.push('rewrite body');
      if (p.milestone) bits.push(`milestone → ${p.milestone}`);
      if (p.removeMilestone) bits.push('clear milestone');
      if (p.addLabels && p.addLabels.length) bits.push('+' + p.addLabels.join(', +'));
      if (p.removeLabels && p.removeLabels.length) bits.push('−' + p.removeLabels.join(', −'));
      if (p.addAssignees && p.addAssignees.length) bits.push('assign ' + p.addAssignees.join(', '));
      if (p.removeAssignees && p.removeAssignees.length) bits.push('unassign ' + p.removeAssignees.join(', '));
      return `Edit #${p.number}: ${bits.join(' · ')}` + titleOf(ctx, p.number);
    },
    argv(p) {
      const a = ['issue', 'edit', String(p.number)];
      if (p.title) a.push('--title', p.title);
      if (p.body != null) a.push('--body', p.body);
      if (p.milestone) a.push('--milestone', p.milestone);
      if (p.removeMilestone) a.push('--remove-milestone');
      for (const l of p.addLabels || []) a.push('--add-label', l);
      for (const l of p.removeLabels || []) a.push('--remove-label', l);
      for (const w of p.addAssignees || []) a.push('--add-assignee', w);
      for (const w of p.removeAssignees || []) a.push('--remove-assignee', w);
      return a;
    },
  },

  milestone: {
    validate(p, ctx) {
      const title = noLeadingDash(text(p.title, 'milestone title', 200), 'milestone title');
      if (ctx && ctx.milestones && ctx.milestones.some(m => m.title === title)) {
        bad(`A milestone called "${title}" already exists`);
      }
      const out = { title };
      const desc = text(p.description, 'description', 4000, { required: false });
      if (desc) out.description = desc;
      if (p.dueOn) {
        const d = String(p.dueOn).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) bad('Due date must be YYYY-MM-DD');
        const when = new Date(d + 'T00:00:00Z');
        if (isNaN(when.getTime())) bad('That is not a real date');
        out.dueOn = d;
      }
      return out;
    },
    describe: (p) => `Create milestone “${p.title}”` + (p.dueOn ? ` (due ${p.dueOn})` : ''),
    argv(p) {
      const a = ['api', '--method', 'POST', 'repos/:owner/:repo/milestones', '-f', 'title=' + p.title];
      if (p.description) a.push('-f', 'description=' + p.description);
      if (p.dueOn) a.push('-f', 'due_on=' + p.dueOn + 'T00:00:00Z');
      return a;
    },
  },

  create: {
    validate(p, ctx) {
      const out = { title: noLeadingDash(text(p.title, 'title', 256), 'title'), body: text(p.body, 'body', 60000, { required: false }) || '' };
      if (p.milestone) {
        const m = text(p.milestone, 'milestone', 200);
        if (ctx && ctx.milestones && !ctx.milestones.some(x => x.title === m)) bad(`No milestone named "${m}" in this repo`);
        out.milestone = m;
      }
      if (p.labels) {
        if (!Array.isArray(p.labels)) bad('labels must be a list');
        out.labels = p.labels.map(l => {
          const name = text(l, 'label', 80);
          if (ctx && ctx.labels && !ctx.labels.some(x => x.name === name)) bad(`No label named "${name}" in this repo`);
          return name;
        });
      }
      if (p.assignees) {
        if (!Array.isArray(p.assignees)) bad('assignees must be a list');
        out.assignees = p.assignees.map(l => {
          const who = text(l, 'assignee', 39);
          if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(who)) bad(`"${who}" is not a valid GitHub login`);
          return who;
        });
      }
      return out;
    },
    describe: (p) => `Create “${p.title.length > 54 ? p.title.slice(0, 54) + '…' : p.title}”`,
    argv(p) {
      const a = ['issue', 'create', '--title', p.title, '--body', p.body || ''];
      if (p.milestone) a.push('--milestone', p.milestone);
      for (const l of p.labels || []) a.push('--label', l);
      for (const w of p.assignees || []) a.push('--assignee', w);
      return a;
    },
  },
};

function titleOf(ctx, number) {
  const hit = ctx && ctx.issues && ctx.issues.find(i => i.n === number);
  if (!hit) return '';
  const t = hit.t.length > 46 ? hit.t.slice(0, 46) + '…' : hit.t;
  return ' — ' + t;
}

class Queue {
  constructor() { this.all = loadAll(); }

  for(repoPath) { return this.all[repoPath] || []; }

  add(repoPath, kind, payload, ctx) {
    const spec = KINDS[kind];
    if (!spec) bad(`Unknown change type "${kind}"`);
    // A milestone staged earlier in this session counts as real for validation, so you can
    // stage "create milestone X" and then stage issues into X without pushing in between.
    const pending = this.for(repoPath)
      .filter(c => c.kind === 'milestone')
      .map(c => ({ title: c.payload.title }));
    const ctx2 = Object.assign({}, ctx, {
      milestones: [...((ctx && ctx.milestones) || []), ...pending],
    });
    const clean = spec.validate(payload || {}, ctx2);
    const list = this.for(repoPath);

    // Staging the same operation twice is almost always a double-click, not intent.
    const sig = kind + ':' + JSON.stringify(clean);
    if (list.some(c => c.sig === sig)) bad('That change is already staged');
    // Closing something you just staged a reopen for (or vice versa) is contradictory.
    if (kind === 'close' && list.some(c => c.kind === 'reopen' && c.payload.number === clean.number)) {
      bad(`#${clean.number} already has a staged reopen — remove it first`);
    }
    if (kind === 'reopen' && list.some(c => c.kind === 'close' && c.payload.number === clean.number)) {
      bad(`#${clean.number} already has a staged close — remove it first`);
    }

    const change = {
      id: newId(), kind, payload: clean, sig,
      summary: spec.describe(clean, ctx2),
      argv: spec.argv(clean),
      stagedAt: new Date().toISOString(),
    };
    this.all[repoPath] = [...list, change];
    saveAll(this.all);
    return change;
  }

  /*
   * Edit a change that is already staged. Re-validates from scratch and rebuilds the argv,
   * so a staged item can never drift out of sync with what will actually run. Keeps its
   * position in the queue, because order is meaningful at push time.
   */
  update(repoPath, id, payload, ctx) {
    const list = this.for(repoPath);
    const at = list.findIndex(c => c.id === id);
    if (at < 0) bad('No staged change with that id');
    const old = list[at];
    const spec = KINDS[old.kind];
    if (!spec) bad(`Unknown change type "${old.kind}"`);

    const pending = list
      .filter((c, k) => k !== at && c.kind === 'milestone')
      .map(c => ({ title: c.payload.title }));
    const ctx2 = Object.assign({}, ctx, {
      milestones: [...((ctx && ctx.milestones) || []), ...pending],
    });

    // Merge onto the existing payload so a partial edit only changes what it names.
    const merged = Object.assign({}, old.payload, payload || {});
    const clean = spec.validate(merged, ctx2);
    const sig = old.kind + ':' + JSON.stringify(clean);
    if (list.some((c, k) => k !== at && c.sig === sig)) bad('That would duplicate another staged change');

    const next = Object.assign({}, old, {
      payload: clean, sig,
      summary: spec.describe(clean, ctx2),
      argv: spec.argv(clean),
      editedAt: new Date().toISOString(),
    });
    const copy = [...list]; copy[at] = next;
    this.all[repoPath] = copy;
    saveAll(this.all);
    return next;
  }

  /* Reorder: push applies in list order, so this is meaningful. */
  move(repoPath, id, delta) {
    const list = [...this.for(repoPath)];
    const at = list.findIndex(c => c.id === id);
    if (at < 0) bad('No staged change with that id');
    const to = Math.max(0, Math.min(list.length - 1, at + (Number(delta) || 0)));
    if (to === at) return list;
    const [item] = list.splice(at, 1);
    list.splice(to, 0, item);
    this.all[repoPath] = list;
    saveAll(this.all);
    return list;
  }

  remove(repoPath, id) {
    const list = this.for(repoPath);
    const next = list.filter(c => c.id !== id);
    if (next.length === list.length) bad('No staged change with that id');
    this.all[repoPath] = next;
    saveAll(this.all);
    return next;
  }

  clear(repoPath) {
    this.all[repoPath] = [];
    saveAll(this.all);
    return [];
  }

  /*
   * Apply in staged order, one at a time. A failure does NOT roll back what already
   * succeeded — it stops, keeps the rest staged, and reports exactly where it stopped,
   * which is the only honest thing to do against a remote API.
   */
  async push(repoPath, dir) {
    const staged = this.for(repoPath);
    if (!staged.length) bad('Nothing staged to push');
    // Milestones are prerequisites for the issue edits that reference them, so they go
    // first regardless of the order they were staged in.
    const list = [
      ...staged.filter(c => c.kind === 'milestone'),
      ...staged.filter(c => c.kind !== 'milestone'),
    ];
    const results = [];
    let remaining = [...list];
    for (const change of list) {
      try {
        const r = await ghWrite(dir, change.argv, {
          label: change.summary,
          fakeStdout: 'https://github.com/dry-run/issues/0',
        });
        const url = (String(r.stdout).match(/https?:\/\/\S+/) || [])[0] || null;
        results.push({ id: change.id, summary: change.summary, ok: true, dryRun: !!r.dryRun, url });
        remaining = remaining.filter(c => c.id !== change.id);
      } catch (e) {
        results.push({ id: change.id, summary: change.summary, ok: false, error: e.message });
        break;                                   // stop at the first failure
      }
    }
    this.all[repoPath] = remaining;
    saveAll(this.all);
    const applied = results.filter(r => r.ok).length;
    const failed = results.find(r => !r.ok);
    return {
      ok: !failed,
      applied,
      remaining: remaining.length,
      results,
      message: failed
        ? `Applied ${applied}, then stopped: ${failed.error}`
        : `Applied ${applied} change${applied === 1 ? '' : 's'}`,
    };
  }
}

module.exports = { Queue, KINDS };
