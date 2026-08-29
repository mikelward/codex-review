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

- `node --test *.test.js`. No install step — nothing here is packaged — but
  `check-consumers.test.js` runs the sweep, which shells out to the real
  checker, so it needs `python3` with PyYAML too, exactly as
  `check_consumer_test.py` and CI do. Stubbing the checker to avoid that would
  leave the guard tested against a fake of the thing it has to agree with, and
  the script calls `python3` either way, so it would buy no independence worth
  having.
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

## Autopilot

- **A guess made instead of asking goes in `TODO.md`** under *Decisions
  needing review*, naming what was decided, what the alternative was, and what
  undoing it would cost. Autopilot's whole trade is speed for the owner's
  judgment, and an unrecorded guess keeps the speed while quietly spending the
  judgment — it becomes permanent by nobody noticing it happened.

## Releasing

- There is no release step: merging to `main` *is* the release. Changes get
  here through a pull request — the ruleset declines a direct push — so the
  suite has run on them before consumers see them; what is missing is anywhere
  to *pause*, since nothing sits on `main` unpublished.
- The safe direction is the default: a broken sweep leaves `pending`, which
  blocks merges rather than letting anything through, so the worst case is
  every consumer's gate stalling until you revert.
- Seventeen sibling repositories consume this: `clothescast`, `conf`,
  `gedmap`, `gradle-update`, `lanes`, `mesh`, `newshacker`, `npm-update`,
  `readmo`, `root`, `rust-update`, `scripts`, `snoozemo`, `typelauncher`,
  `unixtools`, `vcs`, `web`. A change to the action's inputs, its published
  wording, or `templates/` needs their workflows checked, even though none of
  them has to be edited for an ordinary fix.
- **`simmo` is a sibling, not a consumer, and that is deliberate.** It runs
  the sweep and listener but keeps a no-schedule `codex-review.yml` that
  diverges from `templates/` on purpose: it's a private repo, so the
  canonical hourly cron bills real Actions minutes, and it has chosen not to
  pay that yet. That same billing makes it the **last** repository in any
  fleet-wide migration: every other sibling's CI is free, so simmo is where a
  change is confirmed, never where it is tried. `check_consumer.py`'s byte-for-byte pin can't accommodate the
  divergence, so it isn't in `CONSUMERS` and never adopted
  `codex-review-check.yml`. The trade-off (accept the cost and enroll, or
  keep the customization permanently) is recorded in `simmo`'s own `TODO.md`
  under "Decisions needing review" — not this repository's problem to solve.
- **Changing a `templates/` file is a migration, and it has a mechanism —
  use it.** The pin is byte for byte against `@main`, so an edited template
  mismatches every consumer the instant it merges, while `check-consumers.sh`
  checks real consumer trees against the revision under review — the edit is
  red before it can merge, and the consumers cannot be fixed until it has.
  That deadlock is why `templates/superseded/<label>/` exists: put the
  outgoing files there in the same commit that changes the template, and
  nothing goes red. Consumers then migrate one at a time, each reported by a
  `notice:` line until it moves, and **deleting that label's directory is what
  ends the migration** — leave it and the pin quietly accepts two shapes forever. Only
  ever offer a shape this repository actually shipped; the set is exact
  matches, not a relaxation. A label holds **all three files**, not just the
  one that changed, and is matched whole — storing only the delta would accept
  an old file beside current versions of the others, which is a combination
  nobody shipped and, for the sweep and listener, a broken relay rather than an
  old one. An incomplete label fails the check by name, and so does one whose
  name is not a plain word: the label is quoted into that `notice:` line and
  read back out of it by the sweep, so it starts with a letter or digit and
  holds only letters, digits, `.`, `_` and `-`.
- **Pilot ONE consumer, and pilot it BEFORE the merge.** Never open the same
  change across the consumers at once. They share one automated reviewer, so a
  finding against a change made nine times is the same finding nine times --
  quota spent to learn nothing, and eight more chances to fix it in only some
  of them. Take one consumer through review, and only copy it out once that
  has settled.
  The pre-merge pilot is THIS repository, which is its own first consumer:
  it installs the sweep and the listener, `check_consumer.py` holds them to
  the same comparison, and `scripts/check-consumers.sh` then runs the revision
  under review against every real consumer tree — so a change is exercised
  before it can reach anyone. It does **not** install the caller, and that is
  deliberate rather than an omission: a caller here would name the reusable
  workflow at `@main`, the *released* one, so a pull request changing the
  checker or a template would be validated against the previous release and
  never exercise its own change. `is_hub` exempts it for that reason. What
  covers the caller instead is the suite, which builds a consumer from the
  real templates and runs the whole checker over it, parser included.
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

## Talking to the user

- **Respond to a mid-turn message immediately.** When the user sends a message while you're
  still working — surfaced as a "sent while you were working" interjection — address it in
  your very next output, before starting or continuing any further tool call, even if it's
  only one sentence. Don't let it queue up behind an in-flight chain of tool calls.

## Privacy

- **Never put user data in any artifact that leaves this machine** — commit
  subjects and bodies, PR text, comments, code comments, test fixtures. Use
  generic placeholders (`o/r`, `abc1234`, `/home/user/project`) as the existing
  fixtures do. When in doubt, ask before pushing.
