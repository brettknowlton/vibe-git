'use strict';
/*
 * Finding issues by meaning, and finding issues that are the same issue twice.
 *
 * Every issue in a repository already has an embedding cached on disk — built for
 * classification precedent, then never used for anything else. That is a full semantic
 * index of the tracker sitting idle, so this module spends it:
 *
 *   - search: hybrid ranking. Lexical matching wins on identifiers and exact words, vectors
 *     win on "the thing where the shop and the house share a wall". Neither alone is good
 *     enough, so both run and the scores are blended.
 *   - duplicates: all-pairs cosine over the cached vectors, agglomerated into clusters.
 *     No model inference at all, so it is instant and can run on every pull.
 *
 * Lexical scoring is deliberately plain. It is a tracker with a few hundred issues, not a
 * search engine, and a scoring function you can read is worth more here than one that is
 * theoretically better.
 */

const STOP = new Set(('a an the and or of for to in on at with is are be been being it its this that ' +
  'from by as if then than so we i you he she they them our your my me not no yes do does did ' +
  'can could should would will shall may might must have has had').split(' '));

const fold = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();
const stem = (w) => w.replace(/ies$/, 'y').replace(/(sses|shes|ches)$/, '$1').replace(/s$/, '');

function terms(text) {
  return fold(text).split(/\s+/).filter(w => w && w.length > 1 && !STOP.has(w)).map(stem);
}

/* Inverse document frequency, so "the shop" does not outrank "chest" in a shop tracker. */
function idfOver(issues) {
  const docs = issues.length || 1;
  const seen = new Map();
  for (const issue of issues) {
    for (const term of new Set(terms(issue.t + ' ' + (issue.body || '')))) {
      seen.set(term, (seen.get(term) || 0) + 1);
    }
  }
  return (term) => Math.log(1 + docs / (1 + (seen.get(term) || 0)));
}

/*
 * Lexical relevance of one issue to a query. Title hits count for much more than body hits:
 * an issue whose TITLE is about chests is about chests; one that mentions a chest in passing
 * halfway down a checklist usually is not.
 */
function lexicalScore(issue, queryTerms, idf) {
  if (!queryTerms.length) return 0;
  const title = new Set(terms(issue.t));
  const body = new Set(terms(issue.body || ''));
  const labels = new Set(terms((issue.l || []).join(' ')));
  let score = 0, weight = 0;
  for (const term of queryTerms) {
    const w = idf(term);
    weight += w * 3;
    if (title.has(term)) score += w * 3;
    else if (labels.has(term)) score += w * 1.5;
    else if (body.has(term)) score += w * 1;
  }
  if (!weight) return 0;
  // Whole-phrase appearance in the title is a strong signal a bag of words cannot express.
  const phrase = fold(queryTerms.join(' '));
  const bonus = phrase && fold(issue.t).includes(phrase) ? 0.25 : 0;
  return Math.min(1, score / weight + bonus);
}

const cosine = (a, b) => {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
};

/*
 * What "similar" is worth in THIS repository.
 *
 * Absolute cosine thresholds are close to meaningless across embedders and corpora. On a
 * real 114-issue tracker with nomic-embed-text the pairwise similarities ran from 0.26 to
 * 0.84 with a median of 0.49 — so a 0.9 "duplicate" threshold could never fire, and a 0.55
 * "related" floor would have matched half the tracker. Both numbers sounded reasonable and
 * both were wrong.
 *
 * So thresholds are derived from the corpus instead of asserted. Sampling is strided rather
 * than random, so the same index always calibrates to the same numbers.
 */
function calibrate(vectors, { sample = 4000 } = {}) {
  const nums = Object.keys(vectors).map(Number);
  const scores = [];
  const total = nums.length * (nums.length - 1) / 2;
  const stride = Math.max(1, Math.floor(total / sample));
  let seen = 0;
  for (let a = 0; a < nums.length; a++) {
    for (let b = a + 1; b < nums.length; b++) {
      if (seen++ % stride) continue;
      scores.push(cosine(vectors[nums[a]], vectors[nums[b]]));
    }
  }
  if (scores.length < 8) {
    return { pairs: scores.length, median: 0.5, p90: 0.7, p99: 0.85, max: 0.95, calibrated: false };
  }
  scores.sort((x, y) => x - y);
  const at = (q) => scores[Math.min(scores.length - 1, Math.floor(scores.length * q))];
  return {
    pairs: scores.length,
    median: at(0.5), p90: at(0.9), p99: at(0.99), max: scores[scores.length - 1],
    calibrated: true,
  };
}

/*
 * Two issues can be near-identical in embedding space and still be different work.
 *
 * "Art: Inventory Tab - Grimoire" and "Art: Inventory Tab - Quests" scored 0.84 — higher
 * than a real duplicate pair in the same tracker — because they are deliberately parallel
 * tasks in one series. The tell is structural, not semantic: a shared leading phrase, and
 * exactly the distinguishing word differing on each side. That is a series, not a repeat.
 */
function seriesLike(titleA, titleB) {
  const wordsA = fold(titleA).split(/\s+/).filter(Boolean);
  const wordsB = fold(titleB).split(/\s+/).filter(Boolean);
  if (!wordsA.length || !wordsB.length) return false;
  let prefix = 0;
  while (prefix < wordsA.length && prefix < wordsB.length && wordsA[prefix] === wordsB[prefix]) prefix++;
  if (prefix < 2) return false;
  const restA = new Set(wordsA.slice(prefix).filter(w => !STOP.has(w)));
  const restB = new Set(wordsB.slice(prefix).filter(w => !STOP.has(w)));
  if (!restA.size || !restB.size) return false;
  // Each side keeps something the other does not: the thing that makes it its own task.
  const uniqueA = [...restA].some(w => !restB.has(w));
  const uniqueB = [...restB].some(w => !restA.has(w));
  return uniqueA && uniqueB;
}

/*
 * Hybrid search.
 *
 * `vectors` maps issue number → embedding, and `queryVec` is the embedded query. Both are
 * optional: with no embedding model configured this degrades to lexical search rather than
 * to nothing, which is the difference between a feature that sometimes works and a feature
 * that sometimes vanishes.
 */
function search(issues, query, { vectors = null, queryVec = null, limit = 30, state = 'open', scale = null } = {}) {
  const q = String(query || '').trim();
  const pool = issues.filter(i => state === 'all' ? true : (state === 'closed' ? i.st !== 'OPEN' : i.st === 'OPEN'));
  if (!q) return { hits: [], mode: 'empty' };

  // "#123" is a lookup, not a search. Answer it exactly rather than by similarity.
  const direct = /^#?(\d+)$/.exec(q);
  if (direct) {
    const hit = issues.find(i => i.n === Number(direct[1]));
    return { hits: hit ? [{ number: hit.n, score: 1, why: 'exact issue number' }] : [], mode: 'number' };
  }

  const idf = idfOver(pool);
  const queryTerms = terms(q);
  const semantic = !!(vectors && queryVec);
  // Everything above the corpus median is "more alike than two issues picked at random";
  // the top of the observed range is as alike as this embedder ever says things are.
  // A query is a short fragment, not an issue, so it never reaches the similarity two real
  // issues hit. The top of the useful band is the 99th percentile of issue-to-issue pairs,
  // not the maximum — using the maximum compresses every query result into the floor.
  const floor = scale && scale.calibrated ? scale.median : 0.35;
  const ceil = scale && scale.calibrated ? Math.max(scale.p99, floor + 0.05) : 0.8;
  const scored = pool.map(issue => {
    const lex = lexicalScore(issue, queryTerms, idf);
    const vec = semantic && vectors[issue.n] ? Math.max(0, cosine(queryVec, vectors[issue.n])) : 0;
    // Vector scores sit in a narrow band well above zero, so a raw blend lets a
    // mediocre-but-plausible match outrank an exact word hit. Stretching the score across
    // the range this corpus actually produces makes the two comparable.
    const stretched = vec <= 0 ? 0 : Math.max(0, (vec - floor) / (ceil - floor));
    const fromMeaning = 0.62 * Math.min(1, stretched);
    const fromText = 0.38 * lex;
    const score = semantic ? Math.max(lex, fromMeaning + fromText) : lex;
    // Say which half earned the hit by comparing what each contributed, not by fixed
    // thresholds — the absolute numbers differ per corpus, the ratio does not.
    const why = !semantic || fromMeaning <= 0.02 ? 'text match'
      : lex <= 0.02 ? 'similar meaning'
        : fromMeaning > fromText * 1.6 ? 'similar meaning'
          : fromText > fromMeaning * 1.6 ? 'text match'
            : 'text and meaning';
    return { number: issue.n, score, lex, vec, why };
  }).filter(hit => hit.score > 0.08);

  scored.sort((a, b) => b.score - a.score || b.number - a.number);
  return {
    hits: scored.slice(0, Math.max(1, Math.min(limit, 200))),
    mode: semantic ? 'hybrid' : 'lexical',
  };
}

/*
 * Near-duplicate clusters over the whole tracker.
 *
 * Agglomerative on purpose: three issues that each describe "the shop needs a chest" should
 * come back as one cluster of three, not three overlapping pairs a person has to reconcile.
 * Issues already in the same milestone are held to a slightly higher bar, because a phase
 * legitimately contains several related-sounding pieces of one job.
 */
function duplicates(issues, vectors, { threshold = null, limit = 20, includeClosed = false, scale = null } = {}) {
  const pool = issues.filter(i => (includeClosed || i.st === 'OPEN') && vectors[i.n]);
  const cal = scale || calibrate(vectors);
  /*
   * Default to "as alike as the top 1% of pairs in this repository, and clearly above the
   * middle of it". Both halves matter: a tracker of near-identical chores has a high p99
   * that means nothing, and a tracker of unrelated work has a low one.
   */
  const bar = threshold != null ? threshold
    : Math.max(cal.p99, cal.median + 0.85 * (cal.max - cal.median));
  const pairs = [];
  for (let a = 0; a < pool.length; a++) {
    for (let b = a + 1; b < pool.length; b++) {
      const left = pool[a], right = pool[b];
      const raw = cosine(vectors[left.n], vectors[right.n]);
      // Parallel work in one series is the loudest false positive there is; discount it
      // rather than dropping it, so a genuine repeat inside a series can still surface.
      const series = seriesLike(left.t, right.t);
      const score = series ? raw - 0.12 : raw;
      // A shared milestone is weak evidence of "one job split up", not of duplication.
      const localBar = left.ms && left.ms === right.ms ? bar + 0.015 : bar;
      if (score >= localBar) pairs.push({ a: left.n, b: right.n, score, raw, series });
    }
  }
  pairs.sort((x, y) => y.score - x.score);

  /*
   * COMPLETE linkage, not single linkage.
   *
   * Chaining on any one edge is what turns "these two are the same issue" into a group of
   * seven that merely share a topic: A resembles B, B resembles C, and C has nothing to do
   * with A. Requiring every member to clear the bar against every other member keeps a
   * group meaning "all of these are the same work", which is the only claim worth making.
   */
  const scoreOf = new Map(pairs.map(p => [p.a + ':' + p.b, p.score]));
  const between = (x, y) => scoreOf.get(Math.min(x, y) + ':' + Math.max(x, y)) || 0;
  const clusters = [];
  for (const pair of pairs) {
    const existing = clusters.find(members =>
      (members.includes(pair.a) || members.includes(pair.b)) &&
      members.every(m => m === pair.a || m === pair.b ||
        (between(m, pair.a) >= bar && between(m, pair.b) >= bar)));
    if (existing) {
      if (!existing.includes(pair.a)) existing.push(pair.a);
      if (!existing.includes(pair.b)) existing.push(pair.b);
    } else if (!clusters.some(members => members.includes(pair.a) && members.includes(pair.b))) {
      clusters.push([pair.a, pair.b]);
    }
  }
  const groups = new Map(clusters.map((members, idx) => [idx, members]));

  const byNum = new Map(issues.map(i => [i.n, i]));
  const strength = (members) => {
    let best = 0;
    for (const pair of pairs) {
      if (members.includes(pair.a) && members.includes(pair.b)) best = Math.max(best, pair.score);
    }
    return best;
  };
  return [...groups.values()]
    .filter(members => members.length > 1)
    .map(members => {
      const sorted = members.slice().sort((x, y) => x - y);
      // The oldest issue is the one to keep: it holds the history and any discussion.
      const keep = sorted[0];
      const anySeries = pairs.some(p => p.series && sorted.includes(p.a) && sorted.includes(p.b));
      return {
        keep,
        members: sorted.map(n => {
          const issue = byNum.get(n);
          return {
            number: n, title: issue.t, state: issue.st, milestone: issue.ms || null,
            comments: issue.comments || 0, updatedAt: issue.updatedAt || null,
          };
        }),
        score: Math.round(strength(sorted) * 1000) / 1000,
        // Surfaced so the card can warn rather than silently imply these are the same job.
        series: anySeries,
      };
    })
    .sort((x, y) => y.score - x.score)
    .slice(0, Math.max(1, Math.min(limit, 100)));
}

/* Issues that resemble one issue — the "you may also mean" beside an open issue. */
function related(issues, number, vectors, { limit = 5, floor = null, scale = null } = {}) {
  const target = vectors[number];
  if (!target) return [];
  // "Related" has to mean more than "in the same project". On a real tracker the median
  // pair already scores ~0.5, so anything below the 90th percentile is just topic overlap.
  const cal = scale || calibrate(vectors);
  const bar = floor != null ? floor : Math.max(cal.p90, cal.median + 0.35 * (cal.max - cal.median));
  const byNum = new Map(issues.map(i => [i.n, i]));
  return Object.keys(vectors)
    .map(Number)
    .filter(n => n !== number && byNum.has(n))
    .map(n => ({ number: n, score: cosine(target, vectors[n]) }))
    .filter(hit => hit.score >= bar)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(hit => {
      const issue = byNum.get(hit.number);
      return {
        number: hit.number, title: issue.t, state: issue.st, milestone: issue.ms || null,
        score: Math.round(hit.score * 1000) / 1000,
      };
    });
}

/*
 * Dependency structure of the tracker, from the edges lib/issues.js now keeps.
 *
 * "Ready" means open, and not waiting on anything still open. That is the single most
 * useful question a tracker can answer and neither GitHub Desktop nor the issues web UI
 * will answer it.
 */
function dependencies(issues) {
  const open = issues.filter(i => i.st === 'OPEN');
  const openNums = new Set(open.map(i => i.n));
  const blocking = new Map();          // n → issues that are waiting on n
  for (const issue of open) {
    for (const dep of issue.bk || []) {
      if (!openNums.has(dep)) continue;
      if (!blocking.has(dep)) blocking.set(dep, []);
      blocking.get(dep).push(issue.n);
    }
  }
  const ready = open
    .filter(i => !(i.bk || []).some(dep => openNums.has(dep)))
    .map(i => i.n);
  return {
    ready,
    blocked: open.filter(i => (i.bk || []).some(dep => openNums.has(dep)))
      .map(i => ({ number: i.n, waitingOn: (i.bk || []).filter(dep => openNums.has(dep)) })),
    // An issue many others wait on is the highest-leverage thing to finish.
    unblocks: [...blocking.entries()]
      .map(([number, waiters]) => ({ number, waiters: waiters.sort((a, b) => a - b) }))
      .sort((a, b) => b.waiters.length - a.waiters.length),
  };
}

/*
 * Would declaring "blocked waits on blocker" close a loop?
 *
 * Worth refusing rather than drawing, because a cycle is not a hard graph to render — it is a
 * claim that none of the issues in it can ever be started, which is never what anyone meant.
 * The model proposing edges gets this wrong in a specific way: it reads two issues that each
 * mention the other and declares both directions.
 *
 * Walks UP from the proposed blocker: if the issue being blocked is already somewhere above
 * it, the new edge would point back down into its own ancestry.
 */
function wouldCycle(issues, blocked, blocker, extraEdges) {
  if (blocked === blocker) return true;
  const byNum = new Map(issues.map(i => [i.n, i]));
  // Edges staged in this same batch count too, or a set of individually fine proposals can
  // still close a loop once they are all applied.
  const extra = new Map();
  for (const [to, from] of extraEdges || []) {
    if (!extra.has(to)) extra.set(to, []);
    extra.get(to).push(from);
  }
  const upstream = (n) => ((byNum.get(n) || {}).bk || []).concat(extra.get(n) || []);

  const seen = new Set();
  const stack = [blocker];
  while (stack.length) {
    const at = stack.pop();
    if (at === blocked) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const up of upstream(at)) stack.push(up);
  }
  return false;
}

/*
 * Validate a batch of proposed dependency edges into ones that can actually be declared.
 *
 * Shared by every path that can produce them — classification, plan generation, and the chat
 * tool — because a model proposing edges makes the same four mistakes wherever it is asked:
 * an issue blocking itself, an edge to something closed or non-existent, an edge that is
 * already written down, and a pair that closes a loop. Each is dropped with a reason rather
 * than failing the batch, so one bad edge does not lose four good ones.
 *
 * Edges accepted earlier in the batch count when checking later ones for cycles, or a set of
 * individually-fine proposals can still close a loop once all of them are applied.
 */
function normalizeDeps(raw, { issues, limit = 12 } = {}) {
  const byNum = new Map((issues || []).map(i => [i.n, i]));
  const accepted = [];
  const rejected = [];
  const edges = [];                     // [blocked, blocker] pairs accepted so far

  for (const entry of raw || []) {
    if (!entry) continue;
    const blocked = Number(entry.blocked);
    const target = byNum.get(blocked);
    const why = String(entry.why || entry.rationale || '').replace(/\r/g, '').slice(0, 600);
    const note = (reason) => rejected.push({ blocked, blockedBy: entry.blockedBy, reason });

    if (!target) { note(`no issue #${blocked}`); continue; }
    if (target.st !== 'OPEN') { note(`#${blocked} is closed`); continue; }

    const wanted = (Array.isArray(entry.blockedBy) ? entry.blockedBy : [entry.blockedBy])
      .map(Number).filter(Number.isInteger);
    const keep = [];
    for (const n of wanted) {
      const other = byNum.get(n);
      if (n === blocked) { note('an issue cannot block itself'); continue; }
      if (!other) { note(`no issue #${n}`); continue; }
      if (other.st !== 'OPEN') { note(`#${n} is closed`); continue; }
      if ((target.bk || []).includes(n)) { note(`#${blocked} already declares #${n}`); continue; }
      if (keep.includes(n)) continue;
      if (wouldCycle(issues, blocked, n, edges.concat(keep.map(k => [blocked, k])))) {
        note(`#${blocked} → #${n} would be circular`); continue;
      }
      keep.push(n);
    }
    if (!keep.length) continue;
    keep.forEach(n => edges.push([blocked, n]));
    accepted.push({ blocked, title: target.t, blockedBy: keep, why });
    if (accepted.length >= limit) break;
  }
  return { deps: accepted, rejected };
}

module.exports = {
  search, duplicates, related, dependencies, wouldCycle, normalizeDeps,
  calibrate, seriesLike, terms, lexicalScore, cosine,
};
