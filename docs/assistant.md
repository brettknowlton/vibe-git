# The assistant

[← README](../README.md)

Optional, disabled until configured, and works against Ollama, any OpenAI-compatible
server, or Anthropic.

**It proposes and never applies.** Classifications, plans, dependencies, chat suggestions
and missing-work drafts all become cards you stage and push through the same queue as a
manual edit. It reads the repository only through git — `git ls-files`, `git show`, `git
grep` — and has no tool that runs a command or calls the GitHub API.

![Assistant Run tab](screenshots/assistant-run.png)

## What it can do

- Classify unorganized issues by milestone and label, using the existing milestone
  **descriptions** as the deciding evidence.
- Nominate a new milestone or label when nothing existing fits, or when it notices a
  recurring theme the current labels cannot express.
- Re-check all open issues, including ones that already have a milestone.
- Suggest missing issues from the tracker and an available planning document.
- Generate or update the [Plan view's](plan.md) ordering, explanations, risks and
  missing-work drafts in one action.
- Identify [ordering constraints](plan.md#dependencies) and propose recording them,
  refusing edges that would be circular or point the wrong way.
- Answer questions about the repository in a chat panel, looking things up as it goes —
  including reading the source, so it can tell "nobody built this" apart from "somebody
  built it and never closed the issue".
- Propose closing an open issue whose work it found already implemented, citing the
  `file:line` evidence in the closing comment.
- Summarize selected working-tree changes into an editable commit-message draft.
- Propose a resolution for each block of a [merge conflict](conflicts.md), and say plainly
  when it has no confident answer.
- Retrieve similar issues as classification precedent, with an optional embedding model.
- Sweep the tracker for near-duplicates, with no model inference at all.
- Report what it is doing while it does it — which action, how far through, and which file
  or issue it is reading right now.
- Remember ignored suggestions, hidden plan entries and refused dependency edges, so none
  is repeatedly proposed.
- Repair its own malformed JSON once before failing, so a plan over a whole tracker is not
  discarded for a missing brace.

Every action is cancellable. **Cancel** stops the batch and drops the sockets of requests
already in flight, which matters when a large model is minutes into work you no longer
want. Because nothing an action produces is written anywhere, cancelling can only ever
abandon a proposal.

## Setup

1. Open **Assistant** from the top bar, then **Settings**.
2. Enable assistant features.
3. Enter the endpoint. Leave **Kind of endpoint** on *Detect automatically* unless it
   guesses wrong; the panel reports what actually answered.
4. Enter an API key if the endpoint needs one.
5. Select a chat model and, optionally, an embedding model.
6. Adjust concurrency and context if required.
7. Return to **Run** and choose an action.

![Assistant settings with endpoint, model, and account state](screenshots/assistant-settings.png)

### Supported endpoints

| Kind | Examples | Key |
|---|---|---|
| Ollama | `http://127.0.0.1:11434` | none |
| OpenAI-compatible | llama.cpp `--server`, LM Studio, vLLM, LocalAI, OpenRouter, Groq, Together, OpenAI | bearer token, if hosted |
| Anthropic | `https://api.anthropic.com` | `x-api-key` |

The URL may be given with or without a trailing `/v1`, and a reverse-proxy prefix is
preserved. Servers that do not implement JSON-schema response formats — which is many of
the ones claiming OpenAI compatibility — are detected and fall back automatically.

### API keys

Keys are stored in `~/.config/vibe-git/config.json` at mode 0600 and are never returned to
the browser; the settings panel shows only whether one is set.

Better still, keep the key out of the file entirely by storing the *name* of an environment
variable, read at call time:

```json
{ "ai": { "apiKey": "${OPENROUTER_API_KEY}" } }
```

### Embeddings

Optional, and they power semantic search, duplicate detection, and the precedent retrieval
that makes classification noticeably more accurate.

They can live at a **different endpoint** from chat, which matters in two cases: Anthropic
has no embedding API at all, and pairing a hosted chat model with a local
`nomic-embed-text` keeps every issue body on your own machine. Set it under *Separate
endpoint for embeddings*.

Only configure an endpoint you trust. Issue bodies, planning documents, tracked source
files the assistant chooses to read, and explicitly selected file diffs may be sent to it
when actions run.

## Keeping a local model warm

Ollama drops a model after five idle minutes. That is shorter than the pause between
reading a plan and asking a question about it, so the ordinary rhythm of using this app
used to pay a full model load — tens of seconds on a large model — on nearly every action,
for no reason other than an idle timer.

**Keep model loaded** sets that timer. It defaults to 30 minutes, which covers a working
session; `0` restores the server's own behaviour and `-1` keeps the model resident until
you unload it. It costs only VRAM that nothing else is asking for, and it is the single
largest latency difference available here. Endpoints with no notion of residency — every
hosted provider — ignore it, and the field is hidden for them.

Three other things exist for the same reason:

- **Independent lookups run together.** When the chat model asks for four things in one
  turn, the four run concurrently rather than in series, and the system prompt tells it that
  asking for everything at once is cheaper than asking one at a time.
- **Embedding batches run in parallel**, bounded by the same **Parallel requests** setting
  that governs classification.
- **The embedding index is parsed once**, then held in memory and revalidated by file
  timestamp. It is the largest file the app reads.

A local model is also given a generation ceiling. Without one, a model that fails to close
its JSON generates until the context window is full — minutes of tokens nobody will read,
followed by a parse error.

## Duplicate detection

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

## Chat

The open-ended half. It answers with tools rather than recall, and can:

- Read issues, one issue in full, milestones, labels, the plan, recent commits, and the
  state of the working tree.
- Read the tracker's whole dependency structure in one call — what is ready now, what is
  waiting, and which issues unblock the most work if finished. This is the same computation
  the Plan view draws, so the two cannot disagree, and the model is told not to claim
  anything is ready without consulting it.
- Search for issues resembling a description, semantically when an embedding model is
  configured and by word overlap otherwise.
- Propose an issue, an issue edit, a milestone, a label, a dependency, or a close — each
  becoming a card you stage and push like any other change.

Decisions you have already made travel with the conversation. Entries hidden from the plan
come back flagged as hidden, ignored issue ideas are named, and a dependency edge refused in
the Plan view is refused here too — the plan and the chat panel are two doors into one
tracker, and a rejection that only held behind one of them would not be a rejection. An
ignored *idea* is flagged rather than blocked, because you may be asking for exactly that;
the model is told to say so before you stage it.

The conversation lives in the browser tab, not on the server: switching repository or
pressing **Clear** ends it. Because the model reads issue text other people can write, it
is told that titles, bodies and commit messages are data rather than instructions, and
everything it says is inserted into the page as text, never as markup.

Planning context is read from common project files — `PLAN.md`, `ROADMAP.md`, `TODO.md`,
and their `docs/` variants — falling back to `README.md` when no dedicated one exists.
