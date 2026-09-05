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
# on the pull request body -- which emits no webhook -- so a verdict can
# arrive with nothing to announce it.
#
# The event triggers below carry almost all of it: Codex edits its review
# summary comment in place as a review starts and finishes, and an edit is a
# comment event the listener relays here. The schedule is the backstop
# for what no event reports -- a verdict Codex never delivers, a run that
# never picked a push up -- so it runs every four hours rather than hourly.
# On a private repository each firing is billed by the minute, and a backstop
# that fires 24 times a day to find nothing is the cost with none of the
# benefit. The `:23` is deliberate: it dodges the on-the-hour stampede that
# makes a runner queue.
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
    - cron: '23 */4 * * *'
  pull_request_target:
    types: [opened, reopened, ready_for_review, synchronize, edited, closed]
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
# Hears the verdict deliveries the sweep's own triggers cannot safely hear,
# and relays them to it: a review with no inline comments (which emits neither
# comment event and no reaction), and every comment on a pull request.
#
# All three events resolve their workflow definition against a ref a pull
# request branch can control, so none of them may appear on a file that holds
# a credential or `statuses: write`. This one holds neither -- no permissions
# and one no-op step -- so a branch substituting its own steps here gets a
# runner and nothing else. The sweep starts from this file's completion
# through `workflow_run`, whose definition GitHub always takes from the
# default branch. See docs/CONSUMER.md.
#
# The relay is a NAME match, so renaming either end severs it in silence.
name: codex-review-listener
on:
  pull_request_review:
    types: [submitted, edited, dismissed]
  issue_comment:
    types: [created, edited]
  pull_request_review_comment:
    types: [created, edited]
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

On a private repository the `schedule` block is cheap enough to keep: each idle
fire bills a rounded-up minute, and four-hourly is ~180/month. Dropping it is
still supported, and this used to be the recommendation when the cadence was
hourly (~720/month) — but a hand-maintained copy is how a consumer's triggers
drift without the pin noticing, so prefer paying the ~180. What dropping it
costs you: on
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

## Carrying the verdict across a generated push

Some workflows write their own output back onto the branch — a screenshot
job re-records its baselines and a downstream job commits the drift. That
commit is a push, so Codex revokes its 👍 and re-reads a diff that changed
by nothing it can read, and the gate waits for that re-read. The
[lanes engine](https://github.com/mikelward/lanes)'s **generated lane**
already settles the other half of that push: when a `synchronize` adds
only files a `generated` rule names, made by an administrator or the App
itself onto a head the App had vouched for, it publishes its green on the
new head with a description naming the head it carried from.

This action inherits Codex's verdict along the same claim. On a head whose
newest `lanes-attest` or `lanes` status is that carried green, the sweep
checks two things and publishes `Codex reviewed <sha>; verdict carried
across generated files`:

- **The claim is the engine's.** The status's creator must be an App —
  never `github-actions[bot]`, which is the token any pull request's own
  workflow holds — and, where the base branch's rules bind `lanes` to one
  App, that App exactly (the ruleset names an integration id; the App's
  public record joins it to the bot login). Where the rules bind `lanes` to
  no App, no claim is trusted: any workflow holding `statuses: write` could
  post one, so the carry is opt-in per repository — bind the required
  `lanes` check to the App in the ruleset, and it starts carrying there.
- **The named head is this pull request's, and so is its verdict.** A
  status belongs to the commit, and a commit can have been another pull
  request's head first, so the named head must be one of this pull
  request's own commits, its `codex: success` must postdate the pull
  request's creation and its latest retarget and predate the claim itself
  (a claim vouches for the verdict that existed when the engine carried
  it, not one earned on the same commit later), and a check suite born on
  this pull request's own branch must record the named head reaching it
  before the approval was written — the same server-stamped record the
  sweep dates every head's arrival by, floored at the branch's last
  force-push as that dating is and at the pull request's opening, and one
  a fork head never has. And the verdict must say it was earned **by this
  pull request**: every `codex: success` this action writes carries the
  number of the pull request it judged, and it only ever writes on that
  pull request's own head — so a success naming this number on the named
  head is the record that the named head was this pull request's head when
  the verdict was written. Nothing derived from timestamps could establish
  that: a check suite is born some time *after* the push it belongs to, so
  a verdict another pull request earned on the source inside that delay
  passed every ordering test. A status written before this stamp existed
  names no pull request and refuses, which the next verdict on that head
  clears. Where
  the rules bind `codex` itself to an App, the named head's `codex` status
  must be that App's: any other writer's is one branch protection would
  have refused, and carrying it would republish it under this action's
  own name.
- **Codex had approved the named head, and nothing has moved since.** Its
  newest `codex` status must be `success`, and from that status onward no
  finding on that head, no Codex comment on the pull request, and no owner
  `@codex review` may stand unanswered — a clean verdict naming that head,
  newer than all three, answers them, since the status itself does not move
  when Codex re-reads and passes — a finding or a re-review ask that
  landed between the last sweep and the push does not ride, and one in the
  status's own second is a tie, which refuses as ties do everywhere here. A claim posted
  before the pull request's latest retarget is refused too: the head stood
  still through it while the reviewed diff changed.

A carried verdict outranks a read in progress — Codex re-reading rendered
images is the revocation this exists to survive — but not findings Codex
leaves on the new head, an owner's `@codex review`, a hold, or a shared head,
each of which is about *this* head. Every refusal is logged with its reason
and the head takes the ordinary path, waiting for Codex's own answer exactly
as before. The reads it adds — the base's rules, the App's record, the named
head's combined status and the pull request's reviews — are paid only on a
head carrying a claim, and the first two once per sweep.

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
  reviews, and clean comments count, ordered by server timestamps, and a 👍
  is attributed through REST, where a bot's login carries the `[bot]` suffix
  a username may not — but
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

**The comment events are on the listener, and that is why.** GitHub documents
`issue_comment` and `pull_request_review_comment` as default-branch events —
`GITHUB_REF` and `GITHUB_SHA` both point at the default branch — which would
mean a pull request cannot supply the definition through either. Against that,
a `pull_request_review_comment` in one consuming repository was observed
starting a run whose recorded workflow path was a file that existed only on the
pull request's branch, failing on an action reference that appeared nowhere on
the default branch. Whatever the mechanism, what executed there was not the base
version.

For the status itself that buys an attacker little: **reaching the route needs
a branch in this repository** — a fork cannot, because a fork's workflow files
are not in your repository for any of these events to run — and anyone who can
push such a branch can publish the status far more simply, with any `on: push`
workflow declaring `permissions: statuses: write`. Both comment events sit on
the unprivileged listener anyway, and reach the sweep through `workflow_run`,
whose definition GitHub always takes from the default branch — the same relay
`pull_request_review` has always used. Nothing but `workflow_run`, `schedule`
and `pull_request_target` starts the job that holds `statuses: write`, so the
templated sweep is not a route to a forged status at all.

**Do not read that as a secret being safe on the listener.** Its definition
comes from the same branch-controlled ref, so a branch can add `environment:`
and read `secrets.*` there as easily as it can replace the steps — and it does
not need this file to do it, since a branch can add a workflow of its own on
the same event. See [Binding the status against
collaborators](#binding-the-status-against-collaborators) for what that leaves
open.

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
   sweep job, hand this action `app-id` and `app-private-key` from that
   environment's secrets, and change the workflow's `permissions` block
   from `statuses: write` to **`statuses: read`** — not to nothing. The
   sweep reads a head's own status history before every verdict, and a
   `permissions` block that lists its other grants explicitly gives the
   workflow token no `statuses` access at all once the line is deleted, so
   the read 403s on a private repository and the App-authenticated write
   is never reached. The action performs GitHub's own exchange itself
   (sign a short-lived App JWT, look up this repository's installation,
   mint a token from it), re-minting inside a loop long enough to outlive
   one, and storing nothing; there is no token-minting step to add, and so
   nothing extra for a consumer to pin or review. **The App token writes
   the status and nothing else**: every read the sweep makes stays on the
   workflow's own token, which is what lets the App keep commit statuses
   as its only permission — step 1 above is not a simplification. Both
   halves or neither: given one, the run fails rather than quietly falling
   back to the workflow's token, which under a bound ruleset would leave
   the gate waiting on a check nothing reports. The first sweep after the
   credential is placed rewrites each open head's status even when its
   verdict has not changed, so a head carrying one from anybody but this
   App — `github-actions[bot]`, or an App rotated away from — gets one
   from this App; otherwise binding the ruleset would block those pull
   requests until their verdict changed. The comparison is against the
   configured App by name, read from the installation lookup, so a
   rotation migrates exactly as the first placement does.
5. **In the ruleset, require the `codex` status from that App
   specifically**, not from any source. This is the step that closes the
   door; the previous four only make it possible.

**The rule the credential depends on is absolute: nothing but
`workflow_run`, `schedule`, and `pull_request_target` may trigger the job
that can read the key.** The templates above satisfy it, and if you add a
trigger of your own to the sweep, that rule is the one to check it against.

**Necessary, and not sufficient — read this before placing the key.** A
deployment-branch policy authorizes by the ref a run *reports*, and the
comment-event anomaly above is a run that reported the default branch while
executing a file that existed only on a pull request's branch. If that is
what it looked like, then a collaborator's branch can declare
`environment: codex-review` on a workflow of its own, pass the policy on the
default branch's name, and be handed the private key — and the forgery would
carry the App's own attribution. Keeping the sweep's trigger list clean does
not close that, because the attacker need not use the sweep, or any file this
repository ships.

So the boundary this section describes rests on GitHub's documented behavior
(a comment event runs the default branch's definition, and only that) rather
than on the anomaly, and one observation is not enough to settle which is
true. Establish that before trusting an environment with the key on a
repository whose collaborators you would not trust to publish the status.

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
