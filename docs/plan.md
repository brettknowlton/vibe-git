# The plan

[← README](../README.md)

An answer to "what should I work on next" that shows its reasoning. The ordering,
milestone bands, dates and completion state are computed from live GitHub data; only the
rationale and the missing-work proposals come from a model, and both are optional.

![Plan view with a milestone timeline, dependency graph and ranked issues](screenshots/plan.png)

## What it shows

- Milestones as a timeline with due dates, descriptions, and open-issue counts.
- The tracker's dependency structure as a layered graph — blockers above what they block —
  under **What is blocked**, above the ranking it constrains.
- A ranked list of recommended work, each entry explaining why it goes *there* in the order.
- Work the project implies but no issue covers, as reviewable issue drafts.
- Proposed dependencies, as staged body edits.

Milestones and issues are joined by their exact title; names do not need a `Phase N`
prefix. Undated milestones stay undated rather than receiving an invented schedule.

The view works programmatically as soon as a repository has milestones. **Generate plan +
insights** asks the assistant for the parts that need judgment. Both extras are separate
switches — **suggest missing issues** and **find dependencies** — so a plan can be an
ordering of the work that exists and nothing else.

The dropdown beside the button sets how many entries the plan holds, from 10 to 50, next to
a count of how many issues are in scope. Only open issues are ranked; closed ones are shown
to the model by title alone, so finished work is recognised without spending the prompt
budget the open issues need. On a tracker with dozens of open issues, a longer plan is what
lets the recommendation reach past the first milestone.

## Hiding part of a plan

Between "stage this change" and "do nothing" there is a large, ordinary range of responses
to a ranking, and it used to be empty. **Hide** on any recommendation fills it: the entry
folds away, the rest renumber, and **nothing is staged** — no queue entry, no GitHub call,
no edit to any issue.

Hiding is not ignoring. Ignoring a proposed issue is a verdict: this is not work, stop
suggesting it. Hiding is "not now", or "not third", and it is reversible from **Show
hidden** at any time. Use it for the item that is real but belongs next month, and for the
one the model simply put in the wrong place.

Entries are keyed by their issue numbers, so a mute survives regeneration — an issue you
pushed down stays down when a new plan ranks it somewhere else. Generation is also *told*
what you hid and asked to rank it below everything you did not, which is the only feedback
this app collects about the order rather than about the work.

Completed milestones leave the header for the same reason. A milestone counts as complete
when GitHub says it is closed, **or** when it holds issues and none are still open — the
second because closing the milestone itself is a chore people skip for months, and a header
that opens on a finished phase reports a due date in the past and a countdown of zero. A
milestone with no issues is *empty*, not finished, and stays. **Show completed** puts them
back.

## Dependencies

Dependencies are read out of issue **bodies**: `blocked by #12`, `depends on #4`, `requires
#7`, `waiting on #3`, and — only when a `#number` follows closely — `after #9`. `blocks
#12` is the opposite claim and is deliberately not counted as a dependency of the issue
declaring it.

Those edges drive three things: the layered graph here, the **Ready** filter in the issue
list, and the `⛔` marker on blocked rows. A tracker where nothing declares a dependency has
no graph to draw, and the view says so rather than showing an empty panel.

Because an edge is prose rather than a field, the assistant can propose one — and does,
from three places: while generating a plan, while re-checking all open issues, and on
request in chat. Accepting one stages an ordinary body edit adding a `Blocked by: #N` line,
so the relationship still reads correctly to anyone looking at the issue on github.com.

### A closed issue blocks nothing

Every proposed edge is checked against the live tracker when it is made, again when a saved
plan is read back, and once more in the browser before it can be staged — because the copy
on the page outlives the pull that closed its blocker. An edge whose blocker has since been
closed stops being offered and says why, rather than sitting there as a card that would
record a constraint which stopped applying.

This is not hypothetical. Issue bodies are written once and reference work that ships
months later, so a body reading *"needs the chest art #102"* still says so long after #102
is done — and that is exactly where a model reaches when asked for dependencies. So the
prompts state that only a number **heading an entry** in the open-issue list is a
candidate, closed issues are listed to the model without their numbers at all, and each run
reports how many proposals were discarded for naming finished work.

That last part matters more than it sounds: a run that proposed six edges and kept two used
to look identical to a run that found two.

### Refusing an edge

Edges are refused automatically when they would be circular, point at a closed issue, or
duplicate one already written down.

You can also refuse one yourself. A model reading two issues about the same subsystem will
sometimes declare an ordering constraint that does not exist, and the only previous way to
stop being shown it was to stage a body edit asserting something untrue. **Refuse** rejects
it instead: nothing is staged, the edge is struck through rather than deleted, and it will
not be proposed again — not by plan generation, not by **Re-check all open**, and not by
chat, all three of which read the same refusal list.

Refusal is per **edge**, so a card proposing three blockers that is right about two keeps
those two; with more than one live blocker each chip carries its own ✕. **Show refused**
lists what you turned down and takes any of it back.

## Scoping a plan

A plan can cover the whole tracker or one slice — a milestone, a label, or both. On a
shared tracker this is how two people each get a plan about their own work instead of one
plan that is mostly about someone else's.

Scope is a property of the saved plan, not just of the request that made it, so everything
downstream respects it: the ranking never reaches outside the slice, proposed missing work
is placed inside it, and staleness counts only issues that were in it. A milestone-scoped
plan does not announce itself out of date because an unrelated issue was filed elsewhere.

**Update current plan** keeps the scope the plan was built with; **Generate new** adopts
whatever the dropdowns currently say. The view names the slice it is answering for, because
a scoped ranking is complete for that slice and silent about everything else.

## Keeping a plan current

A plan ranks the issues that existed when it was generated, so filing or closing issues
makes it quietly out of date. vibe-git records the issue numbers a plan was built from and
compares them against the tracker on every state load. When they diverge:

- A marker appears beside the plan button in the assistant, and on the Plan tab's counter.
- The view explains what changed — how many issues were filed, and how many closed.
- Regenerating offers a choice rather than silently replacing what you have read: **Update
  current plan** revises it, keeping entries that are still correct and placing what
  changed; **Generate new** starts over; **Cancel** leaves it alone.

An update sends the existing plan to the model along with the list of what changed, and is
told to change the least that makes the plan true again.

## Where plans are stored

The generated editorial plan is saved automatically under `~/.config/vibe-git/plans/`; you
never write its JSON by hand. When a repository also has a reviewed plan checked in under
`insights/`, whichever was captured more recently is displayed.

**Insight files are gitignored by default**, because a plan can contain private schedules,
unreleased dates, and details of repositories other than the one you are publishing. To
publish a reviewed example as `insights/<owner>__<repository>.json` you must add your own
negation to `.gitignore`; the entry in this repository only unignores this project's own
example.

That example lives at
[`insights/brettknowlton__vibe-git.json`](../insights/brettknowlton__vibe-git.json) and
stores only editorial choices: recommended order, short tags, and rationale. Milestone
bands, dates, and completion state are filled in from live GitHub metadata.
