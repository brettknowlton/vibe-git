# vibe-git

vibe-git is a lightweight, local Git and GitHub desktop interface built around both
code changes and issues. It runs in a browser on your computer and uses the `git` and
`gh` commands you already have installed.

The project has no third-party runtime dependencies. Issue changes use a reviewable
staging queue, and an optional local-model assistant can help organize project work
without writing directly to GitHub.

vibe-git works with GitHub only. It drives the official `gh` CLI, so GitLab, Bitbucket,
and other self-hosted forges are not supported. GitHub Enterprise Server is untested.

## Quick start

Requires Node.js 18+, Git 2.23+, and [GitHub CLI](https://cli.github.com/) 2.54+
authenticated with the `repo` scope (add `read:org` if you assign issues to organization
members). Check your scopes with `gh auth status`.

```bash
git clone https://github.com/brettknowlton/vibe-git.git
cd vibe-git
node server.js --dry-run
```

Open <http://127.0.0.1:11001/>. Dry-run performs real reads but only logs writes, so you
can click through everything safely. Restart without `--dry-run` when you are ready.

Then open the repository menu in the top-left, add or clone a repository, select it, and
press **Pull issues**. Repositories without a GitHub remote can still use local Git
features.

![Repository selector with add, clone, and remove controls](docs/screenshots/repositories.png)

There is no install or build step; `npm start`, `npm run dry-run`, and `npm test` are
aliases for the same commands.

## Screenshots

Issues are pulled on demand and filtered by state, milestone, label, assignment, or text.
Every edit in the detail pane stages rather than writing to GitHub.

![Issues view with the detail pane open](docs/screenshots/issues.png)

Issue edits collect in a staging queue showing the exact `gh` command each one will run.
Nothing reaches GitHub until you press **Push**.

![Staged issue changes, each showing the gh command it will run](docs/screenshots/staged-queue.png)

The Plan view ranks open issues, explains each ranking, and flags work the project
implies but no issue covers.

![Plan view with ranked issues and missing-work proposals](docs/screenshots/plan.png)

Changes shows the working tree with per-file selection and a real diff.

![Changes view with a file list and diff](docs/screenshots/changes.png)

The optional Assistant proposes classifications and missing issues as reviewable
suggestions, never as direct writes.

![Assistant panel proposing new issues](docs/screenshots/assistant.png)

## Features

### Repository management

- Keep an explicit list of repositories instead of scanning the filesystem on every
  launch.
- Add one repository or add a directory of repositories with a one-time scan.
- Clone from a GitHub URL or `owner/repository` shorthand.
- Switch between recently used repositories from the top bar.
- Remove a repository from the app without deleting anything from disk.

### Working tree and commits

- View every changed, added, deleted, renamed, untracked, or conflicted file.
- Open a full diff for a selected file.
- Select individual files or all changed files for a commit.
- Create commits with a summary and optional description.
- Draft an editable commit subject and description from selected changes when the
  Assistant is available.
- Discard selected changes behind a confirmation step.
- Amend the most recent commit message.
- Undo the most recent commit with a soft reset, preserving its changes.
- Stash changes, and pop or drop any individual stash by name — listed in **Changes**
  whether the working tree is dirty or clean, since a clean tree is exactly when a stash
  is the only thing left to restore.
- Inspect conflict counts after merges.
- Browse recent commit history with commit metadata, file statistics, and full patches.

File staging is currently whole-file only; per-hunk and per-line staging are not yet
available.

### Branches and synchronization

- See the current branch, upstream, recent local branches, and remote-only branches.
- Create branches, switch branches, and create local copies of remote branches.
- Refuse unsafe branch switching when tracked changes are present.
- Merge another local branch into the current branch.
- Delete branches with confirmation.
- Display ahead and behind counts in the top bar.
- Fetch all remotes and prune deleted remote references.
- Pull with `--ff-only`, preventing an automatic history rewrite.
- Push the current branch and set its upstream automatically when needed.

### Issues

- Pull open and closed issues from GitHub on demand.
- Filter by state, milestone, label, unassigned status, issue number, or title text.
- Filter to one label from the dropdown, which counts only labels the loaded issues
  actually use, or by clicking a label on the issue you are reading.
- View issue state, milestone, labels, assignees, checklist progress, body, and GitHub
  link.
- Create issues with a body, milestone, labels, and assignees.
- Stage title, milestone, label, and assignee changes.
- Stage comments, close actions, and reopen actions.
- Choose between GitHub's `completed` and `not planned` close reasons.

Issue data is cached locally so routine Git operations remain fast, and the cache
persists across restarts. Use **Pull issues** or **Refresh** when you want the latest
GitHub state.

### Finding issues

The filter box is a hybrid search. Plain words match text; a phrase matches meaning, using
the embeddings that are already cached for classification. Searching a real 114-issue
tracker for *"player cannot tell what to do first"* returns the onboarding and playtest
issues, none of which contain any of those words. A `≈` beside a row means it was found by
meaning rather than by wording, and `#123` is treated as a lookup rather than a search.

Without an embedding model this degrades to text matching rather than disappearing.

- **Related issues** appear on every issue, ranked by similarity — the duplicate you were
  about to file, before you file it.
- **Ready** filters to open issues that are not waiting on another open issue. Bodies
  saying "blocked by #12", "depends on #7 and #9" or "after #4 is done" build the
  dependency structure; "blocks #33" is the opposite claim and is deliberately not counted.
- The issue detail shows what an issue is **waiting on**, what it **unblocks**, and what
  merely references it.

### Working in bulk

Ctrl-click or shift-click rows to select a range, then apply a milestone, add or remove a
label, assign someone, or stage a close across the whole selection at once. Every bulk
action produces ordinary staged changes, so a bad sweep is removed from the queue rather
than undone on GitHub, and issues that already look the way you asked for are skipped
rather than restaged.

### Keyboard

| Key | Does |
|---|---|
| `Ctrl`/`Cmd` + `K` | Command palette — views, repositories, branches, assistant actions, and every issue by meaning |
| `/` | Focus the search box |
| `j` / `k` | Move down / up the issue list |
| `x` | Add or remove the current issue from the selection |
| `Esc` | Close the palette, or clear the selection |

### Staged GitHub changes

GitHub issue edits are not sent immediately. They first enter a queue that works like a
staging area:

- Review the exact `gh` argument list that will be executed.
- Edit a queued operation and have it revalidated.
- Reorder operations before pushing.
- Remove one operation or clear the queue.
- Keep queued work across browser and server restarts.
- Apply changes sequentially and stop at the first failure, leaving the remainder
  staged for review.

Milestone and label creation are applied before the issue changes that depend on them, so
a new milestone or label can be staged and used in the same push.

### Pull requests

- List open, merged, closed, or all pull requests.
- View the pull request body, author, branches, review state, mergeability, commits,
  changed-file count, additions, deletions, and diff.
- Open a pull request from the current branch, from **Changes**, from **Pull requests**,
  or from the command palette.
- Edit the description of an existing pull request.
- Choose the base branch — local branches and branches that exist only on the remote —
  defaulting to the repository's own default branch rather than a guess at its name.
- Create a draft pull request.
- Detect an existing pull request for the current branch.
- Publish an unpushed branch from the pull request form, which a pull request needs
  before it can be opened.

Unlike issue edits, pull request writes are not staged. Creating a pull request and
saving a description both apply immediately, each behind a two-stage confirm, because
they act on a single artifact rather than a batch of related metadata changes.

### Plan view

The Plan view combines repository metadata, deterministic prioritization, and optional
editorial guidance:

- Display milestones as a timeline with due dates, descriptions, and open-issue counts.
- Rank recommended work and explain why each item is prioritized.
- Filter the full view to one milestone.
- Hide completed recommendations by default, with a **Show hidden** toggle.
- Open real issues directly in the standard issue editor.
- Identify work described by a plan but not represented by an issue.
- Stage a new issue from a missing-work proposal.
- Ignore, restore, or permanently delete proposals that should not become issues.
- Notice when the tracker has moved on since the plan was generated.

Milestones and issues are joined by their exact milestone title; names do not need a
`Phase N` prefix. Milestone order, due dates, issue membership, checklist progress,
open or closed state, and fallback ranking are computed from live GitHub data. Undated
milestones remain undated instead of receiving an invented schedule.

The Plan view works programmatically whenever a repository has milestones. Choosing
**Generate plan + insights** asks the Assistant for the parts that require judgment:
recommended ordering, rationale, risks, and concrete work implied by the project but
missing from its issue tracker. Proposed gaps include a reviewable issue body and can be
staged directly from the Plan view.

The dropdown beside the button sets how many entries the plan should hold, from 10 up to
50, next to a count of how many issues are actually in scope. Only open issues are ranked;
closed ones are shown to the model by title alone, so that finished work is recognized
without spending the prompt that the open issues need. On a tracker with dozens of open
issues, a longer plan is what lets the recommendation reach past the first milestone.

#### Scoping a plan

A plan can cover the whole tracker or one slice of it — a milestone, a label, or both.
On a shared tracker this is how two people each get a plan about their own work instead
of one plan that is mostly about someone else's.

Scope is a property of the saved plan, not just of the request that made it, so
everything downstream respects it: the ranking never reaches outside the slice, proposed
missing work is placed inside it, and staleness counts only issues that were in it.
A milestone-scoped plan does not announce itself out of date because an unrelated issue
was filed elsewhere.

**Update current plan** keeps the scope the plan was built with; **Generate new** adopts
whatever the dropdowns currently say. The Plan view names the slice it is answering for,
because a scoped ranking is complete for that slice and silent about everything else.

The generated editorial plan is saved automatically under `~/.config/vibe-git/plans/`;
you do not need to create or maintain its JSON schema. When a repository also has a
reviewed plan checked in under `insights/`, whichever was captured more recently is the
one displayed.

#### Keeping a plan current

A plan ranks the issues that existed when it was generated, so filing or closing issues
makes it quietly out of date. vibe-git records the issue numbers a plan was built from and
compares them against the tracker on every state load. When they diverge:

- A marker appears beside the plan button in the Assistant, and on the Plan tab's counter.
- The Plan view explains what changed — how many issues were filed, and how many closed.
- Asking to regenerate offers a choice rather than silently replacing what you have read:
  **Update current plan** revises it, keeping entries that are still correct and placing
  what changed; **Generate new** starts over; **Cancel** leaves it alone.

An update sends the existing plan to the model along with the list of what changed, and is
told to change the least that makes the plan true again.

**Insight files are gitignored by default**, because a plan can contain private
schedules, unreleased dates, and repository details — including for repositories other
than the one you are publishing. To publish a reviewed example as
`insights/<owner>__<repository>.json`, you must add your own negation to `.gitignore`;
the entry in this repository only unignores this project's own example. A locally
generated plan always takes precedence over a checked-in one.

That example lives at
[`insights/brettknowlton__vibe-git.json`](insights/brettknowlton__vibe-git.json) and
stores only editorial choices: recommended order, short tags, and rationale. Milestone
bands, dates, and completion state are filled in from live GitHub metadata.

### Optional local-model Assistant

The Assistant works with an Ollama-compatible HTTP endpoint and is disabled until it is
configured. It can:

- Classify unorganized issues by milestone and label, using existing milestone
  descriptions as the deciding evidence.
- Nominate a new milestone or label when nothing existing fits, or when it notices a
  recurring theme the current labels cannot express.
- Re-check all open issues, including issues that already have milestones.
- Suggest milestones for work that does not fit the current structure.
- Suggest missing issues using the tracker and an available planning document.
- Generate or update the Plan view's editorial ordering, explanations, risks, and
  missing-work issue drafts in one action.
- Answer questions about the repository in a chat panel, looking things up as it goes.
- Summarize selected working-tree changes into an editable commit-message draft.
- Use an optional embedding model to retrieve similar issues as classification
  precedents.
- Sweep the whole tracker for near-duplicate issues, with no model inference at all.
- Remember ignored suggestions so they are not repeatedly proposed.
- Unload selected models when they are no longer needed.

#### Duplicate detection

**Find duplicates** compares every issue against every other using the cached embeddings.
There is no model call, so it finishes in milliseconds and can be run as often as you like.

Two things make it trustworthy rather than noisy:

- **Thresholds are calibrated to your repository, not asserted.** On a real tracker the
  pairwise similarities ran 0.26–0.84 with a median of 0.49, so a "0.9 means duplicate" rule
  could never have fired and a "0.55 means related" rule would have matched half the issues.
  The bar is derived from the distribution each repository actually produces, and the panel
  tells you what that distribution was.
- **A series is not a pile of duplicates.** "Art: Inventory Tab — Grimoire" and "Art:
  Inventory Tab — Quests" score higher than genuine duplicates do, because they are parallel
  tasks in one series. Pairs with a shared leading phrase and a distinguishing word on each
  side are discounted, and a group that still surfaces is flagged as one.

Grouping uses complete linkage: every member must resemble every other member. Single
linkage chains "A is like B, B is like C" into groups that share only a topic.

The action offered is conservative — stage a close on the newer issues with a comment
pointing at the oldest, which keeps the discussion in one place and is reversible from the
staged queue right up until you push.

Every action is cancellable. **Cancel** stops the batch and drops the sockets of requests
already in flight, which matters when a large model is minutes into work you no longer
want. Because nothing an Assistant action produces is written anywhere, cancelling can
only ever abandon a proposal.

The generated plan is local editorial data. The Assistant never writes to GitHub
directly: classifications, nominated categories, chat proposals, and missing-work issue
drafts must still be reviewed, staged, and pushed through the same queue as manual issue
changes. Commit summaries only fill the existing commit form; they never stage files or
create a commit.

#### Chat

The **Chat** tab is the open-ended half of the Assistant. It answers with tools rather than
recall, and can:

- Read issues, one issue in full, milestones, labels, the plan, recent commits, and the
  state of the working tree.
- Search for issues resembling a description, semantically when an embedding model is
  configured and by word overlap otherwise.
- Propose an issue, an issue edit, a milestone, or a label — each of which becomes a card
  you stage and push like any other change.

The tools are read-only apart from the `propose_*` family, and those only produce a payload
for the staged-change queue, which revalidates everything against the repository. There is
no tool that runs a command or calls the GitHub API.

The conversation lives in the browser tab, not on the server: switching repository or
pressing **Clear** ends it. Because the model reads issue text that other people can write,
it is told that titles, bodies, and commit messages are data rather than instructions, and
everything it says is inserted into the page as text, never as markup.

When available, planning context is read from common project files such as `PLAN.md`,
`ROADMAP.md`, `TODO.md`, and their `docs/` variants. `README.md` is used as a fallback
when no dedicated planning document exists.

## Configuration

vibe-git uses the account that `gh` is already authenticated as and stores no GitHub
credentials of its own. On a shared machine it therefore acts as whoever is signed in.

The Assistant additionally requires an Ollama-compatible model server, and is disabled
until configured.

Removing a repository from the app removes only its entry; the folder and its files stay
on disk and it can be added again later.

### Command-line options

| Option | Description |
|---|---|
| `--dry-run` | Allow reads and log writes without executing them |
| `--port N` | Use a loopback port other than `11001` |
| `--repo PATH` | Select a repository at startup |
| `--scan DIR` | Add a repository path to the initial repository list |
| `--tailscale` | Allow tailnet access through `tailscale serve`, for this node's owner |
| `--allow-user LOGIN` | Admit a specific tailnet login remotely (repeatable) |
| `--allow-host NAME` | Serve an additional `Host` value (repeatable) |

The `VIBE_GIT_PORT` environment variable can also set the default port.

## Typical workflow

1. Select a repository and branch.
2. Review files in **Changes**, select the intended files, and commit them.
3. Pull issues and use the filters to find the relevant work.
4. Open an issue and stage any desired metadata, comment, or state changes.
5. Review, edit, and reorder those operations in **Staged**.
6. Push the queue to GitHub.
7. Fetch, pull, or push Git commits from the synchronization menu.
8. Open or review a pull request from **Pull requests**.

## Assistant setup

1. Open **Assistant** from the top bar.
2. Select **Settings**.
3. Enable Assistant features.
4. Enter the Ollama-compatible endpoint.
5. Select a chat model and, optionally, an embedding model.
6. Adjust concurrency or other model settings if required.
7. Return to **Run** and choose an action.

![Assistant settings with endpoint, model, and account state](docs/screenshots/assistant-settings.png)

Only configure an endpoint you trust. Issue bodies, planning documents, and explicitly
selected file diffs may be sent to that endpoint when Assistant actions run.

## Local data and privacy

Application data is stored under:

```text
~/.config/vibe-git/
```

This includes the repository list, settings, staged issue queue, generated plans,
ignored suggestions, the embedding cache, and a local copy of each repository's issues
and milestones. Newly created configuration files use owner-only permissions.

The issue copy is what the Issues, Plan and Assistant views read, so opening vibe-git
again does not wait on `gh`; **Pull** refreshes it. It contains issue titles and bodies,
including those of private repositories, in plain JSON under your home directory.

This path is used on every platform and does not follow `XDG_CONFIG_HOME`, macOS
`Application Support`, or Windows `AppData` conventions. vibe-git is developed and
tested on Linux; it should run anywhere Node.js, Git, and `gh` do, but other platforms
are not regularly verified.

vibe-git has no telemetry. Depending on the action, it communicates only with:

- Git remotes configured in the selected repository;
- GitHub through the authenticated `gh` command; and
- the Assistant endpoint configured in settings.

## Reaching it from another device (Tailscale)

vibe-git binds to `127.0.0.1` and always will. `--tailscale` does not change the bind
address — it lets `tailscale serve` proxy in from loopback, and adds an identity check on
top:

```bash
node server.js --tailscale
tailscale serve --bg 11001        # publishes https://<your-node>.ts.net/ to your tailnet
```

The server prints the URL, the accounts it will admit, and the accounts it will refuse.

**A tailnet is not an authentication boundary.** Tailnets routinely contain other people's
laptops and phones, and this app runs `git` and `gh` as you. So membership is not enough:

- Requests must arrive from a loopback peer, meaning through the local `tailscale serve`
  proxy. A remote client that connects directly and claims an identity is refused.
- Requests must carry `Tailscale-User-Login`, which tailscaled attaches for the
  authenticated tailnet user and strips if a client tries to send its own.
- That login must be on an allowlist, which defaults to the account that owns this machine.

Funnel — Tailscale's public-internet mode — carries no identity, so its requests fail the
same check. The server also refuses to start if Funnel is already enabled.

| Option | Description |
|---|---|
| `--tailscale` | Detect this node's name and owner, and admit that owner remotely |
| `--allow-user <login>` | Admit this tailnet login instead of the detected owner (repeatable) |
| `--allow-host <name>` | Serve an additional Host value (repeatable) |

A remote session is labelled in the top bar with the account it authenticated as, because a
window opened from a phone can push to GitHub exactly like the one on your desk.

Without `--tailscale` nothing but loopback is served, exactly as before.

## Security model

vibe-git can modify repositories and GitHub data, so it is intended for one trusted
user on a local computer.

- The server binds to `127.0.0.1` only, including with `--tailscale`.
- Page and API requests validate `Host` and `Origin` values.
- Remote access requires a loopback-proxied request carrying an allowlisted Tailscale
  identity; tailnet membership alone grants nothing.
- Every API request requires a random token generated at startup.
- The startup token is injected under a Content Security Policy nonce.
- External processes use `execFile` with argument arrays and `shell: false`.
- There is no endpoint that accepts an arbitrary command string.
- Branches, issue numbers, labels, milestones, assignees, and changed-file paths are
  validated before use.
- Untrusted repository and model text is rendered without executable HTML.
- Assistant tools are read-only; the only tools with an effect produce staged proposals,
  which are revalidated against the repository before they can be pushed.
- Repository text quoted to a model is identified as data, so instructions written into an
  issue body are not treated as instructions to the Assistant.
- Destructive actions use confirmation steps, and GitHub issue writes use the staging
  queue.
- Pull is fast-forward only.

Do not expose the server to a network or use it as a hosted multi-user service without
adding a separate authentication and authorization layer.

## Troubleshooting

### GitHub features are unavailable

Confirm with `gh auth status` that the CLI is authenticated and has the `repo` scope, and
that the selected repository has a GitHub remote named `origin`. Then press **Refresh**
or **Pull issues**.

### The issue list is stale

Press **Pull issues** or the top-bar **Refresh** button. Background working-tree polling
does not contact GitHub.

### A branch cannot be switched or pulled

Commit, stash, or discard tracked changes first. A diverged branch cannot be pulled
automatically because pull uses `--ff-only`; reconcile it with Git before retrying.

### A merge reports conflicts

Resolve the conflicted files in an editor, stage them, and create the merge commit.
vibe-git reports conflicts but does not provide a conflict-resolution editor.

### Assistant actions are slow

Check whether the configured model server is using available hardware acceleration and
whether the selected model fits in available memory. Embedding and classification work
can also be reduced by lowering Assistant concurrency. Any action that is taking longer
than it is worth can be stopped with **Cancel**.

### The chat panel answers without looking anything up

Tool calling requires a model that supports it; a model that ignores the tools will answer
from the conversation alone. Chat also needs more context than the other actions — it asks
for at least 16k tokens — so a model configured with a small context window may drop tool
results mid-conversation.

## Development

Run the dependency-free test suite with `npm test`.

### Project structure

```text
server.js       HTTP server, API routing, request guards, and static serving
lib/exec.js     subprocess boundary, dry-run handling, and shared validators
lib/git.js      working tree, history, branches, and synchronization
lib/issues.js   GitHub issue reads and normalization
lib/plans.js    deterministic milestone matching, plan hydration, drift, and ranking
lib/prs.js      pull request reads and creation
lib/queue.js    persistent, validated GitHub issue operation queue
lib/repos.js    repository discovery, selection, cloning, and local configuration
lib/llm.js      optional Ollama-compatible Assistant client
lib/search.js   hybrid search, calibrated similarity, duplicates, dependency structure
lib/assistant.js  the chat panel's read-only tools and propose-only conversation loop
lib/jobs.js     cancellable Assistant work
web/            dependency-free browser interface
test/           Node test suite
```

## Known limitations

- The remote must be named `origin`. Fork workflows that use a separate `upstream`
  remote are not supported for push, tag, and remote-URL operations.
- Issue fetching is capped at 800 issues per repository. Very large repositories may also
  hit GitHub API rate limits, which surface as `gh` errors; wait for the limit to reset.
- File staging operates on whole files only.
- Merge conflicts require an external editor.
- Semantic search, related issues and duplicate detection need an embedding model and a
  built index; without one, search falls back to text matching and the other two are off.
- Chat requires a tool-calling model, holds its transcript only in the browser tab, and
  stops after eight lookups in one turn.
- Repository creation and publishing are not included.
- Force-push, submodule, and Git LFS workflows are not included.
- Pull is fast-forward only by design.
- The server is local-only and does not provide TLS or multi-user authentication.

## License

Released under the [MIT License](LICENSE).
