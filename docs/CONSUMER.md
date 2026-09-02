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

`.github/workflows/codex-review-check.yml` — nine lines that run this check:

```yaml
name: codex-review-check
on:
  push:
  pull_request_target:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  codex-review-check:
    uses: mikelward/codex-review/.github/workflows/check-consumer.yml@main
```

`pull_request_target` here for the same reason as the sweep, but protecting a
different target: this is the file that verifies nobody edited the pinned
workflows, so it is exactly the file a PR editing them would most want to
neuter. A bare `pull_request` loads the job DEFINITION from the PR's merge
ref — a PR touching `codex-review-check.yml` could replace the call to the
shared reusable workflow with a local job that always succeeds, and merge
past a check that reads green but checked nothing. `pull_request_target`
takes the definition from the default branch, so the workflow that runs is
never the one the PR supplies; `check-consumer.yml` then checks out the PR's
head explicitly to read it as data, which is safe because nothing in the
check executes anything from the tree it reads.

`workflow_dispatch` is there for the pull requests **a bot opens**. A pull
request created by `GITHUB_TOKEN` triggers no `on: pull_request`-family
workflow — GitHub's loop-prevention rule, with no per-repository opt-out short
of a PAT — and that suppresses the branch `push` as well. So on a repository
with an unattended job opening pull requests (a weekly dependency batch, say)
this check would have no run at all on that head, and requiring it would block
those merges forever. Dispatch is the documented exception: a dispatch made
with `GITHUB_TOKEN` *does* create a run. Ask for one against the branch you
just pushed, and its check run lands on the head like any other:

```sh
gh workflow run codex-review-check.yml --ref "$branch"
```

The job doing that needs `actions: write`, and the workflow must carry
`workflow_dispatch` **on your default branch** — a workflow GitHub cannot see
there is not dispatchable, however the branch under test spells it.

Note that the sweep deliberately does **not** take this trigger, and the
difference is the token. Dispatch runs the workflow file *from the given ref*,
so a branch could ship its own version of the job — and the sweep's job holds
`statuses: write`, which is the capability that opens the gate. This caller
holds `contents: read` and nothing else, and its definition is already the
branch's own by way of `push`, so dispatch hands a branch nothing it did not
already have.

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
the **base** ref. It is also the event-driven start for a push, since reactions
emit no webhook at all — without it, the first push after a quiet spell waits
for a scheduled fire, which on the four-hourly backstop is up to four hours
rather than the 10–37 measured minutes a throttled hourly cron used to give.

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
Codex also edits its review summary comment in place as a review starts and
finishes, and that edit is an `issue_comment` the sweep wakes on — so even a
verdict that emits no reaction of its own usually announces itself. Everything
the schedule alone catches is rare and fails **closed** — a dropped webhook
leaves the new head pending — and any comment on the pull request clears those
on demand.

It is four-hourly, off the hour, for two reasons: `:23` dodges the shared
scheduler's `:00` stampede, and on a **private** repository GitHub bills each
job's duration rounded up to a minute, so idle scheduled fires are the term
that scales. An idle fire is about a minute — the loop exits as soon as nothing
is awaiting — so `23 */4 * * *` is ~180 billed minutes a month, against
hourly's ~720 and `*/15`'s ~2,900. Free on a public repository.

The cost of the wider spacing is latency on the rare thing no event reports:
worst case the backstop is ~4 hours away rather than ~1. That is the trade the
cadence makes deliberately, and it is what brings a private repository inside
the byte-for-byte pin instead of leaving it on a hand-maintained copy.

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
1. **Require `codex-review-check / codex-review-check`.** GitHub reports a
   reusable-workflow job's status under `<calling job> / <called job>`, and
   both halves are named `codex-review-check` for exactly this reason —
   search "codex-review-check" in the required-checks box and there is one
   match, not a generic `check` that could be any workflow's job. It only
   appears in that search once the workflow has reported at least once, so
   run it (push, or open a pull request) before adding it. This is the check
   that holds the three files above to their templates and proves no other
   workflow can write the `codex` status. Left advisory, it reports a problem
   that nothing acts on: a pull request could edit or delete the pinned
   workflows — including the one that publishes the verdict — and merge with
   this check red or absent, leaving the gate quietly misconfigured. A check
   nobody requires is a comment.
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

## Known limitation: fork pull requests and `codex-review-check`

`codex-review-check` reports against the pull request head through its
**`push`** trigger, which fires when the branch is pushed to this repository.
A fork's push happens in the fork, so it creates no check run here; and
`pull_request_target`, which does run here, is documented to set `GITHUB_SHA`
to the base branch tip rather than the head. So a fork pull request can end up
with no `codex-review-check / codex-review-check` on its head at all — and if
you have made that check required, such a pull request is blocked by a check
that can never report. A required check a whole class of pull request cannot
satisfy is worse than the hole it closes.

**This is recorded rather than fixed, deliberately.** It is unconfirmed: no
fork pull request has been observed against these repositories, and the
same-repo evidence points the other way — the sweep's own `pull_request_target`
run carries the pull request head as its `head_sha`, though a same-repo head
branch exists here in a way a fork's does not. Every repository consuming this
today takes same-repo pull requests only, where the `push` trigger covers it.

**The remedy, when a fork pull request matters:** have
`check-consumer.yml` publish its result as a check run against
`github.event.pull_request.head.sha || github.sha` explicitly, the way the sweep already
targets `pr.headRefOid` for the `codex` status — which is why *that* one is
head-associated whatever the trigger. Use **`checks: write`** on the caller,
not `statuses: write`: the sole-writer rule below is about the statuses scope,
and a second holder of it could overwrite the `codex` verdict, so borrowing a
different scope keeps that invariant untouched.

**Both ends need the scope, and this is the part that would waste an
afternoon.** A reusable workflow's own `permissions:` block can only *narrow*
what the caller passes, never widen it — so `check-consumer.yml`, which today
declares `contents: read` and nothing else, would silently strip `checks:
write` back off however generously the caller granted it. The Checks API call
then fails and the newly required check never reports, which is the same
unsatisfiable-required-check failure this whole section is about. Grant it in
**both** files.

`check_consumer.py` lets the caller through unchanged: `judge` reads what a
value *grants* and objects only to `statuses: write`, so `checks: write`
already reads as safe, and the byte-for-byte pin compares against whatever
`templates/` says. Do not "make room" for it by loosening the permission scan —
nothing is in the caller's way.

**But the scan has to get *stricter* about everyone else, and this is the part
that turns the remedy into a hole if it is skipped.** The moment consumers
require a *self-published* `codex-review-check` instead of the
reusable-workflow context, that name becomes something any workflow holding
`checks: write` can create — and a `push` workflow's definition comes from the
branch (see the section below). A contributor could add a workflow granting
itself `checks: write` and publish a passing `codex-review-check` on its own
SHA, satisfying the gate while the real checker rejects the edit that put it
there. Today `checks: write` is harmless because nothing required depends on
it; the remedy is what makes it a forging capability. So implementing this
means extending the scan to reserve `checks: write` for the pinned checker
caller and reject it in every other workflow, exactly as it already reserves
`statuses: write` for the sweep.

Consumers would then require
the self-published `codex-review-check` rather than the reusable-workflow
context `codex-review-check / codex-review-check`, which is a ruleset edit in
each of them — cheapest while few consumers require it.

**That is half the gate, and the other half is deliberate.** A fork pull
request would still fail the required `codex` status, for an unrelated reason
of its own: the sweep dates a head's arrival on its branch from the head's
check suites, and GitHub reports `head_branch: null` for a fork head's suites,
so a fork head is undatable forever and `judge` fails it closed — a fork's 👍
never opens the gate, however fresh. That floor is what stops the previous
head's lingering 👍 approving a commit nobody reviewed on a fast-forward, and
an earlier exemption that fell back to the status bound was a fail-open hole
wearing a compatibility excuse, so it is not a line to delete on the way past.
Doing this remedy alone therefore removes one unsatisfiable required check and
leaves the other standing: fork contributions still merge by admin override or
by re-pushing to a same-repo branch, where every floor applies. Anyone taking
fork support seriously needs both changes, and the `codex` one first, since it
is the one with a way to get the answer wrong.

**Do not fix it with a plain `pull_request` trigger.** That loads the job
definition from the pull request's merge ref, so a fork could replace the call
to the shared reusable workflow with a job of the same name that always
succeeds — defeating, for fork pull requests specifically, the check whose
entire purpose is to detect exactly that edit.

## Known limitation: the head's `codex-review-check` is branch-defined

The same mechanism as above, seen from the other side, and it is the sharper
of the two because it applies to the same-repository pull requests these
repositories actually take.

`codex-review-check.yml` has three triggers, and only one of them is trusted.
`pull_request_target` takes its definition from the default branch — but it
does not report on the pull request's head, so it cannot satisfy the required
context there. The two runs that *do* land on the head are **`push`** and
**`workflow_dispatch`**, and both take the workflow definition from the branch:
the pull request's own. Verified rather than reasoned about — on
`mikelward/root#44`, the check run carrying the head SHA belongs to a run with
`event: push` and `path: .github/workflows/codex-review-check.yml`.

`workflow_dispatch` is the newer of the two and it is the one a bot-authored
pull request relies on (see [the caller](#the-three-files) above), so on those
repositories it is the *only* route to a head-associated run. It is no weaker
than `push` and no stronger: a dispatch names a ref and GitHub runs that ref's
copy of the file, which is exactly what `push` already does. Adding it widened
nothing — but it does mean "the head's check comes from `push`" is no longer
the whole story, and a reader checking provenance should expect either.

So a same-repository pull request can edit that file to declare a job named
`codex-review-check` calling something other than the shared checker, and the
required context `codex-review-check / codex-review-check` reports green on
the head having checked nothing. The context is two names — the caller's job
and the called workflow's job — but both are the pull request's to choose.
`check_consumer.py` would catch the edit if it ran; the point is that this
route is how it does not run.

**The obvious remedy is not available to these repositories.** GitHub can
require a *workflow* rather than a status context, pinned to a repository and
ref — `mikelward/codex-review/.github/workflows/check-consumer.yml@main` under
**Require workflows to pass before merging** — and that would evaluate code the
pull request cannot supply, which is exactly what the required status context
cannot promise. But that rule exists only in **organization** rulesets, and
these nine repositories are on a personal account. So it is the answer if they
ever move to an organization, and no answer at all today.

**The remedy that is available is to move the check inside the sweep.** The
sweep already runs from `pull_request_target` and `schedule` — both
default-branch-defined, so never the pull request's to rewrite — and it already
holds `statuses: write` as the sole writer of a required status. Having it run
the consumer comparison itself, and fold a mismatch into the `codex` verdict,
puts the check behind a gate a branch cannot forge, with no new scope and no
new required context anywhere. That is a real change to the action rather than
a configuration edit, so it is written down here rather than done.

Until one of those happens, treat `codex-review-check` as verification against
**accident** rather than against a motivated edit: it catches drift, a bad
copy, a half-finished conversion, which is most of what actually goes wrong.
The `codex` status is unaffected either way, for the same reason the second
remedy works — the sweep's definition comes from the default branch, so the
verdict gate itself is never the pull request's to rewrite.

## How the check reads your workflows

[`check_consumer.py`](../check_consumer.py) asks two questions by deliberately
different means.

**Are the three files above exactly the shipped ones?** Compared byte for byte
against `templates/`, with no parsing at all. They are identical in every
consumer, so there is nothing to interpret: the question is not "what does this
file mean" but "is this the file". That is also why the reasoning lives in this
document rather than in a header — a header you could edit is a file that can
drift, and the comparison is exact.

### When a template changes: `notice:` is your cue, not an error

"The shipped ones" is a small **set**, not one file, and that is what lets a
template change reach you without breaking you.

The pin compares against `templates/` at `@main`, and you track `@main` — so a
template edit would mismatch every consumer at the instant it merged, all of
them red at once through no change of their own. Instead, the edit puts the
outgoing file in `templates/superseded/<label>/` in the same commit. Your
unchanged repository still matches something exact, so your check stays green
and you get a line like:

```
notice: codex-review-check.yml matches the superseded shape `push-only` rather
than the current template — migrate it by copying templates/ from
mikelward/codex-review; the shape is accepted only until the last consumer has
moved
```

That is the whole protocol: **green, with a standing reminder.** Copy the three
files from `templates/` when it suits you and the notice goes away. It is a
notice rather than an error because a repository mid-migration is correct — it
just has not moved yet — and it is printed rather than silent because a
migration nobody can see is how "accepted for now" becomes permanent.

Three things it is not. It is not a relaxation: every accepted shape is still an
exact match against files in this repository, so a locally edited workflow fails
exactly as before. It is not per-file, either — a shape is **all three files as
they were shipped together**, and matched as one, so holding an old file beside
current versions of the others is refused however genuine each half is. That
matters for these three in particular: the sweep names the listener in its
`workflow_run` trigger, so a mixed pair is broken rather than merely old. And it
is not open-ended — the superseded directory is deleted once the last consumer
has moved, and from then on that shape is an error like any other drift. So a
notice is worth acting on rather than living with.

**Can any other workflow write commit statuses?** Your `ci.yml`, `release.yml`
and the rest differ per repository, so they cannot be pinned, and this is the
one place a workflow has to be *understood*. It is parsed with PyYAML.

The rule guards the `codex` **context**, not the scope for its own sake, so it
carries exactly one shape-checked excuse: a job-level `statuses: write` is
allowed when the job consists of nothing but `mikelward/lanes@main` (plus an
`actions/checkout` it reads `.github/lanes.conf` from) — the fleet's
trusted-verdicts publisher (`init`/`finalize` in a consumer riding that
design), whose engine hard-codes its status context to `lanes` and so cannot
touch `codex`. The judgment is fail-closed, by whitelist: the job and its
steps may carry only a small recognized key set, so a `run:` step, any other
action, the engine at any ref but `@main`, a `container:`/`services:` image,
a job that never actually runs the engine, and above all an `env:` block at
any level — step, job, or workflow-wide, since `NODE_OPTIONS: --require`
there makes the action's own process load repository-controlled code — all
collapse the excuse back to a finding, as does any key the whitelist has
never heard of, and so does a `runs-on` naming anything but an exact
GitHub-hosted runner label — a self-hosted runner is a machine whatever
else already runs there can read the grant's token from, whatever the
job's own steps declare. The moment anything else can execute inside the
granted job, or the granted job runs somewhere else already has code on
it, the grant is reachable by code this check cannot vouch for. A
top-level `statuses: write` is never excused; it governs every job in the
file at once.

**This leaves one gap open, not closed, flagged by review**: a self-hosted
runner can register under any label, including the exact GitHub-hosted
strings this check trusts, and whether a given `runs-on:` in the file
resolves to GitHub's own machine or to a same-named self-hosted one is an
account-configuration fact — nothing in the workflow text distinguishes
them, and this check parses text only, calling no API to list what runners
your account actually has. **Adopting the lanes publisher pattern carries
an unstated prerequisite this check cannot verify: your repository, and
any organization supplying its runners, must hold no self-hosted runner
labeled `ubuntu-latest` or any of the other strings in `PUBLISHER_RUNNERS`.**
That is yours to hold, not something a green check here can attest to.


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
