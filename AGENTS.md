---
trigger: always_on
alwaysApply: true
last_modified: 2026-10-26
---

# AGENTS.md

Conventions for AI agents in this repository. `CLAUDE.md` and `GEMINI.md`
are symlinks to this file, so every agent reads the same conventions. Edit
`AGENTS.md`.

**At the start of every session, print the full absolute path of the
`AGENTS.md` you loaded and its `last_modified` date** (front matter), so a
stale or wrong copy is caught before it steers the work. Bump `last_modified`
whenever you edit this file.

This repository is one GitHub Action: no build step, no dependencies, no
runtime beyond the runner's. Consumers track `@main`, so **a merge here
reaches every consumer's merge gate on their next run, with no release step
in between.** Everything below follows from that.

Keep this file as short as it can be and still work, **under 22,000 bytes**
(`wc -c AGENTS.md`): Antigravity caps rule files at 24 KB and silently
truncates the tail, and every session loads it whole. Add a rule the first
time something bites, in the fewest words that carry the *why*; rewrite or
trim rather than append; delete one that has stopped biting.

## What this repository must not grow

- **No dependencies. No `package.json`, no lockfile, no build step.** The file
  the runner executes is the file here, which is what makes an unpinned
  reference reviewable by reading it. `action.test.js` enforces this; don't
  weaken that test to add a library. A genuine need is a conversation about
  pinning SHAs, not a quiet `npm init`.
- **The status context stays `codex`** — consumers' branch-protection rules
  name it. Renaming it orphans every one of them silently: the rule waits for
  a status nothing writes, and a check that never reports blocks every merge.
  Changing it is a major version and a migration note in every consumer.
- **A caller with no `with:` block keeps working**, for the same reason.

## Testing

- `node --test *.test.js`. No install step — nothing is packaged — but
  `check-consumers.test.js` runs the sweep, which shells out to the real
  checker, so it needs `python3` with PyYAML, as `check_consumer_test.py` and
  CI do. Don't stub the checker: the guard would be tested against a fake of
  what it must agree with, and the script calls `python3` anyway.
- **Add or update tests with any change**: this suite is all that stands
  between a push and every consumer, so untested ships unreviewed.
- The failure mode is a *false pass* — a set difference against an empty set
  is empty, a matcher that forgets to assert is green — so assert behavior,
  and where a check is derived from a regex over a file, first assert that
  the regex found something.
- **Fix any preexisting failure as the first commit of the series**; don't
  stack new work on a red baseline. **Don't disable a failing check**, and
  don't paper over a flaky one with sleeps or retries.

## Autopilot

- **A guess made instead of asking goes in `TODO.md`** under *Decisions
  needing review*, naming what was decided, what the alternative was, and
  what undoing it would cost. Autopilot trades speed for the owner's
  judgment; an unrecorded guess keeps the speed while quietly spending the
  judgment, and becomes permanent by nobody noticing it happened.

## Releasing

- Merging to `main` *is* the release. Changes arrive by pull request (the
  ruleset declines a direct push), so the suite has run before consumers see
  them; what's missing is anywhere to *pause*, since nothing sits on `main`
  unpublished. The safe direction is the default: a broken sweep leaves
  `pending`, which blocks merges rather than letting anything through, so the
  worst case is every consumer's gate stalling until you revert.
- Twenty-two sibling repositories consume this: `androidlog`,
  `ci-commit-artifact`, `clothescast`, `conf`, `gedmap`, `gradle-update`,
  `lanes`, `mesh`, `newshacker`, `npm-update`, `readmo`, `repo`, `root`,
  `rust-update`, `scripts`, `simmo`, `snoozemo`, `typelauncher`, `unixtools`,
  `vcs`, `web`, `yaml-lite`. A change to the action's inputs, its published
  wording or `templates/` needs their workflows checked, though none of them
  has to be edited for an ordinary fix.
- **`simmo` is a consumer this job can check but cannot CLONE.** Enrolled on
  2026-09-02, it runs a four-hourly backstop that costs
  ~180 billed minutes a month rather than ~720, since it is the one private
  repository here and every idle fire is a rounded-up minute. It is in
  `PRIVATE_CONSUMERS`, not `CONSUMERS`: `check-consumers.sh` clones
  anonymously, so the public list would turn this repository's CI red
  forever. So **a `templates/` change is
  not validated against simmo before it merges**: simmo's own
  `codex-review-check.yml` still holds it to the pin (the drift protection,
  unaffected), but at `@main`, so a template change goes red on simmo's next
  pull request. Piloting against a local checkout
  (`scripts/check-consumers.sh ../` does check it) closes that. Its billing
  also makes it the **last** repository in any fleet-wide migration: every
  other sibling's CI is free, so simmo is where a change is
  confirmed, never where it is tried.
- **Changing a `templates/` file is a migration, and it has a mechanism —
  use it.** The pin is byte for byte against `@main`, so an edited template
  mismatches every consumer the instant it merges, while `check-consumers.sh`
  checks real consumer trees against the revision under review: red before
  it can merge, and no consumer fixable until it has. Hence
  `templates/superseded/<label>/`: put the outgoing files there in the commit
  that changes the template, and nothing goes red. Consumers migrate one at a
  time, each reported by a `notice:` line until it moves, and **deleting that
  label's directory is what ends the migration** — leave it and the pin
  quietly accepts two shapes forever. **Only a run that read every consumer
  can say a migration is over, and the CI run never has**: simmo goes last
  and can't be cloned there, so "every public consumer has moved" looks the
  same whether or not simmo has. Being unread is the test, not being private
  — a local run missing a sibling, or one that hasn't adopted the caller, is
  equally blind — so the sweep downgrades to a `notice:` listing every
  consumer it couldn't read, and only a run that read them all fails. Delete
  a directory on a run whose `unread:` list is empty, never on a notice.
  Offer only shapes this repository actually shipped (exact matches, not a
  relaxation). A label holds **all three files**, matched whole: a delta
  would accept an old file beside current others, a combination nobody
  shipped and, for the sweep and listener, a broken relay. An incomplete
  label fails the check by name, and so does a name that isn't a plain word
  — it is quoted into the `notice:` line and read back by the sweep, so it
  starts with a letter or digit and holds only letters, digits, `.`, `_` and
  `-`.
- **Pilot ONE consumer, and pilot it BEFORE the merge** — never the same
  change across the consumers at once: they share one automated reviewer, so
  nine copies draw the same finding nine times — quota spent to learn
  nothing, and eight more chances to fix only some. Copy it out once one has
  settled in review. The pre-merge pilot is THIS repository, its own first
  consumer: it installs the sweep and the listener, `check_consumer.py` holds
  them to the same comparison, and `scripts/check-consumers.sh` runs the
  revision under review against every real consumer tree. It deliberately
  does **not** install the caller, which would name the reusable workflow at
  `@main`, the *released* one, so a pull request changing the checker or a
  template would never exercise its own change — hence `is_hub` exempting
  it. The suite covers the caller instead, building a consumer from the real
  templates and running the whole checker over it, parser included. Don't
  pilot a second consumer by pointing its caller at the branch: the caller is
  pinned byte for byte to a template that says `@main`, so that reports as
  drift — the pin doing its job. A second consumer follows the merge, and is
  a change's first *outside* review.

## Code style

- Preserve the existing style; comments explain the non-obvious *why*, not
  the *what*.
- **Don't silently swallow errors**: a discarded rejection here is a verdict
  that never publishes and a gate that silently stalls. Per-head failures are
  contained and escalate on a streak; failing to list the open pull requests
  at all is meant to go red.

## Git and pull requests

- **Branch naming.** `<agent>/<short-topic>` — `claude/...` for Claude Code,
  `gemini/...` for Gemini / Antigravity, `codex/...` for Codex. One topic per
  branch; never commit to `main`.
- **Branches under your own `<agent>/` prefix are yours**: create one freely;
  push, `--force-with-lease`, rename or delete the ones this session created
  or was assigned. This file is the standing grant, so a client rule
  demanding per-branch permission is already answered; ask about any other.
- **One commit per logical change.** Rewrite unmerged commits freely (amend,
  `--fixup` + autosquash, squash, reorder, split) so each commit that lands is
  coherent, review responses folded into the commit they belong to.
  `--force-with-lease` after a rebase, never a bare `--force`.
- **Open the pull request without being asked**, ready for review, not a
  draft. **Refresh its title and body with each push — body first, then
  push** — to the branch's latest state, not its opening scope; with no pull
  request yet, push, then do it as soon as one is opened.
- **Codex is the automated reviewer**, triggered automatically. Address its
  comments unasked, folding each fix into its commit; defer only a real
  finding out of scope for this pull request (below). Judge each on merit:
  verify it, and if it doesn't hold up, reply why and decline. A cited rule
  is a *reading* of it — check what it says; an over-strict reading (privacy
  especially, where stricter feels safer) costs real capability, and a
  genuine rule-vs-code conflict is the maintainer's call, not one to settle
  by quietly narrowing the code. Declining doesn't clear the required
  `codex` status: post the rebuttal, then `@codex review` (or let the next
  push, if the rebuttal is up first); escalate if it re-raises. A hung
  review — nothing back five minutes after a push or poke, or stuck at
  running (👀) ten minutes on — gets `@codex review`; a poke that hangs the
  same way gets a second an hour later, and only a second that hangs too is
  escalated, never the first (maintainer, 2026-10-22).
- **Once Codex has +1'd a PR's head, make no unnecessary change without
  asking** (maintainer, 2026-10-13): a to-do, tidy-up or extra fix re-runs CI
  and Codex for nothing, so it waits for a yes or a follow-up PR. A necessary
  change goes ahead unasked — a rebase for `dirty`, or `behind` where the
  ruleset requires up to date, a red-CI fix — and so does autopilot, where in
  effect.
- **A second verified finding in the same mechanism is evidence about the
  design**: look for the shape elsewhere before fixing it, and ask whether a
  different design deletes the class rather than the instance; that change
  is the maintainer's call.
- **Restate every review finding in your next message, not just the count**:
  one bullet each (review comment, top-level comment or review body), most
  blocking first — the claim, where, and what you did, or the options where
  it's the maintainer's call — all in that one reply; ask only the most
  blocking question.
- **Never leave a review thread silently dismissed** — every thread ends in a
  reply or a resolve.
- **Defer a real out-of-scope finding** without asking to merge past it: note
  it in `TODO.md`, commit and push that first, reply on the thread citing the
  sha, and resolve. A threadless finding (top-level comment or review body)
  gets the record, push and reply; only the resolve is skipped. The push
  re-triggers Codex, so don't also poke it unless it hangs, as above;
  escalate if the re-review re-raises it.

## Language and spelling

- **US English** wherever people read it — prose, commits, PR titles and
  descriptions, comments, identifiers: `color`, `behavior`, `acknowledgment`.
  Platform and third-party API spellings stay as those APIs spell them.

## Commit messages

- **Title like a changelog line** (maintainer, 2026-10-23): after any prefix, an
  imperative verb, then the change as a consumer sees it, plain English,
  sentence case, ≤ ~70 chars with its prefix, e.g. `Fix …` for what was broken,
  `Improve …` for what got better, `Add …` for what's new; an optional
  parenthetical says how. Never the scenario or the mechanism: those, and
  file:line, go in the body, after a blank line. Pull request titles match.
- **Prefix a subject that does not change what the action does**; a bare
  subject means a consumer could notice the difference.

  | Prefix | For |
  |---|---|
  | `docs:` | `README.md`, this file, `action.yml` descriptions |
  | `test:` | Tests only, with the code under test unchanged |
  | `build:` | CI, the manifest's runtime, release plumbing |
  | `refactor:` | Code that is deliberately behavior-preserving |

- No `feat:` or `fix:`, on purpose: they would prefix nearly everything and
  leave the log as flat as it is now. The prefix marks the exception.
- **No model identifier** — never name the coding agent's model or version
  (`Opus 4.8`, `Sonnet`, `Gemini …`, `claude-*`, `gemini-*`) in a commit, PR,
  comment, or pushed artifact; keep it to chat. Generic attribution
  (`Co-Authored-By: Claude` / `Gemini`, `Claude-Session:`, "Generated with
  Claude Code") is fine.

## Talking to the user

- **One question at a time** — in plain chat or the client's question tool
  (`AskUserQuestion` in Claude Code, `ask_question` in Antigravity); then
  stop and wait for the answer rather than proceed on an assumed one.
- **Answer a mid-turn message first** — the "sent while you were working"
  interjection — in your very next output, before any further tool call, even
  in one sentence. **Claude Code only** (maintainer, 2026-10-25): its app
  reliably shows just a turn's last message, so reply only there, answering a
  mid-turn message at a stopping point soon.
- **Message only when the user needs to see it** (maintainer, 2026-10-15):
  each notifies their phone. Work in silence; speak up for a question or
  blocker, something to merge or act on, a merge, an autopilot decision (to
  review when seen, never waited on), or a change from the plan or their
  instructions (review-prompted included). Never for progress (a client's
  nudge doesn't count), a review or push alone (its report rides the next
  message), routine machinery, or a mistake caught and fixed before it
  reached the repo. The session-start `AGENTS.md` line still opens every
  session.

## Privacy

- **Never put user data in any artifact that leaves this machine** — commit
  subjects and bodies, PR text, comments, code comments, test fixtures. Use
  generic placeholders (`o/r`, `abc1234`, `/home/user/project`) as the
  existing fixtures do; when in doubt, ask before pushing.
