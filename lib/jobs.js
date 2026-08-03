'use strict';
/*
 * Cancellable assistant work.
 *
 * A local model can take minutes on a long classification run, and there is no way to
 * "un-ask" it once the HTTP request is in flight. So every assistant action runs under a
 * job: the browser mints an id, sends it with the request, and can cancel it at any time.
 *
 * Cancelling does two things, and both matter:
 *   - sets a flag the batching loops check between items, so queued work never starts
 *   - destroys the sockets of requests already in flight, so the model stops streaming
 *     into a response nobody is waiting for
 *
 * Nothing here touches git, gh, or the staged queue. Cancelling an assistant job can only
 * ever abandon a proposal, never leave a half-applied write.
 */

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

class CancelError extends Error {
  constructor(message) {
    super(message || 'Cancelled');
    this.name = 'CancelError';
    this.cancelled = true;
    this.status = 499;
  }
}

const isCancel = (e) => !!(e && (e.cancelled || e.name === 'CancelError'));

class Jobs {
  constructor() { this.map = new Map(); }

  /*
   * The id comes from the client so the Cancel button works from the instant the request
   * leaves the browser — waiting for a server-minted id would leave the first (and often
   * longest) call uncancellable. An unusable id is replaced rather than rejected: a bad id
   * should cost you the ability to cancel, not the ability to run.
   */
  start(id, kind, label) {
    const key = ID_RE.test(String(id || '')) ? String(id) : 'srv-' + Math.random().toString(36).slice(2, 12);
    this.cancel(key);                       // a re-used id supersedes whatever held it
    const signal = {
      id: key, kind: kind || 'ai', label: label || '',
      cancelled: false, reqs: new Set(), done: 0, total: 0,
      startedAt: Date.now(),
    };
    this.map.set(key, signal);
    return signal;
  }

  get(id) { return this.map.get(String(id || '')) || null; }

  cancel(id) {
    const signal = this.map.get(String(id || ''));
    if (!signal) return false;
    signal.cancelled = true;
    for (const req of signal.reqs) {
      try { req.destroy(new CancelError()); } catch { /* already gone */ }
    }
    signal.reqs.clear();
    return true;
  }

  cancelAll() {
    let n = 0;
    for (const id of [...this.map.keys()]) if (this.cancel(id)) n++;
    return n;
  }

  finish(signal) {
    if (!signal) return;
    const held = this.map.get(signal.id);
    // Only clear the slot if it still holds THIS run; a superseding start already owns it.
    if (held === signal) this.map.delete(signal.id);
  }

  active() {
    return [...this.map.values()].map(s => ({
      id: s.id, kind: s.kind, label: s.label,
      done: s.done, total: s.total, cancelled: s.cancelled,
      seconds: Math.round((Date.now() - s.startedAt) / 1000),
    }));
  }
}

module.exports = { Jobs, CancelError, isCancel };
