# Issues

[← README](../README.md)

The half of vibe-git that does not exist in other Git desktops. Issues are pulled on
demand, cached locally, and edited through a staging queue — every change you make is a
proposal until you push it.

![Issue detail with labels, body, comments and related issues](screenshots/issue.png)

## Reading

- Pull open and closed issues from GitHub on demand.
- Filter by state, milestone, label, assignee, unassigned status, issue number, or title
  text.
- **Assigned to me** is one choice in the assignee dropdown, resolved from whoever `gh` is
  signed in as rather than from a stored name, so it keeps meaning the right thing if the
  account changes. The dropdown lists only assignees the loaded issues actually use — a
  repository usually has far more collaborators than contributors.
- The label dropdown counts only labels in use, for the same reason. You can also filter by
  clicking a label on the issue you are reading.
- View state, milestone, labels, assignees, checklist progress, body, and GitHub link.
- Read the **comment thread** alongside the body, so a discussion that reversed the
  original plan is visible without leaving for github.com. Threads longer than 20 comments
  show the most recent 20 and say how many older ones remain. A comment you have staged
  appears at the end, marked as not yet pushed.
- A `◆` marks issues where somebody is plausibly waiting on you: a reply arrived after your
  last comment, or an issue assigned to you has comments you have not answered.

  Assignment alone deliberately does **not** qualify. On a solo tracker you are assigned to
  everything, so a marker that fires on assignment fires on every row and stops carrying
  information — measured on a real 55-issue tracker where it lit up all 55. It is
  reconstructed from the comments a pull kept, so it says "worth a look" and never claims to
  be unread state; GitHub's notifications inbox is not something this app can see.

## Writing

Everything here stages. Nothing reaches GitHub until you push.

- Create issues with a body, milestone, labels, and assignees.
- Stage title, milestone, label, and assignee changes.
- Stage comments, close actions, and reopen actions.
- Choose between GitHub's `completed` and `not planned` close reasons.
- Edit the milestones themselves — title, description, due date, open or closed — from the
  Plan sidebar. Clearing a due date and leaving it alone are distinct operations, because
  "no deadline" is a real answer.

The new-issue draft survives a redraw. Clicking a filter, a background refresh landing, or
a push finishing used to empty a half-written issue with no warning.

### Issue templates

If the repository defines templates, the New Issue form offers them. Both forms are read:

- **Markdown templates** with YAML front matter (`.github/ISSUE_TEMPLATE/*.md`, and the
  legacy single-file and `docs/` locations).
- **Issue forms** (`.yml`). There are no widgets here, so the form's fields become a
  markdown skeleton — a heading per question, its description as a comment, required ones
  marked. That is the same fallback GitHub itself uses when a form is filed through the
  API, and it keeps the maintainer's questions in front of whoever is writing.

A template's title prefix, labels and assignees come with it. Labels are **added** to what
you have already picked rather than replacing it, and an already-written body is never
overwritten without asking. `config.yml` configures the chooser rather than being a
template, and is correctly not offered as one.

`PULL_REQUEST_TEMPLATE.md` is prefilled into the new pull request form. Unlike issues,
almost every repository has exactly one, so it is filled in rather than offered as a
one-item chooser.

## Finding issues

The filter box is a hybrid search. Plain words match text; a phrase matches meaning, using
the embeddings already cached for classification. Searching a real 114-issue tracker for
*"player cannot tell what to do first"* returns the onboarding and playtest issues, none of
which contain any of those words. A `≈` beside a row means it was found by meaning rather
than by wording, and `#123` is treated as a lookup rather than a search.

Without an embedding model this degrades to text matching rather than disappearing.

- **Related issues** appear on every issue, ranked by similarity — the duplicate you were
  about to file, before you file it.
- **Ready** filters to open issues that are not waiting on another open issue.
- The detail pane shows what an issue is **waiting on**, what it **unblocks**, and what
  merely references it. See [dependencies](plan.md#dependencies) for how those edges are
  read.

## Working in bulk

Ctrl-click or shift-click rows to select a range, then apply a milestone, add or remove a
label, assign someone, or stage a close across the whole selection at once. Every bulk
action produces ordinary staged changes, so a bad sweep is removed from the queue rather
than undone on GitHub, and issues that already look the way you asked for are skipped
rather than restaged.

## Keyboard

| Key | Does |
|---|---|
| `Ctrl`/`Cmd` + `K` | Command palette — views, repositories, branches, assistant actions, and every issue by meaning |
| `/` | Focus the search box |
| `j` / `k` | Move down / up the issue list |
| `x` | Add or remove the current issue from the selection |
| `a` | Select every visible issue, or clear the selection if all are already selected |
| `d` / `Esc` | Clear the selection |
| `m` | Set a milestone on the selected issues |
| `l` / `Shift`+`L` | Add / remove a label on the selected issues |
| `Esc` | Close the palette |

Selection keys act on **visible** issues only, so the filter bar bounds every bulk edit.
The bulk keys open the same menus the mouse uses, and every result is staged.

## The staging queue

![Staged issue changes, each showing the gh command it will run](screenshots/staged-queue.png)

Issue edits are not sent immediately. They enter a queue that works like a Git staging
area:

- Review the exact `gh` argument list that will be executed.
- Edit a queued operation and have it revalidated.
- Reorder operations before pushing.
- Remove one operation or clear the queue.
- Keep queued work across browser and server restarts.
- Apply changes sequentially, stopping at the first failure and leaving the rest staged.

Milestone and label **creation** is applied before the issue changes that depend on them,
so a new milestone can be staged and used in the same push. A milestone **rename** is in
the same group for the mirror-image reason: issue edits name milestones by title, so a
rename applied afterwards would leave those edits pointing at a title that no longer
exists.

The Plan view carries the same **Pull issues**, **New issue** and **Push** buttons the
Issues view has, because closes and gaps are staged while reading a plan — deciding what is
finished and applying that decision should not be two different places.

## Caching and catching up

Issue data is cached locally so routine Git operations stay fast, and the cache survives a
restart. Use **Pull issues** or **Refresh** for the latest state.

Once the list is more than about ninety minutes old, the top-bar stamp shows its age
instead of the time it was pulled and turns amber. Every view rests on that list being
current, and "issues 14:32" is a fact you have to do arithmetic on to notice.

A tracker also moves whether or not you are looking at it. After a pull, the Issues and
Plan views say what changed since you last caught up — filed, closed, commented — with a
jump into the [issue timeline](git.md#history-reads-two-ways) and a button to mark it read.

Your own actions are excluded. Being told about the issue you closed two minutes ago is
noise, and noise is how a surface like this gets ignored permanently.

The first pull of a repository sets the baseline and reports nothing, which is correct:
none of it happened while you were away. It is one timestamp per repository rather than
per-issue read flags, kept outside the issue cache so a pull cannot overwrite it, and the
events are computed from timestamps the pull already stores — so nothing can drift out of
step with the issues it describes.
