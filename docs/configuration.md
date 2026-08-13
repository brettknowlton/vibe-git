# Configuration, privacy and security

[← README](../README.md)

## Credentials

vibe-git uses the account `gh` is already authenticated as and stores **no GitHub
credentials of its own**. On a shared machine it therefore acts as whoever is signed in —
the top bar names that account for this reason.

The [assistant](assistant.md) additionally needs a model endpoint and is disabled until one
is configured. An API key, where needed, is stored at mode 0600 and is never sent to the
browser.

Removing a repository from the app removes only its entry; the folder and its files stay on
disk and it can be added again later.

## Theme

Light, dark, or follow the system setting — the ◐ button in the top bar cycles between
them. The choice is stored per browser and applied before first paint, so a dark theme on a
light system does not flash white on every reload.

## Command-line options

| Option | Description |
|---|---|
| `--dry-run` | Allow reads and log writes without executing them |
| `--port N` | Use a loopback port other than `11001` |
| `--repo PATH` | Select a repository at startup |
| `--scan DIR` | Add a repository path to the initial repository list |
| `--tailscale` | Allow tailnet access through `tailscale serve`, for this node's owner |
| `--allow-user LOGIN` | Admit a specific tailnet login remotely (repeatable) |
| `--allow-host NAME` | Serve an additional `Host` value (repeatable) |

`VIBE_GIT_PORT` can also set the default port. `npm start`, `npm run dry-run` and `npm
test` are aliases for the same commands.

## Scripting a running instance

`tools/vibe.js` is a dependency-free client for a server that is already running. It finds
the per-run token itself, so a shell script does not have to scrape it out of the HTML:

```bash
node tools/vibe.js issues --state open
node tools/vibe.js close 11 --reason completed --comment "Implemented in lib/llm.js:460."
node tools/vibe.js queue        # exactly what would run
node tools/vibe.js push         # the only command that writes to GitHub
```

`node tools/vibe.js help` lists the rest. It talks to the same guarded API the browser
uses, so it inherits every guard — including the staged-change queue.

## Local data

Everything is stored under:

```text
~/.config/vibe-git/
```

That includes the repository list, settings, the staged issue queue, generated plans,
ignored suggestions, hidden plan entries and refused dependency edges (`muted/`), when you
last caught up with each tracker, the embedding cache, and a local copy of each
repository's issues and milestones. New files use owner-only permissions.

The issue copy is what the Issues, Plan and assistant views read, so opening vibe-git again
does not wait on `gh`; **Pull** refreshes it. It contains issue titles, bodies and
comments — including those of private repositories — in plain JSON under your home
directory.

This path is used on every platform and does not follow `XDG_CONFIG_HOME`, macOS
`Application Support`, or Windows `AppData` conventions. vibe-git is developed and tested on
Linux; it should run anywhere Node.js, Git and `gh` do, but other platforms are not
regularly verified.

vibe-git has **no telemetry**. Depending on the action, it talks only to:

- Git remotes configured in the selected repository;
- GitHub, through the authenticated `gh` command; and
- the assistant endpoint configured in settings.

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
- That login must be on an allowlist, defaulting to the account that owns the machine.

Funnel — Tailscale's public-internet mode — carries no identity, so its requests fail the
same check. The server refuses to start if Funnel is already enabled.

A remote session is labelled in the top bar with the account it authenticated as, because a
window opened from a phone can push to GitHub exactly like the one on your desk.

Without `--tailscale`, nothing but loopback is served.

## Security model

vibe-git can modify repositories and GitHub data, so it is intended for **one trusted user
on a local computer**.

- The server binds to `127.0.0.1` only, including with `--tailscale`.
- Page and API requests validate `Host` and `Origin`.
- Remote access requires a loopback-proxied request carrying an allowlisted Tailscale
  identity; tailnet membership alone grants nothing.
- Every API request requires a random token generated at startup, injected under a Content
  Security Policy nonce.
- External processes use `execFile` with argument arrays and `shell: false`. There is no
  endpoint that accepts an arbitrary command string.
- Branches, issue numbers, labels, milestones, assignees and changed-file paths are
  validated before use.
- Untrusted repository and model text is rendered without executable HTML.
- Assistant tools are read-only; the only ones with an effect produce staged proposals,
  revalidated against the repository before they can be pushed.
- Repository text quoted to a model is identified as data, so instructions written into an
  issue body are not treated as instructions to the assistant.
- Destructive actions use confirmation steps, and GitHub issue writes use the staging
  queue.
- Pull is fast-forward only.

Do not expose the server to a network, or run it as a hosted multi-user service, without
adding a separate authentication and authorization layer.
