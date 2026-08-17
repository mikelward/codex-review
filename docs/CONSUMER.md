# Setting up a consumer

Everything a repository needs to gate its merges on Codex's verdict, and the
reasoning behind each setting. This document exists because that reasoning used
to live as a 144-line comment header duplicated in nine repositories, beside a
hand-written test duplicated in four languages. Both have been pulled here.

## The three files

Copy these verbatim. They are identical in every consumer, and
[`check_consumer.py`](../check_consumer.py) compares them byte for byte, so a
consumer that drifts goes red rather than quietly stopping working.

`.github/workflows/codex-review.yml` — the sweep. See
[the README](../README.md#usage) for its contents.

`.github/workflows/codex-review-listener.yml` — the unprivileged relay.

`.github/workflows/codex-review-check.yml` — eight lines that run this check:

```yaml
name: codex-review-check
on:
  push:
  pull_request:
permissions:
  contents: read
jobs:
  check:
    uses: mikelward/codex-review/.github/workflows/check-consumer.yml@main
```

Then set the ruleset — see [Three ruleset settings](#three-ruleset-settings-and-they-are-load-bearing-together)
below. Until you do, the status is published and ignored and these files are
unprotected.

## Why the workflow's shape is what it is

### The triggers, and the two that must never appear

`workflow_dispatch` takes a ref, and GitHub runs the workflow file *from that
ref* — so a branch could ship its own version of a job holding
`statuses: write` and publish `codex: success` for itself. A bare
`pull_request` has the same hole through the merge ref. Pinning the action
version does not help when the branch supplies the job around it.

`pull_request_target` does not have that hole: GitHub takes the definition from
the **base** ref. It is also the only event-driven start available, since
reactions emit no webhook at all — without it, the first push after a quiet
spell waits 10–37 measured minutes for a scheduled fire.

Each type earns its place:

- `synchronize`, `opened`, `ready_for_review` — a new or newly-visible head.
- `reopened` — reuses an unchanged SHA, which may still carry an earlier
  `codex: success`.
- `closed` — clears a shared-head failure the moment a duplicate pull request
  goes away, a webhook-capable, merge-enabling transition.
- `edited` — the **retarget**. Pointing a pull request at a different base
  changes the reviewed diff, sometimes completely, while the head SHA and its
  verdict stand still, and GitHub emits `edited` for that rather than
  `synchronize`.

The comment events (`issue_comment`, `pull_request_review_comment`, both on
`[created, edited]`) cover the round that has no push: a finding rebutted on
the same head plus an `@codex review` nudge changes the verdict with no
`pull_request` event anywhere, and the reactions that follow emit nothing. The
`edited` type is there because a nudge can be edited into an existing comment,
and the sweep dates such an ask by its edit time.

**Those two comment events are NOT base-ref-pinned**, which is easy to assume
and is false: in `mikelward/lanes`, a `pull_request_review_comment` ran the
workflow *from the pull request branch*, with `statuses: write`, while `main`
still held the old version. No guard written in the workflow can close that —
an `if:` on the actor, a narrower `permissions:` block, a step diffing against
`main` are all supplied by the same branch they would constrain.

They stay anyway, and not because the exposure is small. Reaching that route
needs a branch **in the consumer repository**, and anyone who can push one can
publish `codex: success` far more simply with any workflow declaring
`on: push` and `permissions: statuses: write`. Dropping the two events would
close one door in a room with an open wall, while costing the rebuttal round
its minute clock. What would actually bind, the day push access goes to someone
whose merges should not be self-approvable, is holding the credential in an
environment whose deployment-branch policy allows only the default branch, so a
branch's job cannot obtain it at all. Editing the trigger list is not that, and
must not be mistaken for it.

### The listener, and why it is a separate file

Codex sometimes delivers findings as a review with **no inline comments**. That
emits neither comment event and no reaction, so nothing else hears it.

The event is `pull_request_review`, and GitHub resolves its workflow definition
against the pull request's own merge ref. On a file holding `statuses: write`,
a same-repository branch could therefore substitute its own steps. The relay
splits the event from the privilege: the listener declares no permissions and
does one no-op step, and its completion starts the sweep through
`workflow_run`, whose definition GitHub always takes from the default branch.

The relay is a **name match**, so renaming either end severs it in silence.
Both names are pinned.

### Require `codex`. Do not require `sweep`

Four review rounds established this, each finding the same wall from a
different side.

The tempting idea: `codex` is the mark the job leaves and `sweep` is whether
the job ran, so requiring both would close the window where a head already
carrying `codex: success` has its verdict changed with no push — a second pull
request opening on the same commit, or a re-read asked for with
`@codex review` — and the run that would flip the mark dies before writing
anything.

It does not work, because a check run lands wherever its **event** decides
while the verdict is a commit status on a specific SHA:

- `pull_request_target` attaches to the pull request head (verified:
  `mikelward/mesh#522`, run 31945656570), as does
  `pull_request_review_comment` (verified: `mikelward/lanes`, run 31967032933).
- `issue_comment` and `workflow_run` run against the default branch, so their
  checks land there and cannot invalidate anything on the head.

And the part that makes requiring it actively unsafe rather than merely
incomplete: a concurrency group holds **one** pending run.
`cancel-in-progress: false` preserves the run in progress, not the one queued
behind it — so a `pull_request_target` run waiting behind a 55-minute sweep is
canceled and replaced by the next schedule, comment or relay to arrive. That
queueing is ordinary, not rare: observed at 13 minutes on `mesh#522` and 3
minutes on `mikelward/lanes#3`. The replacement reports against the default
branch, leaving the pull request head with a canceled `sweep` or none at all —
a required check in that state blocks the merge with no way to clear it.

This section is worded from evidence because guessing it cost four rounds and
three reversals, each one a single observation generalized. Where a claim here
is not backed by a run someone looked at, it says so.

### The concurrency group and the loop envelope

A concurrency group is a repo-wide namespace, so `group: codex-review` also
serializes against any predecessor still in flight — deleting a workflow file
does not cancel a run of it already looping.

`cancel-in-progress: false`, because a canceled loop is a gate that stopped
sweeping mid-review. `timeout-minutes: 65`, ten past the action's own
55-minute loop, so a hung API call cannot hold the runner — and the concurrency
queue behind it — to the 6-hour job default, stalling the gate silently.

### The schedule is the backstop, not the clock

Events start a run within seconds; the run polls every minute for up to ~55.
Everything the hourly schedule alone catches is rare and fails **closed** — a
dropped webhook leaves the new head pending — and any comment on the pull
request clears those on demand.

It is hourly, off the hour, for two reasons: `:23` dodges the shared
scheduler's `:00` stampede, and on a **private** repository GitHub bills each
job's duration rounded up to a minute, so idle scheduled fires are the term
that scales — hourly is ~720 billed minutes a month against `*/15`'s ~2,900.
Free on a public repository.

### No checkout, one step

The sweep needs nothing from the consumer's tree, and a checkout would put a
token-bearing `.git/config` within reach of a job that can write commit
statuses. The check counts steps rather than asserting a checkout is absent:
"no checkout" is a denylist of one, where "one step" is the property actually
wanted.

### `@main`, not a tag or a SHA

The action has no build step and no dependencies, so the file that runs is the
file you can read, and its repository is first-party. A pin would guard a
capability an attacker has by the time it matters, while costing a pull request
in every consumer to bump — the exact cost sharing the action was meant to
remove. What that gives up is staging, not testing: changes reach `main` here
through a pull request, so the suite has run on them; there is simply nowhere
for a merged change to wait. The failure direction is what keeps it boring — a
broken sweep leaves `pending`, blocking merges rather than opening them.

## Three ruleset settings, and they are load-bearing together

Neither can be expressed in a workflow file.

1. **Require `codex`.** Until you do, the status is published and ignored. Do
   *not* require `sweep` — see above.
1. **Require `codex-review-check`.** This is the check that holds the three
   files above to their templates and proves no other workflow can write the
   `codex` status. Left advisory, it reports a problem that nothing acts on: a
   pull request could edit or delete the pinned workflows — including the one
   that publishes the verdict — and merge with this check red or absent,
   leaving the gate quietly misconfigured. A check nobody requires is a
   comment.
2. **Require branches to be up to date before merging.** Codex's verdict is
   derived from its reaction to the pull request, and the action never reads
   the pull request's base at all. So when the base advances, the reviewed
   merge result changes while the head SHA — and the status hanging off it —
   stand still, and `codex: success` stays standing and stays mergeable. No
   workflow trigger fixes this: a sweep started by a push to the default branch
   would read the same unrevoked 👍 and republish the same `success`.
   Requiring up-to-date branches is what observes the base moving: the pull
   request goes `behind`, updating it pushes a new head, and that revokes the
   reaction, clears the status by absence, and starts a fresh sweep through
   `synchronize`.

Requiring (1) without (2) leaves exactly the window (2) closes, and requiring
either without (3) leaves the files they depend on editable by any pull
request that turns the check red and merges anyway.

## Known open window: a reused head

A pull request opened on a head that already carries `codex: success` from
another pull request inherits that verdict, even though the new pull request
may target a different base and have a different diff. The sweep resets it
within about a minute, but that is an Actions job racing merge eligibility.

The process guard is: **never open a pull request on a commit that already
carried one** — push a commit, or branch from a moving base, so the new pull
request has a head of its own.

The real fix belongs in the action, which already enumerates the open pull
requests it is about to sweep and therefore knows each head: writing `pending`
to those heads before it does any work would invalidate the stale verdict on
every route. A consumer cannot do it without duplicating that enumeration
behind `statuses: write`, and a second status writer is worse than the window —
that configuration existed as a `codex-verdict-reset` workflow and was deleted
for producing unordered writes.

## How the check reads your workflows

[`check_consumer.py`](../check_consumer.py) asks two questions by deliberately
different means.

**Are the three files above exactly the shipped ones?** Compared byte for byte
against `templates/`, with no parsing at all. They are identical in every
consumer, so there is nothing to interpret: the question is not "what does this
file mean" but "is this the file". That is also why the reasoning lives in this
document rather than in a header — a header you could edit is a file that can
drift, and the comparison is exact.

**Can any other workflow write commit statuses?** Your `ci.yml`, `release.yml`
and the rest differ per repository, so they cannot be pinned, and this is the
one place a workflow has to be *understood*. It is parsed with PyYAML.

That parser is the whole reason this check is Python. Eight rounds of review
established that a pattern over YAML is not a reading of YAML — `write-all`, a
`.yaml` filename, `statuses: "write"`, `"pull_request":`, `"permissions":`, a
bare sequence dash, a blank line inside a mapping, and the explicit-key form
(`? permissions` on its own line with `: write-all` beneath it) each got past a
hand-written check. A parser has no such list to keep up to date.

PyYAML rather than an npm package on purpose: `mikelward/codex-review` ships no
dependencies, which is what lets you trust an unpinned `@main` by reading the
files it runs. The runner's Python is not a dependency taken on — it is part of
the image, the way `git` and `bash` are. The cost is that a machine without it
cannot run the check: GitHub's runners all have it, and locally it is one
`python3 -m pip install --user pyyaml`.

**Unrecognized values are reported, not interpreted.** PyYAML implements YAML
1.1, where an unquoted `no` is the boolean false and an unquoted `on` is true,
while GitHub's own parser is closer to 1.2. None of the keys or values this
check reads is ambiguous between the two — `permissions`, `jobs`, and the
levels `read`/`write`/`none` — and anything that comes back as something else
is reported rather than guessed at. So a version quirk becomes a red check, not
a wrong answer.
