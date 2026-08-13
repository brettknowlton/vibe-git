# Resolving conflicts

[← README](../README.md)

A **Conflicts** view appears in the sidebar whenever a merge, rebase, cherry-pick, revert
or stash restore is half-finished, and disappears when it is not.

## It names the sides

`<<<<<<< HEAD` and `>>>>>>> feature/login` only mean something if you already know which
operation you are in the middle of — and during a **rebase they mean the opposite of what
almost everyone assumes**: the block marked `HEAD` is the branch you are replaying *onto*,
and your own commit is the second one. Keeping "HEAD" there throws away your work.

So nothing in this view says "ours" or "theirs". Each side is labelled with:

- the branch or commit it actually came from,
- the role it plays in *this* operation ("the branch you are on", "your own commit, being
  replayed"),
- when it was written, and which of the two is **newer**,
- and, as a footnote, which marker introduces it.

A rebase additionally gets a highlighted warning that its sides are reversed.

## Per conflict

- **Keep this** on either side, or **Revert to this** on the common ancestor when shown.
- **Keep both**, in either order.
- **Write it myself** — a text box pre-filled with both sides, so the edit is a deletion.
- **Ask about this one** — see below.

## Per file

- **Use all of `<branch>`** for either side.
- **Show the ancestor** re-runs the conflict with `--conflict=diff3`, adding what both
  sides *started from* between them. This is the most useful thing you can do to a conflict
  you cannot read: it shows what each side **changed**, rather than only what each ended up
  with.
- **Edit the whole file** as text, markers and all.
- **Put the conflict back** restores the markers, so a decision made too fast costs
  nothing.

## Conflicts with nothing to edit

The four conflicts that have *no markers* — a file changed on one side and deleted on the
other, added on only one side, deleted on both — get plain-English options about whether
the file should exist, instead of an empty diff. This is where an editor-only workflow
leaves you with nothing to look at.

## Images

Shown as pictures rather than as "Binary files differ", in the same columns and colours as
a text conflict, with each version's dimensions and byte size underneath and a warning when
the two sides are different sizes. Transparency is drawn against a checkerboard and pixels
are kept square, because most of these are sprites. See [image
previews](git.md#image-previews).

## Identical sides

When both sides are byte-identical, the view says so instead of offering a choice between
two things that are the same.

This happens more often than it sounds: when two branches reorganise the same folder under
different names, git reports a `file location` conflict on files whose contents never
changed at all. The status letters call it "both added" and say nothing about the cause,
which reads as the tool being broken. vibe-git names it, says the choice is free, and lets
you settle it in one click.

## Two deliberate behaviours

**Nothing is staged until you say so.** `git add` on a conflicted file destroys the stages
Git recorded, and with them any way back, so resolving edits the working file and stops
there. **Continue** stages what is finished as its first act, and refuses by name while
anything is still undecided.

**Edits made in your editor are picked up** while the view is open, and a decision made
against a version of the file that has since changed is refused rather than written over
the top of it.

## Asking the assistant

With the [assistant](assistant.md) configured, **Ask the assistant** reads both sides —
plus the ancestor when present — and proposes a resolution per conflict, with its reasoning
and a confidence.

It is shown the sides *positionally*, never as "ours" and "theirs", for exactly the reason
above. It can answer "no confident answer", and does on genuinely contradictory changes.

It never writes: every suggestion shows the exact text it would insert, and applies through
the same button you would have pressed yourself, or can be edited first, or dismissed.
