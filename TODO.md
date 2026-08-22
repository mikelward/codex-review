# TODO

## Finish the gate → lanes check rename

The consumer-facing required check was renamed from `gate` to `lanes`
(mikelward/lanes#9). `lanes` now runs alongside `gate` here (both green),
but two steps remain, outside what a session without ruleset API access can
do:

- [ ] Flip the ruleset to require `lanes` instead of `gate`, now that
      `lanes` has reported on a `pull_request` run here: `repo-rules
      mikelward/codex-review lanes codex codex-review-check ...` (naming
      every check the ruleset should require — `mikelward/scripts`' tool).
- [ ] Once the ruleset requires `lanes`, delete the now-redundant `gate`
      job and its parity test (`workflow-check-rename.test.js`) in a
      follow-up PR.

## Open gap: the lanes-publisher runner check trusts labels it cannot verify

`lanes_publisher_only`'s `PUBLISHER_RUNNERS` whitelist (mikelward/codex-review#27)
accepts a job only when `runs-on:` names an exact GitHub-hosted label --
but a self-hosted runner can register under that same string, and this
checker parses workflow text only, with no API call to list what runners
an account actually has. So a repository adopting the trusted-lanes
publisher pattern carries a prerequisite this check cannot verify: no
self-hosted runner, anywhere the repository or its organization draws
runners from, may be labeled with a string in `PUBLISHER_RUNNERS`. Flagged
by Codex review; documented in `check_consumer.py` and `docs/CONSUMER.md`
rather than half-closed, since actually closing it would mean this checker
calling the runners API with a token scoped to read them -- a different
trust model than the file-only one every consumer relies on today. Revisit
if a consumer's own self-hosted fleet ever makes this more than a
theoretical collision.

## Decisions needing review

Guesses made under autopilot, recorded here so nothing decided without the
repository owner silently becomes permanent. Each says what was decided, what
the alternative was, and why it is reversible.

### A 👍 no longer outranks strictly newer findings on the same head

**Decided (2026-08-17, security pass):** the reaction now approves only when
it is strictly newer than Codex's last written word on the head (`judge`
compares `approvedAt` against the newest review/comment time, the same
latest-word test the clean comment already got). Before, a standing 👍
outranked a findings review that arrived AFTER it — Codex provably revokes
the reaction on push, not on a later findings pass, so the leftover 👍 could
hand auto-merge a `success` with an unaddressed finding standing. A tie
fails closed, matching the nudge-tie rule.

**Alternative:** keep the standing order and rely on Codex removing its 👍
when it posts findings. This file's own history documents Codex not keeping
its reaction promises, which is why the comment channel got `cleanIsLatest`
first.

**Reversible:** one condition in `judge` plus three tests; the fix-and-nudge
round (old findings, fresh 👍) still approves, and a test pins it.

### matchesBot requires type evidence for the bare login spelling — on REST only

**Decided (2026-08-17, security pass; revised 2026-08-18 after Codex
review):** the suffixed spelling (`…[bot]`) certifies itself — brackets are
illegal in usernames — but the bare spelling needs the account type to say
Bot. The first pass asked for that evidence on every channel, including
GraphQL's `Reaction.user`; Codex correctly flagged that field as declared
the concrete `User` type rather than the polymorphic `Actor` interface, so
its `__typename` is a schema constant ("User") for every reactor, bot or
human — the check could never pass, which would have silently blocked
Codex's own clean-pass 👍 on every consumer forever. `matchesBot` (type
evidence required) is now for REST-sourced actors only — review and comment
authors, where `user.type` is real; `matchesBotLogin` (login only, no type
evidence) covers the GraphQL reaction, with the residual risk — a
same-named human account forging a reaction — named at its definition.

**Alternative:** trust GitHub's squatting protections, which are policy,
not API guarantee, on every channel including the one that cannot be
hardened without breaking it.

**Reversible:** the two functions and the query strings; fixtures using the
suffixed spelling never notice either way.

### AGENTS.md moved to the code lane

**Decided (2026-08-17, security pass):** `.github/lanes.conf` now sends
AGENTS.md (and the CLAUDE.md symlink) down the code lane, because
`action.test.js` derives the swept-consumer list from AGENTS.md's
sibling-repositories sentence — a markdown-only PR editing that list used
to skip the suite, deferring the AGENTS.md ↔ `check-consumers.sh`
cross-check to a confusing red on the next code-lane PR. Same argument that
put README.md there.

**Alternative:** keep it housekeeping and accept the deferred red — fail
closed either way, just later and more confusingly.

**Reversible:** two policy lines and the lanes-policy test fixtures.

### Naming a sibling repo's pull request in a test comment

**Decided:** replaced `simmo#216` with "a sibling repo's pull request" in the
three `cleanVerdict` test comments, and the `6c493c8` fixture prefix with an
obviously-synthetic one, after Codex raised it as a P1 three times across two
pull requests.

**Alternative:** keep the reference. AGENTS.md § Privacy bans **user data**,
and a public pull request in the owner's own public repository is not that --
sibling AGENTS.md files cite `anthropics/claude-code#46625` in committed prose
for exactly the same provenance reason. That argument was made on both threads
and still stands.

**Why this way:** the finding kept the `codex` status at FINDINGS, and that
status is what gates the fix restoring the 55-minute loop and the clean-comment
verdict for every consumer. Holding the line cost thirteen repositories a
working gate; the identifier bought a reader one lookup. The regression
scenario itself -- a clean comment about an older head deciding the current
one -- is still described in full.

**Reversible:** the words are two comments; restoring them is one edit. If the
intent is that citations like this ARE allowed, the fix belongs in AGENTS.md so
it binds every repo rather than being re-argued per pull request.

### Fork pull requests: documented, not fixed

**Decided:** record the gap in `docs/CONSUMER.md` with its remedy, and leave
the code alone (#10).

**Alternative:** implement it now — have `check-consumer.yml` publish its
result as a check run against `github.event.pull_request.head.sha` using
`checks: write`, granted in **both** the nine callers *and*
`check-consumer.yml` itself, and switch consumers to requiring the
self-published `codex-review-check`. Both ends, because a reusable workflow's
own `permissions:` block can only narrow what its caller passes: today that
file declares `contents: read` and would strip the scope back off however
generously a caller granted it, leaving the newly required check unable to
report at all.

**Why this way:** the premise is unconfirmed (no fork pull request has been
observed against any consumer, and the same-repo evidence points the other
way), the owner confirmed external forks do not matter today, and the fix
costs a new write grant in nine callers plus this repository plus a
required-check rename in each. It is also only half the gate: a fork head
fails the `codex` status separately and on purpose, because its check suites
carry no `head_branch` and so never date the head's arrival.

**Reversible:** entirely. The remedy is written down in full, including the
scope to use and the `pull_request`-trigger trap to avoid, so implementing it
later is a fresh pull request against unchanged code. The cost of waiting is
that the required-check rename gets more expensive with each consumer that
starts requiring the check — so do it before many do.

### vcs#72 nudged rather than merged past its gate

**Decided:** post one `@codex review` on mikelward/vcs#72 so the verdict
reflects the resolved thread, rather than merging it while `codex` reads
"Codex left findings on this head".

**Alternative:** merge it ungated — vcs's ruleset does not require `codex`
yet, so nothing blocks the merge mechanically.

**Why this way:** Codex's findings bind to the head SHA and thread resolution
does not clear them, so under the documented-not-fixed decision that pull
request never gets a new head of its own. A nudge is the cheapest thing that
can clear it honestly; merging past the gate would set the precedent that the
gate is advisory, on the very pull request that installs it.

**Reversible:** a nudge changes nothing if Codex re-raises the finding, and
the merge-ungated option stays available. Do not nudge repeatedly — if the
re-review raises it again, that is an answer, and the choice goes back to the
owner.

### Official actions ref-pinned, not hash-pinned, in the zizmor policy

**Decided:** the zizmor policy (`.github/zizmor.yml` here and in the
sibling hub repository that carries the same setup) accepts tag pins for
`actions/*`, matching how every workflow already references them; only
third-party actions must pin a hash. The owner approved adding zizmor pinned-and-advisory, but this
specific policy line was chosen without asking.

**Alternative:** require hash pins for official actions too. That is real
supply-chain rigor — a compromised tag on a first-party action is not
hypothetical for actions generally — at the cost of hash bumps becoming a
recurring chore in repositories designed to have nothing to bump.

**Reversible:** one policy line per repository, plus pinning the handful
of `actions/*` references the change would then flag. Nothing else
depends on the choice.

## Later

- Implement the fork remedy above, before consumers start requiring
  `codex-review-check` in their rulesets.
