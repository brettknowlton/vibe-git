# Troubleshooting

[← README](../README.md)

## GitHub features are unavailable

The app checks `gh` itself and says which of three things is wrong — not installed, older
than 2.54, or nobody signed in — along with the command that fixes it. If it reports none
of those, confirm with `gh auth status` that the CLI has the `repo` scope, and that the
selected repository has a GitHub remote named `origin`. Then press **Refresh** or **Pull
issues**.

The Changes, History and Conflicts views keep working regardless: they are Git, not GitHub.

## The issue list is stale

Press **Pull issues** or the top-bar **Refresh**. Background working-tree polling never
contacts GitHub, so the list only moves when you ask it to. Past about ninety minutes the
top-bar stamp says its age and turns amber rather than showing a clock time.

## A branch cannot be switched or pulled

Commit, stash, or discard tracked changes first. A diverged branch cannot be pulled
automatically because pull uses `--ff-only`; reconcile it with Git before retrying.

## A pull will not fast-forward

vibe-git says why and offers the way out rather than only refusing. Uncommitted changes get
a one-click **stash, pull, restore**; the stash is kept if any step fails, so nothing is
discarded. Diverged branches are reported as a merge-or-rebase decision, which vibe-git
deliberately does not make for you.

## A merge reports conflicts

A **Conflicts** view appears in the sidebar for as long as one is half-finished, and the
banner in **Changes** links straight to it. See [Resolving conflicts](conflicts.md).
**Abort** is available from either place and restores the branch exactly as it was.

## Assistant actions are slow

If the delay is at the *start* of every action and the endpoint is local, the model is
probably being reloaded each time. Raise **Keep model loaded** — the default of 30 minutes
is already far above Ollama's own five, but a `0` there restores the five-minute behaviour.
See [keeping a local model warm](assistant.md#keeping-a-local-model-warm).

**Loaded in memory** in the same panel shows what is currently resident and what fraction
is on the GPU. A model reported at 0% GPU is running on the CPU, which is the other common
cause.

Otherwise: check the model fits in available memory, lower **Parallel requests**, and stop
anything not worth the wait with **Cancel**.

## The chat panel answers without looking anything up

Tool calling requires a model that supports it; one that ignores the tools will answer from
the conversation alone. Chat also needs more context than the other actions — it asks for
at least 16k tokens — so a small context window may drop tool results mid-conversation.

## The assistant proposed a dependency and it vanished

It named a closed issue, and closed issues block nothing. The run says how many proposals
were discarded for that reason rather than silently keeping the survivors. See [a closed
issue blocks nothing](plan.md#a-closed-issue-blocks-nothing).

## Known limitations

- The remote must be named `origin`. Fork workflows using a separate `upstream` remote are
  not supported for push, tag, and remote-URL operations.
- Issue fetching is capped at 800 issues per repository. Very large repositories may also
  hit GitHub API rate limits, which surface as `gh` errors; wait for the limit to reset.
- Only the 20 most recent comments per issue are stored, so the timeline and the
  attention marker see that far back and no further.
- File staging operates on whole files only.
- Conflict resolution is per-conflict-block, not per-line within a block; a finer split
  needs the hand editor or an external one. Binary conflicts offer whole-file choices only.
- Semantic search, related issues and duplicate detection need an embedding model and a
  built index; without one, search falls back to text matching and the other two are off.
- Chat requires a tool-calling model, holds its transcript only in the browser tab, and
  stops after eight lookups in one turn.
- Issue timeline events are limited to filed, closed and commented. Label changes and
  reassignments live only in GitHub's timeline API, which a pull does not fetch.
- Repository creation and publishing are not included.
- Force-push, submodule, and Git LFS workflows are not included.
- Pull is fast-forward only by design.
- The server is local-only and provides no TLS or multi-user authentication.
