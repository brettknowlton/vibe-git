# Development

[← README](../README.md)

There is no build step and no third-party runtime dependency. Run the test suite with:

```bash
npm test
```

It uses Node's own test runner. Tests that need a loopback listener skip themselves in
environments that do not permit one.

`node server.js --dry-run` performs every read for real and only logs writes, which is the
right way to exercise anything that would otherwise touch GitHub.

## Project structure

```text
server.js         HTTP server, API routing, request guards, and static serving
lib/exec.js       subprocess boundary, dry-run handling, and shared validators
lib/git.js        working tree, history, branches, and synchronization
lib/conflicts.js  which side is which, marker parsing, and resolving them
lib/images.js     image previews: format sniffing, header-only dimensions, data URIs
lib/issues.js     GitHub issue reads and normalization, and the gh preflight check
lib/templates.js  the repository's own issue and pull request templates, incl. issue forms
lib/seen.js       when you last caught up, and what has happened since
lib/plans.js      deterministic milestone matching, plan hydration, drift, and ranking
lib/mutes.js      hidden plan entries and refused dependency edges, keyed to survive rebuilds
lib/prs.js        pull request reads and creation
lib/queue.js      persistent, validated GitHub issue operation queue
lib/repos.js      repository discovery, selection, cloning, and local configuration
lib/llm.js        assistant prompting: classification, gaps, plans, commit messages
lib/providers.js  the model wire — Ollama, OpenAI-compatible, and Anthropic dialects
lib/workspace.js  read-only, git-mediated access to the working tree for the assistant
lib/search.js     hybrid search, calibrated similarity, duplicates, dependency structure
lib/assistant.js  the chat panel's read-only tools and propose-only conversation loop
lib/jobs.js       cancellable assistant work
lib/access.js     loopback and tailnet request guards
tools/vibe.js     command-line client for a running server
web/              dependency-free browser interface
test/             Node test suite
```

## Invariants worth not breaking

These are load-bearing. Several of them exist because breaking them once produced a real
failure.

- **`stage` queues, `push` applies.** Nothing else writes to GitHub.
- **`lib/exec.js` is the only subprocess spawner**, using `execFile` with argument arrays
  and `shell: false`. Every identifier passes through its validators first.
- **The assistant proposes and never applies**, and reads the repository only through git.
- **API keys live in `~/.config/vibe-git/config.json` at mode 0600** and are never sent to
  the browser.
- **Model output is untrusted input.** So is every issue body, commit message and file the
  assistant reads.
- **Bump `API_VERSION` in `server.js` and `APP_API` in `web/app.js` together** whenever a
  route is added, removed or renamed. A reloaded page checks them and warns when the server
  is older than the code it is serving; a test enforces that they match.
- **Adding a queue operation means adding one entry to `KINDS`** in `lib/queue.js`, which
  validates, describes and builds the argv for itself.
