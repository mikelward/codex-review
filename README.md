# codex-review

A GitHub Action that republishes [Codex](https://chatgpt.com/codex)'s review
verdict as a `codex` commit status, so branch protection can require it.

## Why this exists

Codex posts no check run, and its clean pass is only a 👍 reaction on the pull
request body — which emits no webhook. The verdict is therefore both invisible
to a protection rule and undeliverable by event, so auto-merge fires on green CI
*before* Codex has looked. A pull request merged too early is indistinguishable
afterwards from one merged correctly.

This action polls for the reaction and writes it to a commit status a ruleset
can name.

## Usage

Add this workflow. Everything in it outside the `uses:` line is deliberate —
see [Why the workflow lives in your repo](#why-the-workflow-lives-in-your-repo).

```yaml
# Republishes Codex's review verdict as the `codex` commit status a ruleset
# can require. Codex posts no check run, and a clean pass is only a reaction
# on the pull request body -- which emits no webhook -- so this polls rather
# than reacting to an event.
#
# Every line below is deliberate, and each wrong setting produces no error at
# all -- just a merge gate that quietly stops working, or one that can never
# clear. The reasoning is in docs/CONSUMER.md of mikelward/codex-review, not
# repeated here: it used to be a 144-line header duplicated in nine
# repositories, which is how it went stale in six of them.
#
# REQUIRE `codex`. DO NOT REQUIRE `sweep`, and require branches up to date.
# Both are explained there, and both are load-bearing.
#
# check_consumer.py compares this file byte for byte, so an edit here fails until
# it is re-approved centrally.
name: codex-review
on:
  schedule:
    - cron: '23 * * * *'
  pull_request_target:
    types: [opened, reopened, ready_for_review, synchronize, edited, closed]
  issue_comment:
    types: [created, edited]
  pull_request_review_comment:
    types: [created, edited]
  workflow_run:
    workflows: [codex-review-listener]
    types: [completed]
permissions:
  contents: read
  pull-requests: read
  checks: read
  statuses: write
concurrency:
  group: codex-review
  cancel-in-progress: false
jobs:
  sweep:
    runs-on: ubuntu-latest
    timeout-minutes: 65
    steps:
      - uses: mikelward/codex-review@main
```

And alongside it, as `codex-review-listener.yml`, the unprivileged half:

```yaml
# Hears the one verdict delivery the sweep's own triggers cannot safely hear:
# a review with no inline comments, which emits neither comment event and no
# reaction. `pull_request_review` is a merge-ref event, so it must never
# appear on a workflow that can write commit statuses; this one holds nothing
# and relays through `workflow_run`. See docs/CONSUMER.md.
name: codex-review-listener
on:
  pull_request_review:
    types: [submitted, edited, dismissed]
permissions: {}
jobs:
  heard:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: 'true'
```

And, as `codex-review-check.yml`, the nine lines that verify all three stay
correct. Everything it knows lives in
[`check_consumer.py`](check_consumer.py) here, so a fix reaches every
consumer at once instead of being hand-carried into nine repositories in four
languages -- which is what the hand-written copies it replaced cost:

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

Why each setting is what it is -- the two triggers that must never appear, why
the relay is a separate file, why `sweep` must not be a required check, and the
three ruleset settings that are load-bearing together -- is in
[docs/CONSUMER.md](docs/CONSUMER.md).

Then add `codex` to the required status checks for your default branch. Until
you do, the status is published and ignored.

The listener exists for the delivery form the sweep's other events miss:
findings submitted as a review with **no inline comments** emit neither
comment event, and an edited or dismissed review changes what a sweep should
read. It is a separate workflow because `pull_request_review` resolves the
workflow definition against the pull request's merge ref — on a workflow with
`statuses: write`, a same-repository pull request could substitute its own
steps and publish `codex: success` for itself. The relay splits the event
from the privilege: the sweep that can write statuses runs only
default-branch definitions (`workflow_run` is documented to). The relay also
fixes the fork case for free — a fork's `pull_request_review` run gets a
read-only token whatever the file declares, so a direct trigger could not
have published anyway, while the `workflow_run` half runs in the base
repository with the full grant.

Be precise about what that buys, because the listener's `permissions: {}` is
not it. A same-repository branch can edit the listener — or add any workflow
of its own — and grant itself `statuses: write` directly; no YAML in this
repository can prevent that, because the grant lives in branch-editable
files. That attacker is the one the earlier note already priced in: push
access to this repository has always been able to publish the status with an
ordinary `on: push` workflow, so the listener adds no exposure that was not
already there. The bright line the relay preserves is reviewable and narrow:
**no merge-ref event ever appears on the workflow that writes statuses**, so
substituting the sweep's own definition — the quiet route — stays closed,
and the trigger lists that decide it stay in files a reviewer of the default
branch can read.

On a private repository, consider dropping the `schedule` block — each idle
fire bills a rounded-up minute (~720/month at hourly). What it costs you: on
the **approval** side nothing but latency, since everything the cron backstops
there is fail-closed and any comment or push clears it on demand. On the
**hold** side, be honest about what the cron never bought: once a sweep
publishes `success`, auto-merge can fire within seconds, so a 👀 or 👎 placed
*after* the verdict was never a reliable stop with or without a schedule — the
cron only narrowed the corner where something else (CI still running) happened
to be blocking when the hold landed, and dropping it widens that corner to
indefinite. A hold placed *before* the verdict is honored either way, because
the sweep that reads the verdict reads the hold too. The reliable stop is the
one the section below already names: convert the pull request to a draft,
which disables auto-merge instantly and needs no sweep.

No `with:` block is needed: the token and repository default to the calling
workflow's own. `loop-minutes` and `interval-seconds` are the two knobs, and
[`action.yml`](action.yml) documents what moving them costs.

## How the verdict is read

The reaction is the usual verdict. Codex comments when it has suggestions and
reacts 👍 when it does not, and it revokes the reaction when a new commit
lands — so a reaction that is present belongs to the head being looked at, and
nothing has to compare SHAs to establish that.

**A clean comment is the second approval channel**, because Codex does not
always keep that promise: it sometimes posts `Didn't find any major issues`
as a comment and leaves the body unreacted — and on one pull request it put
the 👍 on the comment that nudged it, where nothing reads it. Such a comment
approves only when it names the commit it read and that commit is this head,
which is the same attributable standard a review is held to, and only when it
is Codex's latest word: findings landing after it take precedence, since a
comment is a fixed point in time where a reaction is re-added after a re-read.
A clean comment naming some other commit decides nothing at all.

So a `success` with no reaction on the body is expected, not a fault — read
the comments before reporting the gate broken.

Approval also requires no 👀 and no 👎 from the repository owner, and no owner
`@codex review` newer than the 👍. That makes a hold two seconds of work from a
phone, which matters because without one, auto-merge can land a pull request
before somebody who wanted a look gets one.

A hold takes effect within a sweep, **not** immediately — reactions emit no
webhook, so nothing can notice one as it lands. **To stop a merge right now,
convert the pull request to a draft:** GitHub disables auto-merge on drafts the
moment you do, and this action returns no verdict for a draft, so nothing here
fights you.

Human review threads are deliberately not modeled. GitHub's *require
conversation resolution* setting does that natively, and better.

**Reading the verdict is a protocol, not a glance.** The reaction is only the
CLEAN channel: findings arrive as review comments, as top-level comments, or
as reviews, and none of those move the reaction count — so "no reaction yet"
and "unread findings waiting" are indistinguishable from the pull request
body, and a PR whose `updated_at` moved without a reaction usually means the
second. Anyone — agent or person — reporting this gate's state reads all of
it, every time: the PR-body reactions, the reviews, the review comments and
the issue comments to their last pages, and, where a ruleset requires it, the
`codex` **commit status** itself, which is a separate API surface from check
runs and never appears among them. A state report assembled from fewer
sources than that is a guess, and this file is the standing instruction not
to make one.

## The ruleset this expects

The status is only as strong as the rules that require it. The recommended
consumer configuration, in the repository's rules for its default branch:

- **Require the `codex` status check** — the reason this action exists, since
  nothing else makes the verdict blocking.
- **Require conversation resolution.** GitHub evaluates it at merge time,
  with no polling and no staleness window, which makes it strictly more
  reliable than anything reaction-based — and it covers human review threads,
  which this action deliberately does not model.
- **Allow auto-merge**, so a pull request lands the moment its verdict does.
  This repository setting only *permits* auto-merge; it merges nothing by
  itself. Auto-merge is armed on each pull request individually — the
  "Enable auto-merge" button, `gh pr merge --auto`, or the API — and a PR
  nobody armed sits open looking approved, indefinitely. Arming requires
  merge access, so for an external contributor's pull request it is a
  maintainer (or their automation) who arms it, not the author; an armed one
  still waits for every required check and every unresolved conversation.

With conversation resolution on, the dependable **hold** is a review thread
("hold — I want a look at this first"): it blocks natively until resolved.
Converting to draft stops auto-merge instantly. The 👀/👎 reaction holds stay
honored by the sweep as best effort — on a repository without the resolution
rule they are better than nothing — but once `success` publishes, auto-merge
can fire within seconds, so a reaction placed after the verdict was never a
reliable stop and is not one here.

## What the gate does not defend against

Three limits worth knowing before treating the status as adversarially
robust review:

- **The ground truth is Codex reading author-controlled content.** The
  sweep is strict about *attribution* — only Codex's own reactions,
  reviews, and clean comments count, ordered by server timestamps — but
  everything Codex reads (title, body, diff, file contents) is written by
  the pull request's author, instructions to the reviewer included. If
  Codex is talked into reacting 👍 or posting a clean verdict, the result
  is genuine — correctly attributed, correctly timestamped — and publishes
  `success` exactly as designed. The gate guarantees fidelity to Codex's
  answer, not that the answer resisted manipulation; human review and the
  rest of the ruleset are the coverage for that.
- **Holds and nudges assume a personal account.** A 👎/👀 hold and an
  `@codex review` nudge count only from the repository *owner* — the first
  segment of `owner/name`. On an organization-owned repository no human's
  login equals that segment, so holds and nudges silently never register:
  nothing goes red, and a standing `success` stays mergeable. The twelve
  current consumers are personal repos; an org adoption needs this rethought
  (repo admins instead of the owner segment) before the reactions mean
  anything.
- **A shared head fails closed, and an outsider can share yours.** The
  status belongs to the commit, so two open pull requests carrying the same
  head are ambiguous and publish `failure` — including when the other PR is
  a fork's, which any account can open against a public head SHA. That is a
  zero-privilege way to hold a PR at `failure`, accepted deliberately: the
  fork PR would inherit the same commit's status, so approving through the
  ambiguity is the fail-open direction. The remedy is closing the intruding
  PR — the `closed` trigger resweeps within seconds.

## Why the workflow lives in your repo

The action is the sweep. The workflow around it is a security boundary, and it
stays where a reviewer of *your* repository can see it.

The job holds `statuses: write`, and several triggers would let a pull request
branch supply its own version of the steps that hold that token and publish
`codex: success` for itself. `workflow_dispatch` takes a ref and GitHub runs the
workflow file *from that ref*; plain `pull_request` takes its definition from
the merge ref. Neither is in the list above, deliberately. Pinning the checkout
does not help when the branch supplies the steps around it, which is why the fix
is the trigger list rather than a `ref:`.

**Treat the comment events as unverified rather than base-ref-pinned.** GitHub
documents `issue_comment` and `pull_request_review_comment` as default-branch
events — `GITHUB_REF` and `GITHUB_SHA` both point at the default branch — which
would mean a pull request cannot supply the definition through either. Against
that, a `pull_request_review_comment` in one consuming repository was observed
starting a run whose recorded workflow path was a file that existed only on the
pull request's branch, failing on an action reference that appeared nowhere on
the default branch. Whatever the mechanism, what executed there was not the base
version.

It does not change what you should do, which is why this is a note rather than
a warning. **Reaching that route needs a branch in this repository** — a fork
cannot, because a fork's workflow files are not in your repository for any of
these events to run — and anyone who can push such a branch can publish the
status far more simply, with any `on: push` workflow declaring
`permissions: statuses: write`, which unambiguously runs the branch's own
definition. So dropping the comment events buys little either way. If you need
to bind this against collaborators, the fix is a credential held out of their
reach — see [Binding the status against
collaborators](#binding-the-status-against-collaborators); editing the trigger
list is not that.

Do not read any of this as "fork pull requests get a weak token."
`pull_request_target` runs in the **base** repository's context and its
`GITHUB_TOKEN` carries whatever the workflow asks for — `statuses: write`
here — for fork pull requests as much as for any other. What protects you is
that the *definition* comes from the base ref, not that the token is small. It
matters because the two arguments fail differently: if you ever add a step that
checks out or executes the pull request's code, the base-ref protection is gone
and the writable token is right there.

Keeping the trigger list in your repository means the declarations that decide
who can write the status are reviewed alongside your code, not vendored out of
sight.

Make this sweep the **only** writer of the `codex` status. A second writer is an
unordered write, and one delayed past this run's exit overwrites a
just-published `success` with nothing left to notice.

## Binding the status against collaborators

Everything above prices in one assumption: anyone with push access to your
repository can already publish the `codex` status, because workflow
permissions live in branch-editable files — any branch can add an `on: push`
workflow granting itself `statuses: write` and publish `codex: success`
directly. While the only writer is the repository owner, that is not a hole:
the gate exists to stop accidents (auto-merge firing before the review
lands), not to defend the owner against themselves. Fork contributors were
never inside this line — their runs hold a read-only token whatever the YAML
declares.

The assumption breaks the day someone gains push access whose merges should
not be self-approvable. No edit to any workflow file restores the boundary,
because the forgery route is a workflow the collaborator adds themselves.
What restores it is making the verdict something only a credential can
publish, and holding that credential where branch code can never reach it:

1. **Create a GitHub App** that you alone administer, with commit statuses
   read-and-write as its only repository permission, and install it on the
   repository. The App is the publisher's identity: statuses minted with its
   installation token are attributed to the App, while `GITHUB_TOKEN`
   statuses are attributed to GitHub Actions — no grant a collaborator's
   workflow gives itself can change whose name a status carries.
2. **Hold the App's private key as an environment secret**, not a repository
   secret. A repository secret is released to a workflow on any branch the
   moment a job names it; an environment secret is released only to jobs
   that declare the environment and pass its protection rules.
3. **Restrict the environment's deployment branch policy to the default
   branch.** A job on a topic branch that declares the environment is
   refused the secret before its first step runs. The sweep still
   qualifies: its triggers (`pull_request_target`, `workflow_run`,
   `schedule`) all run against the base or default branch ref, not the
   topic branch.
4. **Point the sweep at the App token**: declare the environment on the
   sweep job, mint an installation token in a step before the action
   (GitHub's own `actions/create-github-app-token` does this from the App
   ID and key), pass it as this action's `token` input, and drop
   `statuses: write` from the workflow's `permissions` block — the
   workflow's own token no longer needs to write anything.
5. **In the ruleset, require the `codex` status from that App
   specifically**, not from any source. This is the step that closes the
   door; the previous four only make it possible.

**Relay the comment triggers first — this step is load-bearing, not
optional.** The sweep as templated above subscribes to `issue_comment` and
`pull_request_review_comment`, and the section above records that one of
those was observed running a workflow file that existed only on a pull
request's branch while reporting the default branch as its ref. That is
tolerable today, because the branch could publish the status directly
anyway. It stops being tolerable the moment this job can read an App key:
a deployment-branch policy authorizes by the ref the run reports, so a
collaborator's branch would supply its own steps, pass the policy on the
default branch's name, and be handed the private key — turning the
credential from a boundary into an exfiltration target, and the resulting
forgery would carry the App's own attribution. So before adding the
secret, move both comment events onto the unprivileged listener and relay
them through `workflow_run` exactly as `pull_request_review` already is,
or drop them (the schedule and `pull_request_target` still cover every
verdict, a cron interval later). The rule the credential depends on is
absolute: **nothing but `workflow_run`, `schedule`, and
`pull_request_target` may trigger the job that can read the key.**

Prerequisites, stated honestly. Environments with deployment branch
policies and environment secrets are free on public repositories but need a
paid plan on private ones. The boundary holds against collaborators with
*write*, not *admin* — an admin can edit the ruleset, the environment, and
the App installation, so anyone you would not trust to publish the status
must not hold admin. And the credential changes only *who can publish*: the
job holding the App token must still run nothing but default-branch
definitions and must never check out or execute pull-request code, or the
trigger-list discipline above is what you have lost.

Until that day, skip all of this. A single-writer repository gains nothing
from it but setup and a second credential to rotate.

## Versioning

There is none: consumers track `@main`, and whatever `main` points at is what
they run. That is the feature — a fix reaches every consumer without a pull
request in each one — and pinning a SHA would defend against an action author
who is someone else, which here is the same account that can already push to
the consumer's default branch.

**What a tag would add is a staging step, not a testing one.** Changes reach
`main` through a pull request like anywhere else, so consumers are not running
code the suite has never seen. What they do get is every merge, immediately: a
tag is a second pointer you move on purpose, so a change can land on `main` and
wait. Without one there is nowhere to wait — no holding a merged change back
while you think, no publishing several together. If that ever matters, add a
tag and pay the step on every change; until it does, the merge is the release.

The residual either way: a merge produces a new commit (rebased or squashed)
that this repository's own `push` run then tests, so for those couple of
minutes consumers are on a commit whose exact form has been tested as a branch
rather than as itself. What keeps that boring is the failure direction — a
broken sweep leaves `pending`, which blocks merges rather than letting anything
through, so the bad case is a stalled gate that a revert clears, not a forged
verdict.

Two things consumers' branch protection depends on, which must not change
without a migration in every consumer: the status context stays `codex`, and a
caller with no `with:` block keeps working. Both are pinned by tests.

## No dependencies, on purpose

There is no `package.json`, no lockfile and no build step. The file the runner
executes is the file in this repository, so what consumers run can be reviewed
by reading it — nothing is generated in between that could differ from
its source. A test enforces this.

## License

MIT.
