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
name: codex-review

on:
  schedule:
    - cron: '23 * * * *'
  pull_request_target:
    types: [opened, reopened, ready_for_review, synchronize, closed]
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
name: codex-review-listener

# Hears the one verdict delivery the sweep's own triggers cannot safely hear.
# `pull_request_review` is a merge-ref event -- GitHub runs the workflow file
# from refs/pull/<n>/merge, the pull request's own version -- so it must never
# appear on a workflow that can write commit statuses. This listener declares
# no permissions and does one no-op step. That is least-privilege hygiene,
# not a wall: a same-repository branch can edit any workflow file, this one
# included, and grant itself what it likes -- but that attacker never needed
# this file, since a workflow of their own on `push` could publish the
# status directly. What the relay guarantees is narrower and real: the
# workflow that CAN write statuses only ever runs its default-branch
# definition. Its completion starts the sweep above via `workflow_run`.
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

The reaction is the whole verdict. Codex comments when it has suggestions and
reacts 👍 when it does not, and it revokes the reaction when a new commit
lands — so a reaction that is present belongs to the head being looked at, and
nothing here has to compare SHAs to establish that.

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
to bind this against collaborators, hold the credential in an environment whose
deployment-branch policy allows only your default branch; editing the trigger
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
