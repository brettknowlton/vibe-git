'use strict';
/*
 * When you last acknowledged this tracker.
 *
 * Deliberately NOT stored in the issue cache. That file is documented as a cache of public
 * tracker data which a pull overwrites wholesale, and this is the opposite kind of thing:
 * a private fact about the reader that must survive every pull. Putting it there would make
 * "overwrites wholesale" a lie the next person has to discover.
 *
 * One timestamp per repository, which is enough because the question it answers is "what has
 * happened here that I have not looked at" — and the events themselves are already dated in
 * the issue cache. Marking as seen is therefore a single write, not a set of read flags, and
 * it cannot drift out of sync with the issues it describes.
 */

const fs = require('fs');
const path = require('path');
const { CONFIG_DIR } = require('./repos');

const FILE = path.join(CONFIG_DIR, 'seen.json');

function loadAll() {
  try {
    const v = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

function saveAll(all) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
  } catch (e) { console.error('  ! could not record what you have seen: ' + e.message); }
}

/* Length-capped before parsing, not because Date.parse is known to be slow on a long input
   but because this value arrives from a request body and is then written to disk. Nothing
   date-shaped needs 40 characters, so anything longer is not a timestamp. */
const iso = (v) =>
  (typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : null);

/* null means "never marked", which the caller must treat as "show nothing" rather than as
   "everything is new" — opening a 600-issue tracker for the first time and being told all
   600 events are unread is not news, it is a wall. */
function seenAt(slug) {
  if (!slug) return null;
  return iso(loadAll()[slug]);
}

function markSeen(slug, when) {
  if (!slug) return null;
  const stamp = iso(when) || new Date().toISOString();
  const all = loadAll();
  all[slug] = stamp;
  saveAll(all);
  return stamp;
}

/*
 * What has happened since, as counts rather than as a feed.
 *
 * `mine` is the part that turns a digest into a prompt: work other people did on issues
 * assigned to you, or replies on threads you are in. Your own actions are excluded
 * throughout — being told about the issue you closed two minutes ago is noise, and noise is
 * how a notification surface gets ignored.
 */
function digest(issues, since, login) {
  const empty = { since: since || null, filed: [], closed: [], commented: [], mine: [], total: 0 };
  if (!since) return empty;
  const after = (t) => typeof t === 'string' && t > since;
  const me = String(login || '').toLowerCase();
  const out = Object.assign({}, empty, { filed: [], closed: [], commented: [], mine: [] });

  for (const i of issues || []) {
    const assigned = me && (i.a || []).some(a => String(a).toLowerCase() === me);
    if (after(i.createdAt)) out.filed.push(i.n);
    if (after(i.closedAt)) out.closed.push(i.n);
    const fresh = (i.cm || []).filter(c => after(c.at) &&
      (!me || String(c.who || '').toLowerCase() !== me));
    if (fresh.length) {
      out.commented.push(i.n);
      // A reply on something assigned to you, or on a thread you have spoken in, is the
      // subset actually worth interrupting for.
      const spoke = me && (i.cm || []).some(c => String(c.who || '').toLowerCase() === me);
      if (assigned || spoke) out.mine.push(i.n);
    }
  }
  out.total = out.filed.length + out.closed.length + out.commented.length;
  return out;
}

module.exports = { seenAt, markSeen, digest, FILE };
