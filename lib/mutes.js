'use strict';
/*
 * Temporarily silencing part of a plan.
 *
 * There is already an IGNORE list, and this is deliberately not it. Ignoring a proposed issue
 * is a verdict — "this is not work, stop suggesting it" — and it is remembered against every
 * future run. Most of what a reader wants to do to a plan is far weaker than that: this entry
 * is real but not now, or the model put it third and it belongs ninth, or this dependency edge
 * is simply wrong. Neither of those is a reason to stage anything, and the only way to act on
 * them today is to stage a change you do not want or to regenerate the whole plan and hope.
 *
 * So a mute is a per-repository, reversible "not right now" with no side effects: nothing is
 * queued, nothing is written to a tracker, and the entry comes back the moment it is unmuted.
 * Its one non-cosmetic effect is on generation — a muted entry is shown to the model as
 * something the user pushed down, and a muted dependency is refused outright rather than
 * re-proposed, because a plan that re-offers a rejected edge every run is not being reviewed,
 * it is being argued with.
 *
 * KEYS, not indices. A plan is regenerated constantly; position means nothing across runs.
 * Existing work is keyed by its issue numbers and a proposal by its title, so a mute survives
 * regeneration exactly as long as the thing it was about still exists.
 */

/* Enough to mute every entry of several large plans; a bound exists so a corrupt or
 * hand-edited file cannot grow without limit. */
const MAX = 500;

const titleKey = (value) => String(value == null ? '' : value)
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/*
 * The identity of one ranked entry.
 *
 * Grouped entries ("do #12 and #14 together") are one row and get one key, sorted so the same
 * pair in the other order is the same mute. A proposal has no number yet, so its normalized
 * title is the only stable handle it has.
 */
function itemKey(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.gap) {
    const key = titleKey(entry.gap);
    return key ? 'gap:' + key : null;
  }
  const ns = [...new Set((Array.isArray(entry.ns) ? entry.ns : []).filter(Number.isInteger))];
  if (!ns.length) return null;
  return 'ns:' + ns.sort((a, b) => a - b).join(',');
}

/* One edge, not one card. A proposal that says #9 waits on #5 and #7 can be half wrong, and
 * refusing the whole card to reject half of it loses the half that was right. */
function depKey(blocked, blocker) {
  const from = Number(blocked); const to = Number(blocker);
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  return 'dep:' + from + ':' + to;
}

/* The issue numbers a mute key refers to, for the prompt. Proposals have none. */
function numbersFromKey(key) {
  const raw = String(key || '');
  if (raw.startsWith('ns:')) return raw.slice(3).split(',').map(Number).filter(Number.isInteger);
  if (raw.startsWith('dep:')) return raw.slice(4).split(':').map(Number).filter(Number.isInteger);
  return [];
}

const KINDS = ['items', 'deps'];

/* A stored file is user-editable JSON like every other cache here, so it is validated on the
 * way in rather than trusted. An entry that survives is {key, label, at} and nothing else. */
function entryList(raw) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(raw) ? raw : []) {
    const source = typeof value === 'string' ? { key: value } : value;
    if (!source || typeof source !== 'object') continue;
    const key = String(source.key || '').slice(0, 200).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      label: String(source.label || '').slice(0, 240) || null,
      at: typeof source.at === 'string' ? source.at.slice(0, 40) : null,
    });
    if (out.length >= MAX) break;
  }
  return out;
}

function normalize(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { items: entryList(value.items), deps: entryList(value.deps) };
}

const empty = () => ({ items: [], deps: [] });

/* The shape every reader wants: membership tests, not lists. */
function keySets(mutes) {
  const value = normalize(mutes);
  return {
    items: new Set(value.items.map(x => x.key)),
    deps: new Set(value.deps.map(x => x.key)),
  };
}

function add(mutes, kind, key, label) {
  const value = normalize(mutes);
  if (!KINDS.includes(kind)) return { mutes: value, changed: false };
  const id = String(key || '').slice(0, 200).trim();
  if (!id) return { mutes: value, changed: false };
  if (value[kind].some(x => x.key === id)) return { mutes: value, changed: false };
  value[kind].unshift({
    key: id,
    label: String(label || '').slice(0, 240) || null,
    at: new Date().toISOString(),
  });
  value[kind] = value[kind].slice(0, MAX);
  return { mutes: value, changed: true };
}

function remove(mutes, kind, key) {
  const value = normalize(mutes);
  if (!KINDS.includes(kind)) return { mutes: value, changed: false };
  const id = String(key || '').trim();
  const before = value[kind].length;
  value[kind] = value[kind].filter(x => x.key !== id);
  return { mutes: value, changed: value[kind].length !== before };
}

function clear(mutes, kind) {
  const value = normalize(mutes);
  if (kind && !KINDS.includes(kind)) return { mutes: value, cleared: 0 };
  const kinds = kind ? [kind] : KINDS;
  let cleared = 0;
  for (const k of kinds) { cleared += value[k].length; value[k] = []; }
  return { mutes: value, cleared };
}

const count = (mutes) => {
  const value = normalize(mutes);
  return value.items.length + value.deps.length;
};

module.exports = {
  KINDS, MAX, titleKey, itemKey, depKey, numbersFromKey,
  normalize, empty, keySets, add, remove, clear, count,
};
