'use strict';
/*
 * Deterministic plan mechanics.
 *
 * Models may make editorial choices (ordering, rationale, missing-work suggestions),
 * but live GitHub metadata owns milestone order, dates, issue membership, completion,
 * and fallback ranking. Keeping those facts here prevents a generated plan from going
 * stale or depending on a naming convention such as "Phase 2".
 */

const search = require('./search');

const DAY = 86400000;

const titleKey = (value) => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();

const TITLE_STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'is', 'are',
  'be', 'implement', 'implementation', 'add', 'create', 'configure', 'build', 'write',
  'update', 'support', 'system', 'feature', 'task',
]);

function titleTerms(value) {
  return new Set(String(value || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/).filter(Boolean).map(word => {
      if (/^docs?$/.test(word) || word === 'documentation') return 'document';
      return word.replace(/ies$/, 'y').replace(/ing$/, '').replace(/ed$/, '').replace(/es$/, '').replace(/s$/, '');
    }).filter(word => word.length > 2 && !TITLE_STOP.has(word)));
}

function likelySameTitle(a, b) {
  if (titleKey(a) === titleKey(b)) return true;
  const left = titleTerms(a); const right = titleTerms(b);
  if (!left.size || !right.size) return false;
  let common = 0;
  left.forEach(term => { if (right.has(term)) common++; });
  if (Math.min(left.size, right.size) === 1) return common === 1 && left.size === right.size;
  return common / Math.min(left.size, right.size) >= 0.66;
}

function dateOnly(value) {
  const raw = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(raw + 'T00:00:00Z');
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw ? null : raw;
}

function addDay(value) {
  const date = dateOnly(value);
  if (!date) return null;
  return new Date(new Date(date + 'T00:00:00Z').getTime() + DAY).toISOString().slice(0, 10);
}

function phaseName(title) {
  const raw = String(title || '').trim();
  return raw.replace(/^\s*Phase\s+\d+\s*(?:[—–:-]\s*)?/i, '').trim() || raw;
}

function gateFrom(milestone) {
  const description = String((milestone && milestone.description) || '').replace(/\s+/g, ' ').trim();
  if (!description) return String((milestone && milestone.title) || '');
  const first = description.match(/^.*?[.!?](?:\s|$)/);
  return (first ? first[0] : description).trim().slice(0, 160);
}

function orderMilestones(milestones) {
  return (milestones || [])
    .filter(m => m && String(m.title || '').trim())
    .map((m, index) => ({ milestone: m, index, due: dateOnly(m.dueOn) }))
    .sort((a, b) => {
      if (a.due && b.due && a.due !== b.due) return a.due.localeCompare(b.due);
      if (a.due !== b.due) return a.due ? -1 : 1;
      const an = Number.isFinite(Number(a.milestone.number)) ? Number(a.milestone.number) : a.index;
      const bn = Number.isFinite(Number(b.milestone.number)) ? Number(b.milestone.number) : b.index;
      return an - bn || a.index - b.index;
    });
}

function milestonePhases(milestones) {
  let previousDue = null;
  return orderMilestones(milestones).map(({ milestone, due }, index) => {
    const phase = {
      n: index,
      name: phaseName(milestone.title),
      title: String(milestone.title),
      milestoneNumber: Number.isFinite(Number(milestone.number)) ? Number(milestone.number) : null,
      state: milestone.state || null,
      s: due && previousDue ? addDay(previousDue) : null,
      e: due,
      dueOn: due,
      gate: gateFrom(milestone),
    };
    if (due) previousDue = due;
    return phase;
  });
}

function legacyPhaseNumber(value) {
  const match = /^\s*Phase\s+(\d+)\b/i.exec(String(value || ''));
  return match ? Number(match[1]) : null;
}

/* Hand-authored insight files can define custom phase dates and gates. Match those
 * phases to live milestones by exact title/name first; numeric Phase N is retained only
 * as a compatibility fallback for older insight files. */
function manualPhases(rawPhases, milestones) {
  const live = orderMilestones(milestones).map(x => x.milestone);
  return (rawPhases || []).map((raw, index) => {
    const candidates = [raw.title, raw.milestone, raw.name].map(titleKey).filter(Boolean);
    let match = live.find(m => candidates.includes(titleKey(m.title))) || null;
    if (!match && Number.isInteger(raw.n)) {
      match = live.find(m => legacyPhaseNumber(m.title) === raw.n) || null;
    }
    const title = String((match && match.title) || raw.title || raw.milestone || raw.name || `Milestone ${index + 1}`);
    const end = dateOnly(raw.e || raw.dueOn || (match && match.dueOn));
    return Object.assign({}, raw, {
      n: Number.isInteger(raw.n) ? raw.n : index,
      name: String(raw.name || phaseName(title)),
      title,
      milestoneNumber: match && Number.isFinite(Number(match.number)) ? Number(match.number) : null,
      state: (match && match.state) || raw.state || null,
      s: dateOnly(raw.s),
      e: end,
      dueOn: end,
      gate: String(raw.gate || gateFrom(match) || title).slice(0, 160),
    });
  });
}

function phaseForMilestone(milestoneTitle, phases) {
  const key = titleKey(milestoneTitle);
  if (!key) return null;
  const exact = (phases || []).find(p => titleKey(p.title) === key || titleKey(p.milestone) === key);
  if (exact) return exact;
  const byName = (phases || []).filter(p => titleKey(p.name) === key);
  if (byName.length === 1) return byName[0];
  const legacy = legacyPhaseNumber(milestoneTitle);
  return legacy == null ? null : (phases || []).find(p => p.n === legacy) || null;
}

/* Convert model-authored missing-work suggestions into the small, validated structure
 * rendered by the Plan view. Repository data owns milestone indices, dates and labels;
 * lexical duplicate rejection also happens here rather than trusting the prompt. */
function normalizeGeneratedGaps(rawGaps, {
  milestones = [], phases = [], issues = [], labels = [], ignoredTitles = [], limit = 5,
  maxPriority = 20, scope = null,
} = {}) {
  const bound = normalizeScope(scope);
  const allowedLabels = new Set(labels.map(label => typeof label === 'string' ? label : label.name).filter(Boolean));
  const knownTitles = issues.map(issue => issue.t).filter(Boolean)
    .concat(ignoredTitles.map(item => typeof item === 'string' ? item : item && item.title).filter(Boolean));
  const out = [];
  for (const raw of rawGaps || []) {
    if (out.length >= Math.max(0, Math.min(Number(limit) || 0, 20))) break;
    const title = String((raw && raw.title) || '')
      .replace(/^\s*[\[(][^\])]*[\])]\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 240);
    const body = String((raw && raw.body) || '').trim().slice(0, 6000);
    const why = String((raw && raw.rationale) || '').trim().slice(0, 800);
    if (!title || !body || !why || knownTitles.some(existing => likelySameTitle(title, existing))) continue;

    /* A scoped plan states where its proposals belong; the model does not get to place
       them somewhere else. Staging one produces an issue that lands in the same slice the
       plan was asked about, which is the only way the proposal is actionable. */
    const wantMilestone = (bound && bound.milestone) || raw.milestone;
    const milestone = milestones.find(item => item.title === wantMilestone) || null;
    const phase = milestone ? phaseForMilestone(milestone.title, phases) : null;
    const label = (bound && bound.label)
      || (raw.labels || []).find(item => allowedLabels.has(item)) || null;
    const priority = Math.max(0, Math.min(
      Math.round(Number(raw.priority) || 0), Math.max(0, Number(maxPriority) || 0)));
    const impact = String(raw.impact || why).trim().slice(0, 800);
    const tag = String(raw.tag || 'missing work').trim().slice(0, 40) || 'missing work';
    out.push({
      t: title,
      p: phase ? phase.n : null,
      milestone: milestone ? milestone.title : null,
      when: phase && phase.e ? `Before ${phase.e}` : (phase ? `For ${phase.name}` : 'Needs scheduling'),
      risk: raw.risk === true,
      why,
      ev: impact,
      lbl: label,
      body,
      priority,
      tag,
    });
    knownTitles.push(title);
  }
  return out;
}

function mergeRankedGaps(ranked, gaps) {
  const out = Array.isArray(ranked) ? ranked.slice() : [];
  const placed = (gaps || []).filter(gap => Number(gap.priority) > 0)
    .map((gap, index) => ({ gap, index }))
    .sort((a, b) => a.gap.priority - b.gap.priority || a.index - b.index);
  let inserted = 0;
  for (const { gap } of placed) {
    const at = Math.min(out.length, Math.max(0, Math.round(gap.priority) - 1 + inserted));
    out.splice(at, 0, {
      gap: gap.t, p: gap.p, tag: gap.tag, risk: gap.risk, why: gap.why,
    });
    inserted++;
  }
  return out;
}

/*
 * A plan may cover the whole tracker or one slice of it — a milestone, a label, or both.
 *
 * Scope has to be a first-class property of the saved plan rather than something applied
 * only while generating, because everything downstream reads it: the fallback ranking must
 * not reach outside the slice, and drift must not report "12 issues filed" when none of
 * them were in the slice the plan was ever about.
 */
function normalizeScope(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const milestone = String(raw.milestone || '').trim() || null;
  const label = String(raw.label || '').trim() || null;
  return milestone || label ? { milestone, label } : null;
}

function inScope(issue, scope) {
  if (!scope) return true;
  if (scope.milestone && titleKey(issue.ms) !== titleKey(scope.milestone)) return false;
  if (scope.label && !(issue.l || []).includes(scope.label)) return false;
  return true;
}

function scopeText(scope) {
  if (!scope) return '';
  return [scope.milestone, scope.label && 'labelled ' + scope.label].filter(Boolean).join(' · ');
}

function assignIssuePhases(issues, phases) {
  return (issues || []).map(issue => {
    const phase = phaseForMilestone(issue.ms, phases);
    return Object.assign({}, issue, { p: phase ? phase.n : null });
  });
}

function milestoneMap(milestones) {
  return new Map((milestones || []).map(m => [titleKey(m.title), m]));
}

function prioritizeIssues(issues, milestones, phases) {
  const byMilestone = milestoneMap(milestones);
  const phaseOrder = new Map((phases || milestonePhases(milestones)).map((p, index) => [titleKey(p.title), index]));
  return (issues || []).filter(i => i.st === 'OPEN').slice().sort((a, b) => {
    const aProgress = a.bx && a.bx[1] && a.bx[0] > 0 && a.bx[0] < a.bx[1] ? 1 : 0;
    const bProgress = b.bx && b.bx[1] && b.bx[0] > 0 && b.bx[0] < b.bx[1] ? 1 : 0;
    if (aProgress !== bProgress) return bProgress - aProgress;

    const ad = dateOnly((byMilestone.get(titleKey(a.ms)) || {}).dueOn);
    const bd = dateOnly((byMilestone.get(titleKey(b.ms)) || {}).dueOn);
    if (ad && bd && ad !== bd) return ad.localeCompare(bd);
    if (ad !== bd) return ad ? -1 : 1;

    const ar = Array.isArray(a.bl) ? a.bl.length : 0;
    const br = Array.isArray(b.bl) ? b.bl.length : 0;
    if (ar !== br) return br - ar;

    const ap = phaseOrder.has(titleKey(a.ms)) ? phaseOrder.get(titleKey(a.ms)) : Number.MAX_SAFE_INTEGER;
    const bp = phaseOrder.has(titleKey(b.ms)) ? phaseOrder.get(titleKey(b.ms)) : Number.MAX_SAFE_INTEGER;
    return ap - bp || Number(a.n) - Number(b.n);
  });
}

function fallbackEntry(issue, milestones, phases) {
  const milestone = milestoneMap(milestones).get(titleKey(issue.ms));
  const due = dateOnly(milestone && milestone.dueOn);
  const refs = Array.isArray(issue.bl) ? issue.bl.length : 0;
  const progress = issue.bx && issue.bx[1] ? issue.bx : [0, 0];
  const phase = phaseForMilestone(issue.ms, phases);
  if (progress[0] > 0 && progress[0] < progress[1]) {
    return { ns: [issue.n], tag: 'in progress', why: `${progress[0]} of ${progress[1]} checklist items are complete, making this the closest unfinished item to completion.` };
  }
  if (due) {
    return { ns: [issue.n], tag: 'due first', why: `Its milestone is due ${due}, so the live deadline moves it ahead of undated work.` };
  }
  if (refs) {
    return { ns: [issue.n], tag: 'coordination', why: `${refs} open issue${refs === 1 ? '' : 's'} reference this work, so it is elevated as a likely coordination point.` };
  }
  if (phase) {
    return { ns: [issue.n], tag: 'milestone order', why: `It belongs to “${phase.title}”; its position follows the repository's current milestone order.` };
  }
  return { ns: [issue.n], tag: 'backlog order', why: 'It is the next unranked open issue in deterministic backlog order.' };
}

/* Preserve valid editorial ordering, then programmatically fill omissions. This keeps a
 * weak or truncated model response useful and guarantees every entry references a live
 * issue at most once. */
function completeRanking(editorial, orderedIssues, milestones, phases, count, liveIssues = orderedIssues) {
  const live = new Map((liveIssues || []).map(i => [i.n, i]));
  const used = new Set();
  const out = [];
  for (const item of editorial || []) {
    if (item && item.gap) { out.push(item); continue; }
    const ns = (item && Array.isArray(item.ns) ? item.ns : [])
      .filter(n => live.has(n) && !used.has(n));
    if (!ns.length) continue;
    ns.forEach(n => used.add(n));
    out.push(Object.assign({}, item, { ns }));
  }
  const target = Math.max(0, Math.min(Number(count) || 10, 50));
  for (const issue of orderedIssues || []) {
    if (out.length >= target || used.has(issue.n)) continue;
    used.add(issue.n);
    out.push(fallbackEntry(issue, milestones, phases));
  }
  return out.slice(0, target || out.length);
}

function latestDue(milestones) {
  const dates = (milestones || []).map(m => dateOnly(m.dueOn)).filter(Boolean).sort();
  return dates.length ? dates[dates.length - 1] : null;
}

function hydrateGaps(rawGaps, phases, generated) {
  return (Array.isArray(rawGaps) ? rawGaps : [])
    .filter(gap => gap && typeof gap === 'object')
    .map(gap => {
      const milestoneTitle = gap.milestone || gap.ms || null;
      const phase = milestoneTitle ? phaseForMilestone(milestoneTitle, phases) : null;
      if (!generated) return phase
        ? Object.assign({}, gap, { p: phase.n, milestone: phase.title })
        : gap;
      return Object.assign({}, gap, {
        p: phase ? phase.n : null,
        milestone: phase ? phase.title : milestoneTitle,
        when: phase && phase.e ? `Before ${phase.e}` : (phase ? `For ${phase.name}` : 'Needs scheduling'),
      });
    });
}

function hydratePlan(raw, milestones, issues) {
  if (!raw || typeof raw !== 'object') return null;
  const generated = !!raw.generated || !!raw.programmatic;
  const phases = generated || !Array.isArray(raw.phases) || !raw.phases.length
    ? milestonePhases(milestones)
    : manualPhases(raw.phases, milestones);
  const phasedIssues = assignIssuePhases(issues, phases);
  const scope = normalizeScope(raw.scope);
  // The fallback fill may only reach for issues the plan was asked to be about. Lookup
  // still spans every issue, so an entry whose issue has since moved out of scope or been
  // closed still renders instead of vanishing.
  const ordered = prioritizeIssues(phasedIssues.filter(i => inScope(i, scope)), milestones, phases);
  const gaps = hydrateGaps(raw.gaps, phases, generated);
  const requested = Number(raw.requestedCount) || (raw.ranked || []).length || Math.min(10, ordered.length);
  const rankedRaw = generated
    ? completeRanking(raw.ranked, ordered, milestones, phases, requested, phasedIssues)
    : completeRanking(raw.ranked, ordered, milestones, phases, (raw.ranked || []).length, phasedIssues);
  const gapsByTitle = new Map(gaps.map(gap => [titleKey(gap.t), gap]));
  const ranked = rankedRaw.map(item => {
    if (!item.gap || !gapsByTitle.has(titleKey(item.gap))) return item;
    const gap = gapsByTitle.get(titleKey(item.gap));
    return Object.assign({}, item, { p: gap.p, risk: gap.risk, tag: gap.tag || item.tag });
  });
  // Legacy generated plans carried an implicit project-specific capacity default. It
  // was not user evidence, so only reviewed plans or schema-v2 generated plans may
  // supply capacity explicitly.
  const hours = (!generated || Number(raw.schemaVersion) >= 2) ? Number(raw.hoursPerWeek) : NaN;
  return Object.assign({}, raw, {
    beta: dateOnly(raw.beta) || latestDue(milestones),
    hoursPerWeek: Number.isFinite(hours) && hours > 0 ? hours : null,
    phases,
    scope,
    scopeText: scopeText(scope),
    // How much of the tracker this plan is answerable for — the Plan view's counts are
    // otherwise read as covering everything.
    scopeOpen: ordered.length,
    baselineNums: Array.isArray(raw.baselineNums) ? raw.baselineNums.filter(Number.isInteger) : [],
    ranked,
    gaps,
    /*
     * Dependency proposals are re-validated on every read, not just when they were made.
     * A plan generated last week can propose an edge whose blocker has since been closed, or
     * one somebody has already written into the body by hand — both should stop being offered
     * rather than sit there as a card that fails when staged.
     */
    deps: search.normalizeDeps(raw.deps, { issues }).deps,
  });
}

/*
 * Has the tracker moved on since this plan was generated?
 *
 * A plan is an editorial snapshot of the issues that existed when it was made. File three
 * issues and close two and it is quietly out of date while still looking authoritative, so
 * the numbers it was built from are recorded and drift is a comparison rather than a guess.
 */
function planDrift(plan, issues) {
  if (!plan) return { hasPlan: false, stale: false, added: [], closed: [], capturedAt: null, scope: null };
  const scope = normalizeScope(plan.scope);
  const baseline = new Set((plan.baselineNums || []).filter(Number.isInteger));
  // Plans written before baselineOpen existed still ranked only open issues, so their
  // ranking is a faithful stand-in for what they considered outstanding.
  const rankedNums = [];
  for (const entry of plan.ranked || []) {
    for (const n of (entry && entry.ns) || []) if (Number.isInteger(n)) rankedNums.push(n);
  }
  const wasOpen = new Set(Array.isArray(plan.baselineOpen) && plan.baselineOpen.length
    ? plan.baselineOpen.filter(Number.isInteger)
    : rankedNums);
  const added = [], closed = [];
  for (const issue of issues || []) {
    // An issue filed outside the slice this plan covers is not drift for this plan. A
    // milestone-scoped plan that announced itself stale every time an unrelated issue
    // appeared would be telling the truth about the tracker and a lie about itself.
    if (issue.st === 'OPEN' && baseline.size && !baseline.has(issue.n) && inScope(issue, scope)) added.push(issue.n);
    if (issue.st !== 'OPEN' && wasOpen.has(issue.n)) closed.push(issue.n);
  }
  added.sort((a, b) => a - b);
  closed.sort((a, b) => a - b);
  return {
    hasPlan: true,
    capturedAt: plan.capturedAt || null,
    scope,
    scopeText: scopeText(scope),
    added,
    closed,
    stale: added.length > 0 || closed.length > 0,
  };
}

function programmaticPlan(repo, milestones, issues, count = 10) {
  const raw = {
    schemaVersion: 2,
    repo,
    source: 'live milestones and issue metadata',
    capturedAt: new Date().toISOString().slice(0, 10),
    programmatic: true,
    requestedCount: count,
    ranked: [],
    gaps: [],
  };
  return hydratePlan(raw, milestones, issues);
}

module.exports = {
  titleKey, titleTerms, likelySameTitle, dateOnly, orderMilestones, milestonePhases, manualPhases,
  phaseForMilestone, assignIssuePhases, prioritizeIssues, completeRanking,
  normalizeScope, inScope, scopeText,
  normalizeGeneratedGaps, mergeRankedGaps, hydrateGaps, hydratePlan, programmaticPlan,
  planDrift,
};
