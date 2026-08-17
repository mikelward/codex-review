# AGENTS.md

Conventions for AI agents working in this repository.

`CLAUDE.md` is a symlink to this file, so every agent reads the same
conventions. Edit `AGENTS.md`.

This repository is one GitHub Action. It has no build step, no dependencies and
no runtime of its own beyond the one the runner supplies. Consumers track
`@main`, so **a merge here reaches every consumer's merge gate on their next
run, with no release step in between.** Everything below follows from that.

Keep this file as short as it can be and still work. Every session loads it
whole, so each rule costs context on every turn: add one the first time
something bites, say it once in the fewest words that carry the *why*, rewrite
or trim an existing rule rather than appending beside it, and delete one that
has stopped biting.

## What this repository must not grow

- **No dependencies. No `package.json`, no lockfile, no build step.** The file
  the runner executes is the file here, which is what makes an unpinned
  reference reviewable by reading it. `action.test.js` enforces this; do not weaken that
  test to add a library. If something genuinely needs one, that is a
  conversation about pinning SHAs instead, not a quiet `npm init`.
- **The status context stays `codex`.** It is what consumers' branch-protection
  rules name. Renaming it orphans every one of those rules silently: the rule
  waits for a status nothing writes, and a check that never reports blocks every
  merge. A change here is a major version and a migration note in every
  consumer.
- **A caller with no `with:` block keeps working**, for the same reason.

## Testing

- `node --test *.test.js`. No install step; any recent node runs it.
- **Add or update tests with any change.** This suite is the only thing between
  a push and every consumer, so a change that ships untested ships unreviewed.
- The suites' failure mode is a *false pass* — a set difference against an
  empty set is empty, a matcher that forgets to assert is green — so assert
  behavior, and where a check is derived from a regex over a file, assert first
  that the regex found something.
- **Fix any preexisting failure as the first commit of the series.** Don't stack
  new work on a red baseline.
- **Don't disable a failing check** to make it pass, and don't paper over a
  flaky one with sleeps or retries.

## Releasing

- There is no release step: merging to `main` *is* the release. Changes get
  here through a pull request — the ruleset declines a direct push — so the
  suite has run on them before consumers see them; what is missing is anywhere
  to *pause*, since nothing sits on `main` unpublished.
- The safe direction is the default: a broken sweep leaves `pending`, which
  blocks merges rather than letting anything through, so the worst case is
  every consumer's gate stalling until you revert.
- Nine sibling repositories consume this: `conf`, `gedmap`, `lanes`, `mesh`,
  `root`, `scripts`, `unixtools`, `vcs`, `web`. A change to the action's
  inputs, its published wording, or `templates/` needs their workflows
  checked, even though none of them has to be edited for an ordinary fix.
- **Pilot ONE consumer, and pilot it BEFORE the merge.** Never open the same
  change across the consumers at once. They share one automated reviewer, so a
  finding against a change made nine times is the same finding nine times --
  quota spent to learn nothing, and eight more chances to fix it in only some
  of them. Take one consumer through review, and only copy it out once that
  has settled.
  The pre-merge pilot is THIS repository, which is its own first consumer:
  it installs all three files and `check_consumer.py` holds it to the same
  comparison, so the change is exercised before it can reach anyone else.
  Piloting a second consumer by pointing its caller at the branch does not
  work and should not be attempted -- the caller is pinned byte for byte to a
  template that says `@main`, so a branch reference is reported as drift,
  which is the pin doing its job. A second consumer therefore follows the
  merge, and is where a change gets its first *outside* review.

## Code style

- Preserve the existing style. Comments explain the non-obvious *why*, not the
  *what*.
- **Don't silently swallow errors.** A discarded rejection here means a verdict
  that never publishes and a gate that stalls with nothing to say so. Per-head
  failures are contained and escalate on a streak; a failure to list the open
  pull requests at all is meant to go red.

## Language and spelling

- Use **US English** everywhere read by people: prose, commit subjects and
  bodies, PR titles and descriptions, comments, identifiers — `color` not
  `colour`, `behavior` not `behaviour`, `acknowledgment` not `acknowledgement`.
  Platform and third-party API spellings stay as those APIs spell them.

## Commit messages

- A clear, plain-English subject in sentence case, ≤ ~70 chars, prefix included.
  Mechanism and file:line detail go in the body after a blank line.
- **Prefix a subject that does not change what the action does.** A bare
  subject means a consumer could notice the difference.

  | Prefix | For |
  |---|---|
  | `docs:` | `README.md`, this file, `action.yml` descriptions |
  | `test:` | Tests only, with the code under test unchanged |
  | `build:` | CI, the manifest's runtime, release plumbing |
  | `refactor:` | Code that is deliberately behavior-preserving |

- There is no `feat:` or `fix:`, on purpose: they would prefix nearly everything
  and leave the log as flat as it is now. The prefix marks the exception.

## Privacy

- **Never put user data in any artifact that leaves this machine** — commit
  subjects and bodies, PR text, comments, code comments, test fixtures. Use
  generic placeholders (`o/r`, `abc1234`, `/home/user/project`) as the existing
  fixtures do. When in doubt, ask before pushing.
