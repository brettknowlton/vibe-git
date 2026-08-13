# Git, branches and pull requests

[← README](../README.md)

The ordinary Git desktop half. All of this works on a repository with no GitHub remote at
all, except the pull request section.

![Changes view with a file list and diff](screenshots/changes.png)

## Repositories

- An explicit list, rather than a filesystem scan on every launch.
- Add one repository, or add a directory of repositories with a one-time scan.
- Clone from a GitHub URL or `owner/repository` shorthand.
- Switch between recent repositories from the top bar.
- Remove a repository from the app without deleting anything from disk.

## Working tree and commits

- See every changed, added, deleted, renamed, untracked, or conflicted file.
- Open a full diff for a selected file.
- Select individual files, or all of them, for a commit.
- Commit with a summary and optional description.
- Draft an editable commit subject and description from the selected changes, when the
  [assistant](assistant.md) is configured. It only fills the form — it never stages files
  or creates a commit.
- Discard selected changes, behind a confirmation step.
- Amend the most recent commit message.
- Undo the most recent commit with a soft reset, preserving its changes.
- Stash changes, and pop or drop any individual stash by name. Stashes are listed whether
  the tree is dirty or clean — a clean tree is exactly when a stash is the only thing left
  to restore, and that was the one state where the old placement hid them.

File staging is whole-file only; per-hunk and per-line staging are not available.

## Branches and synchronization

- See the current branch, upstream, recent local branches, and remote-only branches.
- Create branches, switch branches, and create local copies of remote branches.
- Unsafe branch switching is refused while tracked changes are present.
- Merge another local branch into the current one.
- Delete branches, with confirmation.
- Ahead and behind counts in the top bar.
- Fetch all remotes and prune deleted remote references.
- Pull with `--ff-only`, so history is never rewritten automatically.
- Push the current branch, setting its upstream when needed.

## History reads two ways

A repository has two histories, and the commit log only holds one of them. A decision
argued out in an issue thread and never written into a commit message leaves no trace in
`git log` at all.

**Commits** — the log for the current branch, newest first. Click one for its message,
file statistics, and full patch.

**Issue activity** — every issue filed, closed and commented on, grouped by day, newest
first. Click one to open the issue.

Both readings come from data already in memory — the log from git, the timeline from your
last issue pull — so the switch costs nothing and neither fetches.

Label changes, reassignments and reopens are deliberately **absent**. They live only in
GitHub's timeline API, which a pull does not fetch, and deriving them from `updatedAt`
would produce a history that looked complete and was wrong. The view says so rather than
letting you assume otherwise.

## Image previews

Selecting an image in **Changes** shows it rather than a text diff: the HEAD version beside
the working-tree version, each with its pixel dimensions and byte size. A conflicted image
gets the same treatment in [Conflicts](conflicts.md), one column per side.

- PNG, JPEG, GIF, WebP, BMP and ICO. Dimensions are read from the file header, so nothing
  is decoded and no dependency is involved.
- Transparency is drawn against a checkerboard, and pixels are kept square rather than
  smoothed — the common case here is 32×32 sprite work, where smoothing hides exactly the
  single-pixel differences worth looking at.
- The extension picks the candidate format and the magic bytes confirm it; a file whose
  contents disagree with its name is labelled rather than silently mis-rendered.
- SVG is deliberately excluded. It is markup that can carry script, and it reads perfectly
  well as a text diff.
- Images travel as base64 data URIs inside JSON rather than from a route that serves bytes,
  so the page's `img-src data:` CSP is not widened. Anything over 4 MB reports its size
  instead of being previewed.

## Pull requests

- List open, merged, closed, or all pull requests.
- View the body, author, branches, review state, mergeability, commits, changed-file count,
  additions, deletions, and diff.
- Open a pull request from the current branch, from **Changes**, from **Pull requests**, or
  from the command palette.
- Edit the description of an existing pull request.
- Choose the base branch — local branches and branches that exist only on the remote —
  defaulting to the repository's own default branch rather than a guess at its name.
- Create a draft pull request.
- Detect an existing pull request for the current branch.
- Publish an unpushed branch from the form, which a pull request needs first.
- The repository's `PULL_REQUEST_TEMPLATE.md` is prefilled into the description.

Unlike issue edits, **pull request writes are not staged**. Creating one and saving a
description both apply immediately, each behind a two-stage confirm, because they act on a
single artifact rather than a batch of related metadata changes.
