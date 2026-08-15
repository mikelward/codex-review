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
      - uses: mikelward/codex-review@v1
```

Then add `codex` to the required status checks for your default branch. Until
you do, the status is published and ignored.

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

The job holds `statuses: write`. Several triggers would let a pull request
branch supply its own version of the steps that hold that token and publish
`codex: success` for itself — `workflow_dispatch` takes a ref and GitHub runs
the workflow file *from that ref*, and plain `pull_request` takes its definition
from the merge ref. The trigger set above has no such hole: `schedule`,
`pull_request_target` and both comment events all take the workflow definition
from the base ref. Pinning the checkout does not help when the branch supplies
the steps, which is why the fix is the trigger list rather than a `ref:`.

Keeping that list in your repository means the declarations that decide who can
write the status are reviewed alongside your code, not vendored out of sight.

Make this sweep the **only** writer of the `codex` status. A second writer is an
unordered write, and one delayed past this run's exit overwrites a
just-published `success` with nothing left to notice.

## Versioning

`@v1` floats, and that is the feature: a fix reaches every consumer without a
pull request in each one. What replaces a pinned SHA is this repository's own
CI — the suite gates the tag, and the failure direction is the safe one, since a
broken sweep leaves `pending`, which blocks merges rather than letting anything
through.

`@v1` is a promise about two things a consumer's branch protection depends on:
the status context stays `codex`, and a caller with no `with:` block keeps
working. Both are pinned by tests.

## No dependencies, on purpose

There is no `package.json`, no lockfile and no build step. The file the runner
executes is the file in this repository, so a floating tag can be reviewed by
reading what it runs — nothing is generated in between that could differ from
its source. A test enforces this.

## License

MIT.
