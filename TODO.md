# TODO

## Decisions needing review

Guesses made under autopilot, recorded here so nothing decided without the
repository owner silently becomes permanent. Each says what was decided, what
the alternative was, and why it is reversible.

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

## Later

- Implement the fork remedy above, before consumers start requiring
  `codex-review-check` in their rulesets.
