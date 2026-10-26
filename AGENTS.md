---
trigger: always_on
alwaysApply: true
last_modified: 2026-10-26
---

# codex-review

A GitHub Action that republishes Codex's review verdict as a `codex` commit status.
**Consumers track `@main`**, so a merge reaches every consumer's merge gate at once.

## Fleet conventions

Shared by every mikelward repo and the user-level agent config; canonical in mikelward/conf
`agents/AGENTS.md`. A repo's Project section overrides it.

### This file

- **Session start**. At the start of every session, print the full absolute path of the
  `AGENTS.md` you loaded and its `last_modified` date.
- **Canonical**. AGENTS.md is canonical; `CLAUDE.md` and `GEMINI.md` point to it. Keep it
  brief, generic to all agents (noting per-agent exceptions), and under 22,000 bytes.
  Bump `last_modified` whenever you edit this file.

### Talking to the user

- **Questions**. One at a time; wait for the answer.
- **Messages**. Send one only for a question, a blocker, something to act on, or a change
  of plan. No progress reports or narrating events.
- **Claude Code**. It reliably shows only a turn's last message; put everything there.
- **Replies**. Short, key point first, ending with open PR links and any pending
  question.
- **Network access**. If you want access to a host and you can't access it or a mirror,
  ask the user to allowlist the domain(s) along with the purpose.

### Git

- **Branches**. `<agent>/<topic>` off a fresh `origin/main` (fetch by refspec). Never
  commit to `main`.
- **Your branches**. Push, force-push with lease, and delete them freely. Ask before
  touching others', `main`, settings, secrets or paid services.
- **Commits**. One per logical change; fold in review fixes.
- **Subjects**. Changelog lines: imperative, the user-visible change, ≤ 70 chars. PR
  titles match.
- **Prefixes**. `docs:`, `test:`, `build:`, `refactor:` mark what users won't notice. No
  `feat:` or `fix:`.
- **Model names**. Never in anything pushed.
- **After a merge**. Branch afresh.
- **Shallow clones**. Unshallow before trusting history or calculating a version code.
- **Language**. US English everywhere.

### Pull requests

- **Opening**. Open the PR unasked; update its title and body before each push.
- **Watching**. PR events plus one scheduled check (events miss CI success and Codex's
  👍).
- **Auto-merge**. Enable it on PRs that target `main`; stack dependent ones.
- **Base moved**. After a merge, tell open PRs on that base whose body ends with a session
  URL.
- **Merge or close**. Answer remaining threads and stop watching.

### Reviews

- **Codex**. It reviews automatically. Fix, decline with a reason, or defer to `TODO.md`
  every comment; reply citing the commit, then resolve.
- **Merit**. Codex over-reads rules, privacy especially: quote and decline rather than
  cripple the code. Design changes are the user's call.
- **Verdict**. 👍 is clean, 👀 is reviewing. Only the code review gates merging: its
  findings (review comments, PR comments, reviews) block it. Security reviews often
  hang; don't wait on them.
- **Hung review**. `@codex review` after five quiet minutes, again an hour later, then
  tell the user.
- **After a 👍**. Ask before unneeded changes.
- **Reports**. Give each review's findings in your next message.

### Autonomy

- **Fix proactively**. Lint, test, presubmit, CI and review failures, unasked.
- **Proactive refactors**. Repeated bugs in one area, duplicated code, or a change with
  twins elsewhere: suggest the redesigned or shared version.
- **Drive to merge**. Once the details are agreed, see the change through unattended:
  implement it, open the PR, keep it mergeable (fix CI, answer reviews, rebase when it
  conflicts or falls behind), and merge once CI is green and Codex 👍s, or let
  auto-merge.
- **Drive**. Take `TODO.md` items one at a time and drive each to merge, until done or
  stopped.
- **Autopilot**. Drive without asking, logging guesses in `TODO.md` under *Decisions
  needing review*. Still ask before anything irreversible, outside this repo, or private.
- **Red baseline**. Fix existing failures first, in their own commit.

### Quality

- **Tests**. Every behavior change gets one; a bug fix's fails first. Assert behavior,
  not structure. No sleeps or retries; never disable a failing check.
- **Docs**. Keep `SPEC.md` and `README.md` current.
- **CI**. Wait for it before claiming success.
- **Errors**. Never swallow one; log it with context and clean up.
- **Cost**. State the cost and reliability of new dependencies or services up front.
- **Privacy**. No user data (personal paths, hostnames, tokens, keys, private remotes)
  leaves this machine; use placeholders.
- **Portability**. Flag anything that won't run on Linux and macOS.

## Project

- **Consumers**. Twenty-two sibling repositories consume this: `androidlog`,
  `ci-commit-artifact`, `clothescast`, `conf`, `gedmap`, `gradle-update`, `lanes`, `mesh`,
  `newshacker`, `npm-update`, `readmo`, `repo`, `root`, `rust-update`, `scripts`, `simmo`,
  `snoozemo`, `typelauncher`, `unixtools`, `vcs`, `web`, `yaml-lite`. A change to the
  inputs, the published wording or `templates/` needs their workflows checked
  (`scripts/check-consumers.sh` sweeps them).
- **simmo**. A private repository with billed CI, so it sits in `PRIVATE_CONSUMERS`: this
  repo's CI can't clone it, and a `templates/` change is not validated against simmo
  before it merges. Check it locally. It's the **last** repository in any fleet-wide
  migration, where a change is confirmed, never where it is tried.
- **Dependencies**. None, and no build step: the file the runner executes is the file
  here (`action.test.js` enforces it).
- **Contract**. The status stays `codex`, and a caller with no `with:` keeps working:
  consumers' rulesets depend on both.
- **Fail safe**. A broken sweep leaves `pending`, blocking merges rather than passing
  them.
- **Templates**. A `templates/` change is a migration. Keep the outgoing files in
  `templates/superseded/<label>/` so nothing goes red, and delete that only after a sweep
  that read every consumer.
- **Pilot**. This repo is its own first consumer; a second follows the merge.
- **Tests**. `node --test *.test.js`, with `python3` and PyYAML.
- **Prefixes**. `build:` is this repo's own CI; bare means a consumer could notice.
