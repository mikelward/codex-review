// Publishes Codex's review verdict as a commit status, so branch protection
// can gate on something it can actually see.
//
// Codex posts no check run of its own, and its clean pass is only a 👍
// reaction on the PR body — which emits no webhook. So the verdict is both
// invisible to protection rules and undeliverable by event: it has to be
// polled and translated. Without that, auto-merge fires on green CI *before*
// Codex has looked, and a merged-too-early PR is indistinguishable from a
// correctly merged one.
//
// The reaction is the usual verdict, and that is why this file is small.
// Codex's own description of itself: "If Codex has suggestions, it will
// comment; otherwise it will react with 👍." The reaction is therefore present
// only when it has nothing to say — findings in a review body, in a thread, or
// in a top-level comment all mean no reaction, and none of them decides the
// *verdict* here.
//
// It does not always keep that promise, which is the one exception: a clean
// comment naming the head it read approves too — see `cleanVerdict`. Twice in
// one afternoon Codex answered "Didn't find any major issues" as a comment
// and left the body unreacted, once putting the 👍 on the nudge comment
// instead, and the gate published FINDINGS over pull requests with no finding
// on them. A `success` with no reaction on the body is therefore expected.
//
// A submitted review naming the current head is still read,
// but only for the loop's economics: findings mean the next change is a push,
// not a reaction, so the minute clock has nothing to catch until then. Codex
// also revokes the reaction when a new commit lands, so a reaction that is
// present belongs to the head being looked at, and nothing here has to
// compare SHAs to establish that.
//
// An earlier version parsed review bodies for finding badges, timestamped them
// against the head, and ranked findings against passes. All of it re-derived
// what the reaction already says, and two of its bugs pointed the same way:
// approving without a verdict.
//
// Human review threads are deliberately not modeled: GitHub's "require
// conversation resolution" setting does that natively, and better.
//
// Reactions run the other way too. Approval is Codex's 👍 *and* no 👀 and no
// 👎 from the repository owner *and* no owner "@codex review" newer than the
// 👍 — so a hold costs two seconds from a phone, which is the point: without
// it auto-merge can land a PR before someone who wanted a look gets one, and
// there is no other signal that cheap. The nudge case is the same idea one
// step later: asking Codex to look again means the standing verdict is no
// longer the one wanted, so the gate closes until the fresh answer lands.
//
// Only the owner, because this repo is public: anyone can react, and a hold
// deliberately outlives head changes, so an unrestricted one lets a passer-by
// block a PR for as long as they feel like it. Codex's own 👀 counts too —
// it means "still reading", it clears when it reacts 👍, and it is not a
// passer-by.
//
// A hold takes effect within a sweep, NOT immediately, and the difference is
// the whole point of saying so. Reactions emit no webhook, so nothing can
// notice one as it lands; if `success` is already published and another
// required check goes green before the next sweep, auto-merge takes the PR
// with the hold sitting there unread. The interval bounds that and cannot
// close it. **To stop a merge right now, convert the PR to a draft** — GitHub
// disables auto-merge on drafts the moment you do it, and `verdictFor` returns
// null for a draft so nothing here fights you. The reaction is for "don't
// merge this yet", which is the ordinary case; the draft is for "stop".

export const CODEX_BOT = "chatgpt-codex-connector";
export const CONTEXT = "codex";

/**
 * The pending description.
 *
 * `publish` skips the write when state and description both match what is
 * already on the head, and that skip is what keeps the head's earliest
 * `codex` status — its gate marker — where it is. Rewrite the same status
 * each sweep and the marker moves forward every time, until no reaction can
 * ever be newer than it: the gate stalls for good, on every open pull
 * request at once, with nothing failing to say so.
 *
 * It says *approve* rather than *review* because a head Codex has reviewed
 * and left findings on sits here too — nothing is waiting for a review by
 * then, only for the 👍.
 */
export const PENDING = "Waiting for Codex to approve this head";

/**
 * The pending description for a head Codex has reviewed and left findings
 * on. Same state as PENDING — the gate stays closed either way — but the
 * sweep's lean gate treats the two differently: PENDING means the answer is
 * still being written and the next minute matters; FINDINGS means the next
 * change is a push, which restarts the loop by event, so polling for it
 * would only burn the runner.
 */
export const FINDINGS = "Codex left findings on this head";

/**
 * The pending description written over a head the sweep has repeatedly
 * failed to read — see the failure streak in `sweep`. The run going red is
 * not enough on its own: branch protection consumes the *status*, and a
 * `success` published before the failures began would otherwise keep the
 * gate open while a newer hold or re-review request sits unread.
 */
export const UNREADABLE = "Verdict unreadable — failing closed until the sweep recovers";

/**
 * The pending description for a head Codex never answered.
 *
 * Parking an unanswered head is not new -- see `UNANSWERED_MINUTES` -- but
 * it used to park SILENTLY, leaving `PENDING` standing. That reads exactly
 * like a review still in flight, so the one state a person has to act on
 * was indistinguishable from the ordinary wait, and the documented remedy
 * (comment `@codex review`, once) had to be arrived at by hand.
 *
 * So the park says so instead. It costs nothing: the sweep already holds
 * `statuses: write` and is already this head's writer, so no new
 * permission, call or comment is involved -- only different words in a
 * place the pull request already shows.
 *
 * STICKY, because the age it is derived from is anchored partly on our own
 * last status write: escalating would otherwise reset that anchor, the next
 * sweep would find the head young again and rewrite `PENDING`, and the two
 * would alternate forever -- walking the head's gate marker forward every
 * sweep. Once written it stands until something real happens: a nudge
 * (which outranks it in `verdictFor`), a push (a new head with its own
 * status), or Codex finally answering.
 */
export const UNANSWERED = "Codex has not answered this head — comment @codex review";

/**
 * The same park on a head whose REACTION cannot be accepted.
 *
 * `checkSuiteBirths` dates a head's arrival from a suite born on its
 * branch, and GitHub reports no `head_branch` for a fork's suites — so a
 * fork head is undatable FOREVER, and `judge` refuses its 👍 by design
 * rather than fall back to a bound an attacker could pre-stamp.
 *
 * Only the reaction, though, and the distinction is the whole wording.
 * `cleanlyApproved` is `approvedIsLatest || cleanIsLatest`, and the second
 * disjunct never consults the suites: an attributable clean COMMENT names
 * the commit it read, which is exactly what the reaction lacks, so it
 * approves a fork head like any other. A re-review can therefore settle
 * this head — it just cannot be settled by a 👍 alone. Saying otherwise
 * sends a maintainer to an admin override past a remedy that works, so the
 * sentence keeps both: the retry first, the override as the fallback.
 */
export const UNANSWERED_FORK =
  "A fork head\u0027s 👍 cannot be accepted — comment @codex review, or merge by admin override";

/**
 * Every wording this loop parks a head with.
 *
 * Read as a set rather than compared one at a time, because all three
 * places that care — the sticky read, the age anchor, and the clear — mean
 * "a marker we wrote when we gave up", not any particular sentence.
 */
const PARKED = new Set([UNANSWERED, UNANSWERED_FORK]);

/**
 * Which park wording is true for this head.
 *
 * Derived from the pull request, never from what the commit already wears:
 * a status belongs to the commit, so the same SHA can be a same-repo head
 * in one pull request's life and a fork head in the next, and only one of
 * the two remedies works at a time.
 */
const marker = (node) => (node.isCrossRepository ? UNANSWERED_FORK : UNANSWERED);

/**
 * Consecutive failing sweeps before a head's failure stops being treated as
 * transient: minutes past any replication lag, still short enough that a
 * stale published verdict is invalidated and the owner notified promptly.
 */
export const MAX_FAIL_STREAK = 5;

/**
 * Minutes an unanswered head keeps the fast clock before the loop parks it.
 *
 * The window exists so a forgotten PR with no verdict cannot keep every
 * loop alive its full 55 minutes, restarted by the schedule forever. Past
 * this age the head still gates `pending` (nothing fails open), it just
 * stops counting as awaiting: the retry is a nudge or a push, both events
 * that restart the clock. A 👀 is exempt — eyes on means the review
 * genuinely started, and long reads are what the 55-minute loop is for.
 *
 * Thirty, not ten, and the difference was paid for: under a burst of
 * pushes (several amends across sibling repos inside ten minutes) Codex
 * queues, the 👀 does not land until it actually starts, and the answer
 * arrived at minute nine-to-twelve — right at the old park. A parked head
 * has no loop left to see the 👍, the reaction emits no webhook, and the
 * hourly schedule was the next reader: five pull requests sat mergeable
 * for most of an hour on 2026-08-16 for exactly this. The window is a
 * ceiling, not a duration — an answered head ends the loop within a poll
 * interval — so widening it is paid only by a head Codex never answers,
 * once per push, while a too-narrow window recurs as stalled afternoons.
 */
export const UNANSWERED_MINUTES = 30;

const stripBot = (login) => String(login ?? "").replace(/\[bot\]$/, "");

/**
 * Is this login Codex's, spelled either way REST or GraphQL use? Login only
 * — no type evidence asked for or required, so it never decides a verdict.
 *
 * It is the CANDIDATE test for GraphQL reactions. That channel's
 * `Reaction.user` is declared as the concrete `User` type, not the
 * polymorphic `Actor` interface, so a `__typename` queried on it is a
 * SCHEMA CONSTANT — "User" for every reactor, bot or human — and no type
 * evidence can be had from it at any price. Requiring `Bot` there would
 * not harden the reaction channel; it would silence it, permanently, for
 * exactly the clean-pass 👍 that is Codex's most common answer.
 *
 * So the login match is where the reaction channel STARTS, not where it
 * ends: a 👍 matching by login alone is re-read from REST
 * (`restReactions`), where the same reaction arrives spelled `…[bot]` and
 * carrying `user.type`, and `matchesBot` decides it there. A same-named
 * human account is no longer the accepted residual it once was — it is
 * caught one call later, by the only channel that can see the difference.
 *
 * The 👀 keeps deciding on the login alone, and what that is worth is worth
 * stating exactly. It cannot open the gate: `verdictFor` ranks reading above
 * approval, so a 👀 standing beside a 👍 publishes `pending`, and a forger
 * cannot reach `held` either — that is the owner's login, not Codex's. What
 * a forged 👀 CAN do is keep a head on the clock: a reading head is exempt
 * from the unanswered-head park (see `UNANSWERED_MINUTES`), so it pins the
 * minute loop on that head until the reaction is removed. The cost is a
 * runner bill, not a merge — the same hazard that makes nudges owner-only,
 * and the reason this is a trade rather than a free pass. Verifying it the
 * way the 👍 is verified would cost a REST call per sweep on every head
 * under review, which is the common path; a cheaper shape — verify only
 * once a 👀 has held a head past the park window, where a genuine one has
 * become doubtful anyway — is recorded in TODO.md rather than built
 * unasked.
 */
export const matchesBotLogin = (login, botLogin = CODEX_BOT) => stripBot(login) === stripBot(botLogin);

/**
 * Is this actor Codex? Takes the whole user object where the caller has one.
 * For REST-sourced actors ONLY (review authors, comment authors, and
 * reactions read back through `restReactions`) — see `matchesBotLogin` for
 * a GraphQL reaction, where no type evidence exists to check.
 *
 * The login alone is not enough for the bare spelling: app slugs and
 * usernames are separate namespaces, so a HUMAN account named like the bot
 * is a registration away from inheriting its verdict authority — clean
 * comments, reviews, all of it. The suffixed spelling is self-certifying
 * (brackets are illegal in usernames); the bare spelling must arrive with
 * REST's `user.type` saying Bot. No type on a bare login fails closed — a
 * Codex signal misread as a stranger's costs a pending, the reverse costs
 * the gate.
 */
export const matchesBot = (user, botLogin = CODEX_BOT) => {
  const login = typeof user === "string" ? user : user?.login;
  if (!matchesBotLogin(login, botLogin)) return false;
  if (/\[bot\]$/.test(String(login ?? ""))) return true;
  const type = typeof user === "string" ? null : user?.type;
  return type === "Bot";
};

/**
 * Normalize a timestamp to a UTC "Z" string, or null.
 *
 * Every time comparison in this file is lexicographic, which is only sound
 * while both sides are UTC strings in the same shape. Today they all are —
 * REST returns UTC "Z", and the GraphQL fields used here (`committedDate`,
 * reaction `createdAt`) are `DateTime`, defined as UTC — so this changes
 * nothing at runtime. It exists because GraphQL also has the
 * offset-preserving `GitTimestamp` (`committer.date`, `author.date`), and
 * one future edit swapping such a field in would make every string
 * comparison silently misorder by up to a day. Applied at each ingestion
 * point, so a value carrying an offset is converted before it can be
 * compared. Already-"Z" strings pass through byte-identical rather than
 * being reformatted: the converted form gains millisecond precision, and
 * reformatting everything would move the head's marker semantics for no
 * gain.
 */
export const utc = (t) => {
  if (!t) return null;
  if (t.endsWith("Z")) return t;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

/** Earliest / latest of some UTC strings, ignoring nulls; null if none. */
export const earlierOf = (...ts) => ts.filter(Boolean).sort()[0] ?? null;
export const laterOf = (...ts) => ts.filter(Boolean).sort().at(-1) ?? null;

/**
 * The newest `createdAt` in a timeline connection, or null.
 *
 * Reads the whole page rather than `nodes[0]`, and that is the entire point:
 * a GraphQL connection comes back **oldest-first**, so `nodes[0]` of a
 * `last:N` window is the Nth-most-recent event, not the newest. Today every
 * caller asks for `last:1`, where the two are the same and nothing can go
 * wrong — which is exactly why the hazard is worth removing rather than
 * commenting on. Raising a bound to `last:10` for a good reason (a busy pull
 * request evicting the event you wanted) would otherwise floor the verdict on
 * the oldest of ten force-pushes, silently, in the safe-looking direction of
 * a bound that is too low.
 */
export const newestIn = (connection) =>
  laterOf(...(connection?.nodes ?? []).map((n) => utc(n?.createdAt)));

/**
 * The newest Codex review of exactly this head in a REST batch, or null.
 *
 * The review's own commit id is the tie to the head, so no time guard is
 * needed (unlike reactions, which outlive pushes until Codex revokes them):
 * a new push changes the head oid and every earlier review stops matching.
 * This also covers standalone inline comments — GitHub wraps every inline
 * comment in a review record (creating a COMMENTED one when none was
 * submitted), so there is no review-comment finding without a review here.
 * The timestamp, not a boolean, because a nudge is only *pending* while it
 * is newer than Codex's last word — see the nudge note in `sweep`.
 */
export function findingsOn(reviews, headRefOid, since = null) {
  let at = null;
  for (const r of reviews ?? []) {
    if (!matchesBot(r.user) || r.commit_id !== headRefOid) continue;
    const t = utc(r.submitted_at) ?? "";
    // A review older than `since` read a different diff. The commit id ties
    // a review to the head, which is enough while the head is the only
    // thing that changes — but a RETARGET changes the diff underneath an
    // unchanged head, so its own review records have to be dropped too.
    // Leaving them in does not open the gate (findings hold it closed) but
    // it settles the head as answered, which stops the minute loop and
    // leaves a later clean 👍 — which emits no webhook — unseen until the
    // hourly sweep.
    //
    // A TIE is stale. GitHub stamps to the second, so a review submitted in
    // the same second as the retarget has no established order against it,
    // and the ambiguity must not be what settles a head. The reaction and
    // comment paths already require strictly newer (`at > bound`,
    // `at <= bound` skips); this is the same rule.
    if (since !== null && t <= since) continue;
    if (at === null || t > at) at = t;
  }
  return at;
}

/**
 * Read every review on the PR; the newest Codex review of this head, or null.
 *
 * REST, paginated to the end, filtered locally by `matchesBot` — not a
 * GraphQL `reviews(author:)` window. The server-side filter needed the
 * bot's login spelled exactly as GitHub stores it, and a mismatch does not
 * error: it returns an empty list forever, which reads as "no findings" and
 * quietly re-opens the always-on polling hole this state exists to close.
 * Local matching cannot miss that way, and full pagination cannot be
 * evicted by later reply-reviews the way a `last:N` window was. Runs only
 * when the answer can still change the verdict, so settled PRs cost no
 * extra calls; the 65-minute job timeout is the backstop against a paging
 * pathology, and an error escaping here ends the run red by design.
 */
export async function codexReviewedAt(api, { owner, name, number, headRefOid, since = null }) {
  let at = null;
  for (let page = 1; ; page += 1) {
    const batch = await api.rest(
      `/repos/${owner}/${name}/pulls/${number}/reviews?per_page=100&page=${page}`,
    );
    const t = findingsOn(batch, headRefOid, since);
    if (t !== null && (at === null || t > at)) at = t;
    if (!batch || batch.length < 100) return at;
  }
}

/**
 * What one comment batch says about this head: Codex's newest word, and the
 * owner's newest "@codex review" nudge, both bounded below by `since` — the
 * head commit's own `committedDate`.
 *
 * Findings arrive in three streams — a submitted review, its inline
 * comments (always wrapped in a review record), and a plain PR comment —
 * and only the first two carry a commit id, so `findingsOn` covers them and
 * `codexAt` covers the third. A comment can only be tied to the head by
 * time, and the bound has to be a moment that provably precedes anything
 * said ABOUT the head. The gate marker is not that: the marker is written
 * by this sweep, so a finding that lands before the first status write sits
 * below the marker forever, reads as "no findings" on every later sweep,
 * and revives the always-on loop for good. The commit's own date precedes
 * the head by construction, so nothing genuine can hide under it.
 *
 * A commit date is forgeable (`--date`, a prebuilt commit), which is why
 * the caller passes the EARLIER of the commit date and the head's first
 * server-stamped status: taking the earlier of two bounds only ever admits
 * more, never hides. The commit date covers the finding that lands before
 * the first status write; the server timestamp covers the commit date
 * being forged into the future — which for the owner's nudge would fail
 * OPEN, since a hidden nudge on an approved head leaves a stale success
 * for auto-merge to take. Forged or honest-but-early dates only admit a
 * previous head's comments, which settles to FINDINGS too eagerly — the
 * gate stays closed and the verdict waits for a nudge, a push, or the
 * schedule. Approval itself never trusts the commit date at all — see
 * `readReactions`.
 *
 * The nudge is owner-only for the same reason holds are: this repo is
 * public, and letting any comment shaped like a nudge hold the loop open
 * would hand passers-by the runner bill.
 */
export function commentSignals(comments, { since, owner, head }) {
  let codexAt = null;
  let nudgeAt = null;
  let cleanAt = null;
  const bound = utc(since);
  if (!bound) return { codexAt, nudgeAt, cleanAt };
  for (const c of comments ?? []) {
    const at = utc(c.created_at) ?? "";
    if (matchesBot(c.user)) {
      // Codex's word stays on created_at: its edits do not re-answer, and a
      // later timestamp here could only mask a nudge — the fail-open way.
      if (at <= bound) continue;
      const clean = cleanVerdict(c.body, head);
      if (clean === "head") {
        // An attributable clean verdict: Codex says it found nothing AND
        // names the commit it read, which is the same standard a review is
        // held to. Its footer promises a 👍 in this case and it does not
        // always keep that promise, so the comment has to be a channel too --
        // otherwise the gate waits forever for a reaction that never comes.
        if (cleanAt === null || at > cleanAt) cleanAt = at;
        continue;
      }
      if (clean === "other") {
        // Clean, but about a commit that is not this head -- a verdict on
        // code that has since been replaced. Counting it as an ANSWER is how
        // a nine-hour-old "no issues" on a superseded commit came to read as
        // "Codex left findings on this head". Dropping it can only ever
        // relax FINDINGS to PENDING, never open the gate, so the fail-closed
        // direction is preserved.
        continue;
      }
      if (codexAt === null || at > codexAt) codexAt = at;
    } else if (
      Boolean(owner) && c.user?.login === owner
      && /@codex review/i.test(c.body ?? "")
    ) {
      // A nudge can be EDITED into an old comment, whose created_at then
      // predates the head or the standing 👍 — dating the ask by the later
      // of creation and edit is what hears it. REST's `since` already
      // filters on updated_at, so the edited comment reaches this walk; the
      // cost is that retouching an old nudge comment re-asks, and erring
      // toward blocking on an owner's ask is this file's stated direction.
      const asked = laterOf(at, utc(c.updated_at));
      if (!asked || asked <= bound) continue;
      if (nudgeAt === null || asked > nudgeAt) nudgeAt = asked;
    }
  }
  return { codexAt, nudgeAt, cleanAt };
}

/**
 * Classify a Codex comment body against the head under judgment.
 *
 * Returns `"head"` for a clean verdict naming this head, `"other"` for one
 * naming a different commit, and `null` for anything else -- which includes
 * every findings comment and a clean one that names no commit at all.
 *
 * Both halves are required. A clean word about superseded code must not
 * approve whatever is current, and the commit line alone appears on findings
 * comments too, which name the commit they object to. `null` is the
 * conservative answer throughout, so an upstream template change degrades to
 * today's behavior -- the gate holds and waits for a reaction -- rather than
 * approving something unread.
 */
/**
 * The tail after the clean headline is Codex's own flourish, and it varies
 * without limit -- a fleet-wide survey of ~220 clean verdicts across 17
 * repos turned up more than 20 distinct tails, most seen exactly once
 * ("Nice work!" among them, the miss that prompted this), while the
 * headline sentence itself was byte-for-byte identical every time. Neither
 * an allowlist nor a blacklist of how the tail can start keeps pace with an
 * open set -- the second one, tried and reverted in this same series, still
 * rejected real fleet cheers it had never seen a shape for.
 *
 * So the tail is not checked at all: the headline sentence is the verdict,
 * full stop. That accepts a real finding phrased as a continuation
 * ("Didn't find any major issues. However, I found a blocking bug.") --
 * openly, not by accident. Weighed against the actual failure this repo has
 * hit repeatedly (a real clean verdict refused for wording nobody
 * enumerated, stalling a merge gate fleet-wide), that trade reads the
 * other way round: every real incident so far has been this function
 * refusing a clean verdict, never approving a hidden finding.
 */
/**
 * The marker on Codex's status-table comment.
 *
 * Since about 2026-08-26 Codex maintains one comment per pull request
 * carrying a row per review kind -- Code Review, Security Review -- each
 * naming the commit it is about and reading `Running` then `Completed`.
 * It EDITS that comment in place as each review lands, and the edit arrives
 * as an `issue_comment` event, a trigger every consumer already declares.
 * That is the whole value here: the end of a read finally has a webhook,
 * where the 👍 has none.
 */
export const SUMMARY_MARKER = "codex-pull-request-review-summary";

/**
 * What Codex's status table says about the CODE review of this head:
 * `"running"`, `"completed"`, or null for anything else.
 *
 * Null is the conservative answer everywhere, and it means "this comment
 * tells us nothing about this head" -- the caller then behaves exactly as
 * it did before the table existed. That is what keeps an upstream change to
 * an undocumented comment from breaking the gate: a shape that stops
 * matching degrades to polling rather than to a wrong answer, the same
 * discipline `cleanVerdict` uses.
 *
 * It is deliberately NOT a verdict channel, and must never become one.
 * `Completed` is silent about whether anything was FOUND, so reading it as
 * clean would infer from absence -- and the findings review and this edit
 * have landed inside the same second on real pull requests, so that race is
 * not theoretical. Cleanliness stays with the 👍 and the attributable clean
 * comment; this only says whether the answer is still being written.
 *
 * Per ROW, because the rows disagree: observed live with Code Review
 * `Running` on one commit while Security Review still read `Completed` on
 * the commit before it. The `codex-security-review:v1` JSON marker that
 * rides in the same comment is the security row's state, not this one's,
 * and its `headSha` goes stale the same way -- so neither the comment nor
 * that marker has a single head, and only the row does.
 */
export function reviewTableStatus(body, head) {
  const text = String(body ?? "");
  if (!text.includes(SUMMARY_MARKER)) return null;
  // Everything from `<details` on is Codex's boilerplate footer, dropped
  // before the shape is read -- as in `cleanVerdict`, and for the same
  // reason: the footer's prose is not part of what is being validated.
  const rows = text.split(/<details/i)[0]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"));
  for (const row of rows) {
    // `| a | b | c |` -> ["", " a ", " b ", " c ", ""], so the ends drop.
    const cells = row.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;
    if (!/\bCode Review\b/.test(cells[0])) continue;
    const named = /`([0-9a-f]{7,40})`/.exec(cells[2])?.[1];
    if (!named) return null;
    // The abbreviation is Codex's -- seven characters here where the API
    // gives forty -- so compare by prefix in the direction that cannot
    // collide, exactly as `cleanVerdict` does: the named id must be a
    // prefix of the full head, never the reverse.
    if (!head || !String(head).toLowerCase().startsWith(named.toLowerCase())) return null;
    if (/\*\*Running\*\*/.test(cells[1])) return "running";
    if (/\*\*Completed\*\*/.test(cells[1])) return "completed";
    return null;
  }
  return null;
}

export function cleanVerdict(body, head) {
  const text = String(body ?? "");
  // Validate the WHOLE known structure, not a list of things it must not
  // say. Several review rounds went the other way -- anchor the marker, end
  // the sentence, allowlist the cheer, then blacklist how the cheer could
  // open -- and each one closed the hole it was shown while leaving the next
  // position open, because enumerating what a finding might look like
  // cannot terminate: prose has no edge. The clean comment's shape does: a
  // headline, a reviewed-commit line, and Codex's collapsible `<details>`
  // footer. Anything else in it means this is not that comment, whatever it
  // says -- which is also why the tail itself is no longer inspected at all.
  //
  // Everything from `<details` on is Codex's boilerplate and is dropped
  // before the shape is checked; what remains must be exactly two content
  // lines.
  const lines = text.split(/<details/i)[0]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length !== 2) return null;

  const headline = /^Codex Review:[ \t]*Didn['’]t find any major issues[.!](.*)$/.exec(lines[0]);
  if (!headline) return null;
  // The captured tail (headline[1]) is deliberately unchecked -- see the
  // comment above.

  const named = /^\**Reviewed commit:\**[ \t]*`?([0-9a-f]{7,40})`?$/i.exec(lines[1])?.[1];
  if (!named) return null;
  if (!head) return "other";
  // The abbreviation is Codex's: it prints ten characters where the API
  // gives forty, so compare by prefix in the direction that cannot collide
  // -- the named id must be a prefix of the full head, never the reverse.
  return String(head).toLowerCase().startsWith(named.toLowerCase()) ? "head" : "other";
}

/**
 * Codex's status table for this head's CODE review, fetched from the
 * top-level comment stream.
 *
 * Its own call, and paid only on the would-park path in `sweep` -- the same
 * shape as `checkSuiteBirths`, which is fetched only in the two cases where
 * it can change the answer. The comment walk cannot supply this: it is
 * skipped entirely while `reading`, which is precisely the state this is
 * asked about, and it bounds Codex comments by `created_at` -- while the
 * table comment is CREATED once at pull-request open and edited in place
 * ever after, so any such bound hides it from every later head.
 *
 * Author-checked like every other Codex signal. This one cannot open a
 * gate, so a forgery could only PARK the loop early -- a stall, which is
 * fail-closed -- but the repository is public and a stranger should not be
 * able to spend the maintainer's verdict latency either.
 */
export async function codeReviewTableStatus(api, { owner, name, number, head }) {
  for (let page = 1; ; page += 1) {
    const batch = await api.rest(
      `/repos/${owner}/${name}/issues/${number}/comments?per_page=100&page=${page}`,
    );
    for (const c of batch ?? []) {
      if (!matchesBot(c.user)) continue;
      const status = reviewTableStatus(c.body, head);
      if (status) return status;
    }
    if (!batch || batch.length < 100) return null;
  }
}

export async function codexCommentSignals(api, { owner, name, number, since, head }) {
  let codexAt = null;
  let nudgeAt = null;
  let cleanAt = null;
  if (!since) return { codexAt, nudgeAt, cleanAt };
  // Both comment streams: top-level (`issues/…/comments`) and inline
  // review-thread replies (`pulls/…/comments`). A rebuttal-plus-nudge is
  // most naturally typed as a thread reply, and since the sweep is the sole
  // source of nudge state, missing that stream would settle FINDINGS over
  // a nudge that was plainly made.
  for (const stream of ["issues", "pulls"]) {
    for (let page = 1; ; page += 1) {
      const batch = await api.rest(
        `/repos/${owner}/${name}/${stream}/${number}/comments?since=${encodeURIComponent(since)}&per_page=100&page=${page}`,
      );
      const seen = commentSignals(batch, { since, owner, head });
      if (seen.codexAt !== null && (codexAt === null || seen.codexAt > codexAt)) codexAt = seen.codexAt;
      if (seen.nudgeAt !== null && (nudgeAt === null || seen.nudgeAt > nudgeAt)) nudgeAt = seen.nudgeAt;
      if (seen.cleanAt !== null && (cleanAt === null || seen.cleanAt > cleanAt)) cleanAt = seen.cleanAt;
      if (!batch || batch.length < 100) break;
    }
  }
  return { codexAt, nudgeAt, cleanAt };
}

/**
 * Decide the commit status for one pull request.
 * Returns null for a draft — nothing to gate until it is ready for review.
 */
export function verdictFor({
  isDraft, approved, sharedHead, held, reading, findings, nudged, unanswered, carried = null,
}) {
  if (isDraft) return null;

  // A status belongs to the commit; the reaction belongs to the PR. Two open
  // PRs on one head cannot both be described by one status, so approve
  // neither — blocking asks a human to look, where the alternative is a merge
  // justified by another PR's review.
  if (sharedHead) {
    return {
      state: "failure",
      description: "Head shared with another open PR — verdict is ambiguous",
    };
  }

  // Someone asked for a look. Blocking rather than pending, so it reads as a
  // deliberate hold rather than something still on its way.
  if (held) {
    return { state: "failure", description: `On hold: ${held} on the pull request` };
  }

  // Codex still reading is the answer being written, not a hold: `pending`,
  // even over a 👍 (a re-read in progress revokes the old verdict's meaning
  // before it revokes the reaction). Pending is also what keeps the minute
  // loop running through the review, which is the loop's whole point — a
  // `failure` here would idle the loop precisely while the next minute could
  // change the answer.
  // A generated-only push carries the previous head's verdict: the lanes
  // engine vouched that this head is the one before it plus files CI
  // itself wrote back (see `carriedVerdict`), and Codex's answer on that
  // head is what `carried` names. It outranks a read in progress on
  // purpose -- Codex re-reading a diff of rendered images is the
  // revocation-on-push this exists to survive, and holding the gate for it
  // is the wait it exists to end -- but not findings Codex actually left on
  // THIS head, nor a hold above or an owner's nudge, which are asks about
  // this head that a verdict on the previous one cannot answer.
  if (carried && !findings && !nudged) {
    return { state: "success", description: `Codex reviewed ${carried}; verdict carried across generated files` };
  }

  if (reading) return { state: "pending", description: PENDING };

  // The owner asked for another look, and the ask is newer than Codex's
  // last word — including a standing 👍. Honoring the old approval while a
  // re-review is pending is a merge nobody wants anymore, so the gate
  // closes until the fresh answer lands; a new 👍 postdating the nudge
  // reopens it through `approved` on a later sweep.
  if (nudged) return { state: "pending", description: PENDING };

  if (approved) {
    return { state: "success", description: "Codex reviewed this head, no findings" };
  }

  // Approval outranks findings on purpose: after a fix-and-nudge round the
  // old review still names this head, and the fresh 👍 is Codex saying it is
  // satisfied. The caller only sets `approved` when the 👍 is strictly newer
  // than Codex's last written word on the head (see `judge`), so the standing
  // order here never lets a leftover reaction outrank findings that came
  // after it. Reading outranks both — a re-read is the verdict changing.
  if (findings) return { state: "pending", description: FINDINGS };

  // Below findings on purpose: a head Codex left findings on HAS been
  // answered, whatever its age. This is only for the head nothing ever came
  // back about.
  if (unanswered) return { state: "pending", description: unanswered };

  return { state: "pending", description: PENDING };
}

const PAGE = `pageInfo { hasNextPage endCursor }`;

const OPEN_PRS = `
query($owner:String!, $name:String!, $after:String) {
  repository(owner:$owner, name:$name) {
    pullRequests(states:OPEN, first:50, after:$after) {
      ${PAGE}
      nodes {
        number
        isDraft
        headRefOid
        headRefName
        baseRefName
        createdAt
        isCrossRepository
        updatedAt
        commits(last:1) { nodes { commit { committedDate } } }
        forcePushes: timelineItems(itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT], last:1) {
          nodes { ... on HeadRefForcePushedEvent { createdAt } }
        }
        retargets: timelineItems(itemTypes:[BASE_REF_CHANGED_EVENT], last:1) {
          nodes { ... on BaseRefChangedEvent { createdAt } }
        }
        reactions(first:100) { ${PAGE} nodes { content createdAt user { login } } }
      }
    }
  }
}`;

const MORE_REACTIONS = `
query($owner:String!, $name:String!, $number:Int!, $after:String!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      reactions(first:100, after:$after) { ${PAGE} nodes { content createdAt user { login } } }
    }
  }
}`;

/** Thin GitHub client, so the sweep can be driven by a fake `fetch` in tests. */
export function createApi({ token, fetchImpl = fetch }) {
  async function rest(path, { method = "GET", body } = {}) {
    const res = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    // Name the failed call and its status; never the token or the raw body.
    if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  async function graphql(query, variables) {
    const out = await rest("/graphql", { method: "POST", body: { query, variables } });
    if (out.errors?.length) throw new Error(`graphql: ${out.errors[0].message}`);
    return out.data;
  }

  return { rest, graphql };
}

/**
 * What the PR-body reactions say: Codex's verdict, and any hold on it.
 *
 * `since` is when GitHub first saw a commit status on this head — the
 * earliest status of ANY context, not just ours. Codex revokes its 👍 when
 * a new commit lands, but *asynchronously* — it has to notice the push
 * first — so for a few seconds or minutes the PR carries a new head and the
 * previous head's reaction, and reading those together approves a commit
 * nobody reviewed. A reaction newer than `since` cannot be that: any status
 * is server-stamped proof the head already existed.
 *
 * Any context, because our own first write can be LATE — a delayed first
 * sweep — and a 👍 that arrived before it would then sit below the bound
 * forever, unrevivable, with the gate stuck at pending. A third party's
 * status (a deploy, classic CI) lands seconds after the push, well before
 * Codex's earliest possible reaction, so in practice the bound predates
 * every genuine 👍; where that still dates the head too late, `judge`
 * retries with the head's check suites (see `earliestCheckSuite`), and
 * floors everything at the last force-push so a recycled commit's old
 * records cannot resurrect a previous life's approval. The bound is a server timestamp rather than the commit's
 * `committedDate` because a commit date is set by whoever makes the commit
 * (`--date`, or a prebuilt commit), and forged early it would make a stale
 * 👍 read fresh — the one failure that opens the gate. The comment walk
 * makes the opposite choice, and `commentSignals` says why the safe bound
 * differs by direction. No statuses at all means nothing dates the head,
 * and the answer to that is `pending` — this sweep writes the first status,
 * and a fresh reaction after it can approve on a later sweep.
 *
 * Holds come only from the repository owner, plus Codex's own 👀. On a public
 * repo any account can react, and a hold deliberately survives head changes,
 * so an unrestricted hold lets a passer-by block a PR indefinitely. Codex's
 * 👀 is included because it means "still reading" — it clears that when it
 * reacts 👍 — and it is not a passer-by.
 *
 * Holds are deliberately NOT filtered by time: a 👎 left on an earlier head is
 * still someone saying don't merge this, and a new commit is not an answer to
 * it. That errs toward blocking, which is the safe direction here.
 */
export function readReactions(nodes, { since, owner } = {}) {
  let approved = false;
  let approvedAt = null;
  let staleApproval = false;
  let unverifiedApproval = false;
  let held = null;
  let reading = false;
  const bound = utc(since);
  for (const r of nodes ?? []) {
    const login = r.user?.login;
    // Login alone is the CANDIDATE test — it settles the 👀, which can only
    // hold the gate closed, and for the 👍 it settles nothing: see the
    // `matchesBot` call below.
    const codex = matchesBotLogin(login);
    const at = utc(r.createdAt) ?? "";
    // A missing bound or reaction time both mean "cannot show this reaction
    // is about this head", and the answer to that is `pending` rather than a
    // merge — an unexpected result must not be what opens the gate.
    const fresh = Boolean(bound) && at > bound;
    // The 👍 must be Codex's: it is only a verdict because Codex revokes it
    // on push, and nobody else's does that. Its time is kept because a
    // clean pass leaves no review or comment — the 👍 IS Codex's last word,
    // and a nudge is only pending while it is newer than that word.
    if (r.content === "THUMBS_UP" && codex) {
      // Codex's login, but is it Codex's ACCOUNT? App slugs and usernames
      // are separate namespaces, so a human registered under the bot's name
      // is a 👍 away from opening the gate — the one fail-open direction
      // this file has. GraphQL cannot answer that (`matchesBotLogin`), so a
      // 👍 arriving without type evidence approves nothing here and instead
      // asks the caller for the REST reading of this same list, where the
      // account type is real. Freshness is not even considered yet: the
      // stale-👍 rescue below feeds the check-suite lookup, and paying for
      // that on an unattributed reaction would be work done for a signal
      // that may turn out to be a stranger's.
      if (!matchesBot(r.user)) {
        unverifiedApproval = true;
      } else if (fresh) {
        approved = true;
        if (approvedAt === null || at > approvedAt) approvedAt = at;
      } else {
        // A Codex 👍 rejected only for freshness. The caller uses this to
        // decide whether a better birth record (a check suite) could
        // change the answer — see `judge` — so the expensive lookup is
        // paid only when it could matter.
        staleApproval = true;
      }
    }
    const mayHold = Boolean(owner) && login === owner;
    if (r.content === "THUMBS_DOWN" && mayHold) held = "👎";
    if (r.content === "EYES" && mayHold && held === null) held = "👀";
    // Codex's own 👀 is the review in flight, not a hold: it blocks approval
    // the same way, but as `pending` rather than `failure`, because pending
    // is what keeps the minute loop polling — Codex swaps 👀 for 👍 with no
    // webhook, and a loop that had already gone idle would leave that 👍
    // waiting on the throttled schedule.
    if (r.content === "EYES" && codex) reading = true;
  }
  return { approved, approvedAt, staleApproval, unverifiedApproval, held, reading };
}

/**
 * Every page of PR-body reactions, from the GraphQL connection the PR list
 * already carried.
 *
 * No short-circuit on finding the thumbs-up: a hold can be on a later page,
 * and stopping early would approve over it. Missing the thumbs-up entirely
 * leaves the status `pending` — safe, but it never clears on its own, and
 * every later sweep refetches the same truncated page.
 *
 * The nodes rather than a verdict, because one sweep reads the same list
 * against as many as three bounds — a check-suite birth record can move the
 * bound in either direction — and each of those readings used to re-walk
 * the pagination for a list that cannot change inside one sweep.
 */
export async function reactionNodes(api, base, { owner, name, number }) {
  const all = [...(base?.nodes ?? [])];
  let page = base;
  while (page?.pageInfo?.hasNextPage) {
    const data = await api.graphql(MORE_REACTIONS, {
      owner, name, number, after: page.pageInfo.endCursor,
    });
    page = data.repository.pullRequest.reactions;
    all.push(...(page?.nodes ?? []));
  }
  return all;
}

/**
 * REST's names for the three reaction contents this file reads. Anything
 * else passes through unmapped: it matches no rule in `readReactions`
 * either way, and inventing a name for it would only hide a future content
 * GitHub adds.
 */
const REST_REACTION_CONTENT = { "+1": "THUMBS_UP", "-1": "THUMBS_DOWN", eyes: "EYES" };

/**
 * The same PR-body reactions, read from REST — the channel that can say WHO
 * reacted.
 *
 * This is the one thing REST has that GraphQL does not: `Reaction.user` in
 * GraphQL is the concrete `User` type, so its `__typename` is a schema
 * constant and a bot is indistinguishable from a human of the same name
 * (see `matchesBotLogin`). REST returns the reactor as a simple-user, which
 * spells a bot's login with the `[bot]` suffix — illegal in a username, so
 * self-certifying — and carries `user.type` saying `Bot` besides. Either is
 * enough for `matchesBot`; both being absent fails closed, which is a
 * pending gate rather than a merge.
 *
 * PR-body reactions live on the ISSUE endpoint — a pull request is an issue
 * for everything that is not the diff — and the same reactions the GraphQL
 * connection returns come back here.
 *
 * Called only when a 👍 under Codex's login is actually in play, so the
 * ordinary sweep (no verdict yet, or a verdict already answered by findings)
 * pays nothing for it: one extra call while a clean pass stands, per head,
 * per sweep, and none otherwise. Shaped like the GraphQL nodes so
 * `readReactions` stays one reader with one set of rules.
 */
export async function restReactions(api, { owner, name, number }) {
  const all = [];
  for (let page = 1; ; page += 1) {
    const batch = await api.rest(
      `/repos/${owner}/${name}/issues/${number}/reactions?per_page=100&page=${page}`,
    );
    for (const r of batch ?? []) {
      all.push({
        content: REST_REACTION_CONTENT[r.content] ?? r.content,
        createdAt: r.created_at,
        user: r.user,
      });
    }
    if (!batch || batch.length < 100) return all;
  }
}

/** Head SHAs carried by more than one open PR. */
export function sharedHeads(prs) {
  const seen = new Map();
  for (const pr of prs) seen.set(pr.headRefOid, (seen.get(pr.headRefOid) ?? 0) + 1);
  return new Set([...seen].filter(([, n]) => n > 1).map(([oid]) => oid));
}

/**
 * A head's status history: every `codex` status newest first, plus the
 * created time of the earliest status of ANY context.
 *
 * The newest `codex` entry is what this sweep compares against so it does
 * not rewrite an identical status. `firstSeen` is the reaction-freshness
 * bound — see `readReactions` for why it spans every context: any status is
 * server-stamped proof the head existed by then, and a third party's lands
 * seconds after the push, before our own first write can (a delayed first
 * sweep would otherwise date the head too late and invalidate a 👍 that
 * arrived first, permanently).
 *
 * Paged to the end, because the endpoint returns *every* context, so a page
 * can be full of statuses that are not ours while older ones sit behind it.
 * Missing the tail is not a harmless truncation: a too-late bound rejects
 * an existing 👍 on every later sweep. The cap is a backstop against an
 * endless loop, not an expected limit.
 */
export async function codexStatuses(api, { owner, name, sha }) {
  const mine = [];
  const lanes = [];
  let firstSeen = null;
  for (let page = 1; page <= 10; page += 1) {
    const batch = await api.rest(`/repos/${owner}/${name}/statuses/${sha}?per_page=100&page=${page}`);
    for (const s of batch ?? []) {
      if (s.context === CONTEXT) mine.push(s);
      if (LANES_CONTEXTS.includes(s.context)) lanes.push(s);
      const t = utc(s.created_at);
      if (t && (firstSeen === null || t < firstSeen)) firstSeen = t;
    }
    if (!batch || batch.length < 100) break;
  }
  return { mine, firstSeen, carrier: carriedClaim(lanes) };
}

// --- Carrying a verdict across a generated push ------------------------------

/**
 * The status contexts the lanes engine (mikelward/lanes) publishes, in the
 * order a carried verdict is read from them: `lanes-attest` is the heavy
 * jobs' verdict posted before any job that writes generated files back,
 * `lanes` the required check itself. Newest per context wins, and the
 * attestation outranks the required check because the required check on
 * a head that is itself about to be pushed onto stays pending until that
 * push is done.
 */
export const LANES_CONTEXTS = ["lanes-attest", "lanes"];

/**
 * How the lanes engine describes a verdict it carried forward: the push
 * that made this head added only files a `generated` rule names, on top of
 * a head the engine had already vouched for, and the description names
 * that head. The wording is the engine's `describeVerdict`, matched at the
 * start so the `[base <sha>]` marker it appends is not part of the claim.
 */
const CARRIED_RE = /^Generated-only push; verdict carried forward from ([0-9a-f]{7,40})\./;

/**
 * The bot a workflow's own token posts as. A pull request's own workflow
 * under `pull_request` holds that token with whatever `statuses: write` it
 * grants itself, so a status it posts is the forgery route the README's
 * "Binding the status against collaborators" describes -- never a witness.
 */
const ACTIONS_BOT = "github-actions[bot]";

/**
 * What the newest lanes status on a head claims, or null: the short SHA of
 * the head whose verdict it says it carried, and the status itself for the
 * checks `carriedVerdict` still has to make. A status that is not green, or
 * says anything but the carried-forward sentence, claims nothing -- a
 * docs-only skip, a fresh verdict and a failure all take the ordinary path.
 */
export function carriedClaim(statuses) {
  for (const context of LANES_CONTEXTS) {
    // Newest first, as GitHub lists them; the first entry per context stands.
    const status = (statuses ?? []).find((s) => s?.context === context);
    if (!status) continue;
    if (status.state !== "success") return null;
    const m = CARRIED_RE.exec(status.description ?? "");
    return m ? { from: m[1], status } : null;
  }
  return null;
}

/**
 * The App each required check on a branch is bound to, context -> its
 * integration id, with null for a check required from any source; a
 * check not required at all is absent. `GET /rules/branches` reports the
 * effective rules, repository and organization rulesets alike, and needs
 * no permission beyond the token's own metadata read. One read per base
 * per sweep answers for every context the carry asks about.
 */
export async function boundAppsFromRules(api, { owner, name, base }) {
  const rules = await api.rest(`/repos/${owner}/${name}/rules/branches/${encodeURIComponent(base)}`);
  const bound = new Map();
  for (const rule of rules ?? []) {
    if (rule?.type !== "required_status_checks") continue;
    for (const check of rule.parameters?.required_status_checks ?? []) {
      if (check?.context && !bound.has(check.context)) bound.set(check.context, check.integration_id ?? null);
    }
  }
  return bound;
}

/**
 * The integration id behind a status creator's bot login (`<slug>[bot]`),
 * or null. A ruleset names an App by that id; `GET /apps/{slug}` is the
 * public record joining the two. Cached by slug across a sweep, a failed
 * read included, so every head asking about the same App gets the same
 * answer without a second call.
 */
export function appIdOf(api, creator, cache) {
  const slug = stripBot(creator?.login ?? "");
  if (!slug) return Promise.resolve(null);
  if (!cache.has(slug)) cache.set(slug, api.rest(`/apps/${encodeURIComponent(slug)}`).then((app) => app?.id ?? null));
  return cache.get(slug);
}

/**
 * The verdict this head inherits, as the short SHA of the head it was
 * earned on, or null with the reason logged.
 *
 * The lanes engine already proved the hard part before it published the
 * claim: the push was a `synchronize` whose range adds only paths a
 * `generated` rule names, made by an administrator or the App itself, onto
 * a head carrying the App's own green -- and it refuses the carry while the
 * policy is under review. What is left to establish here is that the claim
 * is the engine's and that Codex had in fact approved the head it names.
 *
 * - **The claim's author.** The context name proves nothing: any workflow
 *   holding `statuses: write` can post a `lanes` status saying whatever it
 *   likes, and a pull request's own workflow holds that token. So the
 *   creator must be an App -- `type: Bot`, and never the workflow bot -- and
 *   exactly the App the base branch's rules bind `lanes` to, matched
 *   through its integration id. Where the rules bind it to no App, no
 *   claim is trusted: the carry is opt-in per repository, by the ruleset
 *   binding the required check to the App (maintainer, 2026-09-05).
 * - **The claim's age.** A retarget changes the reviewed diff under an
 *   unchanged head, and the ordinary path floors every signal at it; a
 *   claim posted before the latest retarget vouches for the old diff and
 *   is refused the same way.
 * - **The verdict it names is this pull request's.** A status belongs to
 *   the commit, and a commit can have been another pull request's head
 *   first (the reused-head window in docs/CONSUMER.md), so the named head
 *   must be one of this pull request's own commits, its `codex: success`
 *   must postdate both the pull request's creation and its latest
 *   retarget, and a check suite born on this pull request's own branch
 *   must record the named head reaching that branch BEFORE the approval
 *   was written -- the same server-stamped record `judge` dates a head's
 *   arrival by, floored at the branch's last force-push as `judge` floors
 *   it, so a suite from an earlier tenure of the branch is not tenure. Ancestry and overlap alone would still admit a verdict
 *   another pull request earned on the same history, if this one were
 *   later force-pushed onto its carried head.
 * - **The verdict it names.** The newest `codex` status on the named head
 *   must be `success` -- this action's own last word there -- and nothing
 *   may have moved the answer since it was written: no Codex review of that
 *   head, no Codex comment on the pull request, and no owner nudge, from
 *   the status onward. A finding or a re-review ask that landed between
 *   the last sweep and the push would otherwise ride the carry -- the
 *   status predates it, and the new head's own walk starts at the new
 *   head's birth, after it. The combined-status read returns the head's
 *   full SHA, which the review's commit id is compared against.
 *
 * Every failure is a refusal with a logged reason, never a throw: the head
 * then takes the ordinary path and waits for Codex's own answer, which is
 * exactly what it did before this existed.
 */
/** Whether `sha` is one of the pull request's own commits (first 300). */
export async function prHasCommit(api, { owner, name, number, sha }) {
  for (let page = 1; page <= 3; page += 1) {
    const batch = await api.rest(`/repos/${owner}/${name}/pulls/${number}/commits?per_page=100&page=${page}`);
    if ((batch ?? []).some((c) => c?.sha === sha)) return true;
    if (!batch || batch.length < 100) return false;
  }
  return false;
}

export async function carriedVerdict(api, {
  owner, name, number, base, branch = null, head, carrier, createdAt = null, retargetedAt = null, movedAt = null,
  cache, log,
}) {
  const { from, status } = carrier;
  const refuse = (why) => {
    log(`#${number}: lanes carries ${from} onto this head, but ${why} — not carrying Codex's verdict`);
    return null;
  };
  // A tie is stale, as everywhere else: GitHub stamps to the second, and an
  // unresolved order must not be what opens the gate.
  const claimedAt = utc(status.created_at);
  if (retargetedAt !== null && (claimedAt === null || claimedAt <= retargetedAt)) {
    return refuse("the claim predates the pull request's latest retarget, so it vouches for another diff");
  }
  const creator = status.creator ?? {};
  if (creator.type !== "Bot" || !creator.login || creator.login === ACTIONS_BOT) {
    return refuse(`the claim was posted by ${JSON.stringify(creator.login ?? "")}, not by an App`);
  }
  if (!base) return refuse("the pull request names no base branch to read the rules of");
  // Each read below refuses on failure rather than failing the head: a
  // branch with no readable rules, an App with no public record, a short
  // SHA GitHub cannot resolve are all "cannot establish the claim", and
  // the head still has its ordinary path. The next sweep asks again.
  if (!cache.rules.has(base)) cache.rules.set(base, boundAppsFromRules(api, { owner, name, base }));
  let bound;
  try {
    bound = await cache.rules.get(base);
  } catch (err) {
    return refuse(`the rules for ${base} could not be read (${err.message})`);
  }
  const integrationId = bound.get("lanes") ?? null;
  // The carry is opt-in per repository, by binding the required `lanes`
  // check to the lanes App in the ruleset: where the rules bind it to no
  // App, any workflow holding `statuses: write` could post the claim,
  // and no claim is trusted (maintainer, 2026-09-05: carry only once the
  // repository is hardened, one ruleset at a time).
  if (integrationId === null) {
    return refuse(`the rules for ${base} bind lanes to no App, so no claim is trusted there yet`);
  }
  let appId;
  try {
    appId = await appIdOf(api, creator, cache.apps);
  } catch (err) {
    return refuse(`the App behind ${creator.login} could not be read (${err.message})`);
  }
  if (appId !== integrationId) {
    return refuse(`the rules for ${base} bind lanes to App ${integrationId}, which ${creator.login} is not`);
  }
  let combined;
  try {
    combined = await api.rest(`/repos/${owner}/${name}/commits/${from}/status`);
  } catch (err) {
    return refuse(`the status of ${from} could not be read (${err.message})`);
  }
  const codex = (combined?.statuses ?? []).find((s) => s?.context === CONTEXT);
  if (!codex || codex.state !== "success") {
    return refuse(`the codex status on ${from} is ${JSON.stringify(codex?.state ?? "absent")}, not success`);
  }
  const fullFrom = combined?.sha;
  if (!fullFrom) return refuse(`the combined status for ${from} names no commit`);
  // Where the rules bind `codex` to an App, the source status has to be
  // that App's: any other writer's `codex: success` on the source is one
  // branch protection would have refused, and carrying it would republish
  // it under this action's own identity (Codex round 7). Unbound, the
  // status is whatever writer the repository trusts for it -- this action
  // itself, ordinarily.
  const codexAppId = bound.get(CONTEXT) ?? null;
  if (codexAppId !== null) {
    const poster = codex.creator ?? {};
    if (poster.type !== "Bot" || !poster.login) {
      return refuse(`the codex status on ${from} was posted by ${JSON.stringify(poster.login ?? "")}, not by an App`);
    }
    let posterId;
    try {
      posterId = await appIdOf(api, poster, cache.apps);
    } catch (err) {
      return refuse(`the App behind ${poster.login} could not be read (${err.message})`);
    }
    if (posterId !== codexAppId) {
      return refuse(`the rules for ${base} bind codex to App ${codexAppId}, which ${poster.login} is not`);
    }
  }
  // And it has to be THIS pull request's verdict, said so by the writer
  // rather than inferred from the clock. `publish` stamps every success
  // with the number of the pull request it was earned by, and only ever
  // writes on that pull request's own head -- so a success naming this
  // number on the source is the record that the source was this pull
  // request's head when it was written, which no timestamp bound could
  // establish (Codex round 9: a check suite's birth is a delayed record of
  // the push, so a verdict another pull request earned on the source in
  // that delay satisfied every ordering test).
  const earnedBy = stampedNumber(codex.description);
  if (earnedBy !== number) {
    return refuse(
      earnedBy === null
        ? `the codex status on ${from} names no pull request, so it cannot be told from one another pull request earned`
        : `the codex status on ${from} was earned by #${earnedBy}, not this pull request`,
    );
  }
  // The bound is the second BEFORE the status: both readers below drop a
  // signal stamped equal to their bound, and GitHub stamps to the second,
  // so a finding or a nudge in the status's own second would otherwise
  // vanish between this walk and the new head's, which starts after the
  // push. A tie is an unresolved order, and ambiguity must not be what
  // opens the gate -- the same rule the retarget and nudge ties follow.
  const approvedAt = utc(codex.created_at);
  const approvedMs = approvedAt === null ? NaN : Date.parse(approvedAt);
  if (Number.isNaN(approvedMs)) return refuse(`the codex status on ${from} carries no readable time`);
  // The verdict has to be THIS pull request's: earned after it was opened
  // and after its latest retarget, on a commit that is its own. A status
  // belongs to the commit, so one earned while the commit was another
  // pull request's head, or under another base, would otherwise ride.
  const openedAt = utc(createdAt);
  if (openedAt === null) return refuse("the pull request's creation time is unknown");
  if (approvedAt <= openedAt) return refuse(`${from} was approved before this pull request was opened`);
  if (retargetedAt !== null && approvedAt <= retargetedAt) {
    return refuse(`${from} was approved before this pull request's latest retarget`);
  }
  // And before the claim was posted: the claim vouches for a verdict that
  // existed when the engine carried it, not one another pull request
  // earned on the same commit later. A tie is an unresolved order.
  if (claimedAt === null || approvedAt >= claimedAt) {
    return refuse(`${from} was approved at or after the claim was posted, so the claim carried no verdict`);
  }
  if (!(await prHasCommit(api, { owner, name, number, sha: fullFrom }))) {
    return refuse(`${from} is not one of this pull request's commits`);
  }
  // Ancestry and overlap are not tenure: this pull request could have been
  // force-pushed onto a head another pull request earned the carry on. A
  // suite born on THIS branch for the named head is the server's record
  // that it was this branch's head, and it has to predate the approval.
  // A fork head has no branch-born suite, and fails closed here exactly
  // as its 👍 does in `judge`. Floored at the branch's last force-push
  // for the reason `judge` floors every birth there: a suite from an
  // earlier tenure of the branch -- the named head pushed, moved away
  // from, approved as another pull request's head, then force-pushed
  // back onto -- would otherwise predate a foreign approval and vouch for
  // it; the re-arrival's own suite postdates it and does not. Floored at
  // the pull request's opening as well: `movedAt` records force-pushes,
  // and a branch that held the named head before this pull request
  // existed, then opened on an ancestor and fast-forwarded back, moved
  // by no force-push at all -- its pre-opening suite would vouch the
  // same way.
  if (!branch) return refuse("the pull request names no head branch to date the named head's tenure by");
  const tenure = await checkSuiteBirths(api, {
    owner, name, sha: fullFrom, branch, since: laterOf(movedAt, openedAt),
  });
  if (tenure.forBranch === null || tenure.forBranch >= approvedAt) {
    return refuse(`no check suite records ${from} on this pull request's branch before it was approved`);
  }
  // What used to stand here -- this head's own arrival on the branch having
  // to postdate the approval -- is gone, and the stamp above replaced it.
  // It was reaching for the same fact and could not prove it: a check
  // suite is born some time AFTER the push it belongs to (this file says so
  // itself, in `judge`), so a verdict another pull request earned on the
  // source inside that delay passed the test. The stamp settles by record
  // what the ordering could only guess at, and costs a read fewer.
  const beforeApproval = new Date(approvedMs - 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  // Everything said about the named head since its status: findings in the
  // review streams, the owner's nudge, and Codex's word in either comment
  // stream -- against the newest clean verdict naming that head. The status
  // itself does not move when Codex re-reads and passes (`publish` leaves
  // an identical success alone), so the newest word is what says whether an
  // objection still stands, exactly as the ordinary path weighs them; a
  // nudge Codex has already answered would otherwise cost the carry and
  // buy a redundant re-review (Codex round 8). A tie refuses, as ties do
  // everywhere here.
  const said = await codexCommentSignals(api, {
    owner, name, number, since: beforeApproval, head: fullFrom,
  });
  const reviewed = await codexReviewedAt(api, {
    owner, name, number, headRefOid: fullFrom, since: beforeApproval,
  });
  const objection = laterOf(said.nudgeAt, said.codexAt, reviewed);
  if (objection !== null && (said.cleanAt === null || said.cleanAt <= objection)) {
    const what =
      objection === reviewed
        ? `Codex left findings on ${from} after that status was written`
        : objection === said.nudgeAt
          ? `the owner asked for a re-review after ${from} was approved`
          : `Codex commented on the pull request after ${from} was approved`;
    return refuse(said.cleanAt === null ? what : `${what}, and no clean verdict has answered it since`);
  }
  return from.slice(0, 7);
}

/**
 * The head's check-suite birth records: `any` is the created time of its
 * earliest suite from any branch, `forBranch` the earliest born on the
 * given branch. Either is null when no such suite exists.
 *
 * The other server-stamped birth records, and they cut both ways. Suites
 * are created when the commit is pushed, by Actions or any checks app, so
 * `any` dates a head on repos whose CI never writes a commit status — and
 * it can predate a status that merely landed late, rescuing a genuine 👍
 * (gating that rescue on "were all the statuses ours" was tried and is
 * wrong — a slow deploy status arriving AFTER the 👍 suppressed the lookup
 * while still dating the head too late, sticking the gate at pending
 * forever). `forBranch` dates the moment the commit reached THIS branch:
 * a fast-forward onto a pre-existing commit leaves no timeline event, so
 * the suite its arrival triggers is the only server-stamped record of the
 * transition — the floor that keeps the previous head's lingering 👍 from
 * approving a commit nobody reviewed. Fetched only when a 👍 is in play
 * (see `judge`), so an ordinary sweep never pays the call. `head_branch`
 * is a bare branch name — GitHub reports null for fork heads, so a fork
 * head never yields a `forBranch` and `judge` fails it closed: its 👍
 * cannot open the gate, and fork contributions merge by admin override or
 * a same-repo re-push.
 */
export async function checkSuiteBirths(api, { owner, name, sha, branch, since }) {
  let any = null;
  let forBranch = null;
  const floor = utc(since);
  for (let page = 1; page <= 10; page += 1) {
    const batch = await api.rest(`/repos/${owner}/${name}/commits/${sha}/check-suites?per_page=100&page=${page}`);
    const suites = batch?.check_suites ?? [];
    for (const s of suites) {
      const t = utc(s.created_at);
      if (!t) continue;
      // Suites from before the last force-push belong to a previous life of
      // the branch. The subtle revisit: rewind to an ancestor (a force-push,
      // leaving the event), earn a 👍 there, then fast-forward BACK to the
      // original SHA — the return leaves no event and the SHA already has a
      // branch-born suite from its first tenure, which would date the
      // arrival too early and let the rewound head's 👍 approve it. Any
      // same-branch revisit necessarily implies a force-push somewhere
      // between the tenures, so suites after the last one are exactly the
      // current life's; the re-arrival's own workflow runs mint fresh
      // suites within seconds, and until one exists the head is undatable
      // and fails closed.
      if (floor && t < floor) continue;
      if (any === null || t < any) any = t;
      if (branch && s.head_branch === branch && (forBranch === null || t < forBranch)) {
        forBranch = t;
      }
    }
    if (suites.length < 100) break;
  }
  return { any, forBranch };
}

/** Write the status unless an identical one is already on the head. */
/**
 * The pull request a `success` was earned by, appended to its description.
 *
 * A status belongs to the COMMIT, and says nothing about which pull request
 * earned it -- which is the whole difficulty the carry kept running into:
 * three rounds of review (6, 7 and 9) each bounded the source approval by
 * another timestamp, trying to establish from the outside what the writer
 * knew all along. This records it instead.
 *
 * Sound because of where the write happens: this action only ever posts to
 * `pr.headRefOid`, so a success naming #N on commit S is the server's
 * record that S was #N's head when it was written. No other pull request's
 * verdict can wear this mark, and no clock has to be trusted to tell them
 * apart.
 *
 * Only a success is stamped. `pending` and `failure` descriptions are read
 * back by the parked-marker and findings checks, which match on exact
 * strings, and neither is ever carried.
 */
export function stamp(description, number) {
  return `${description} (#${number})`;
}

/**
 * The pull request number a stamped description names, or null.
 */
export function stampedNumber(description) {
  const m = /\(#(\d+)\)$/.exec(String(description ?? ""));
  return m ? Number(m[1]) : null;
}

export async function publish(api, { owner, name, pr, verdict, current, log }) {
  const description =
    verdict.state === "success" ? stamp(verdict.description, pr.number) : verdict.description;
  // Every write shows up in the PR's check list, and a five-minute cadence
  // would otherwise bury it. It also keeps the marker still: rewriting the
  // same status would move the head's earliest-gated timestamp forward.
  if (current?.state === verdict.state && current?.description === description) {
    log(`#${pr.number}: ${verdict.state} (unchanged)`);
    return false;
  }
  await api.rest(`/repos/${owner}/${name}/statuses/${pr.headRefOid}`, {
    method: "POST",
    body: { context: CONTEXT, state: verdict.state, description },
  });
  log(`#${pr.number}: ${verdict.state} — ${description}`);
  return true;
}

export async function sweep({
  owner, name, token, fetchImpl = fetch, log = console.log,
  streaks = new Map(), cadence = new Map(), revisitEvery = 5, now = Date.now,
}) {
  const api = createApi({ token, fetchImpl });
  const written = [];
  const failed = [];
  const open = [];
  let after = null;

  // Collect every open PR before judging any: whether a head is shared is a
  // fact about the set, not about one PR.
  for (;;) {
    const data = await api.graphql(OPEN_PRS, { owner, name, after });
    const { nodes, pageInfo } = data.repository.pullRequests;
    open.push(...nodes);
    if (!pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }

  const shared = sharedHeads(open);
  let awaiting = 0;
  // Read once per sweep: the App a base branch's rules bind `lanes` to, and
  // each App slug's integration id. Both are paid only on a head that
  // carries a claim.
  const carryCache = { rules: new Map(), apps: new Map() };

  // Judge one head; returns 1 if it is still awaiting Codex's answer.
  async function judge(node) {
    const sharedHead = shared.has(node.headRefOid);
    // Read the head's status history first: its earliest entry, whatever
    // the context, is what a reaction has to be newer than — so this has to
    // happen before the reactions are judged rather than at write time.
    const { mine, firstSeen, carrier } = await codexStatuses(api, { owner, name, sha: node.headRefOid });
    // When this SHA became this PR's head. A push can move the PR onto a
    // commit that already existed — whose statuses and check suites date
    // from its FIRST life, before the previous head's 👍. A force-push
    // leaves a server-stamped timeline event, so every birth bound below is
    // floored at the last one; but a FAST-FORWARD to a pre-existing commit
    // (a stacked branch graduating, say) leaves no timeline event at all,
    // and for that transition the floor comes from the head's check suites
    // instead: the suite born on THIS PR's own branch is created when the
    // commit reaches the branch, so it dates the transition where the
    // timeline cannot. The force-push floor can never hide a genuine
    // signal — a 👍 about this head postdates its arrival by construction.
    // The suite floor is an UPPER bound of the arrival, and that is a
    // deliberate trade: if suite creation is delayed past a genuine 👍
    // (Actions minutes behind on the very push Codex answered in minutes —
    // incident territory, since both fan out from the same event), the 👍
    // reads stale and the gate holds at pending until a nudge or push
    // refreshes the verdict. Visible and recoverable, where the
    // alternative — trusting a 👍 older than every record of the arrival —
    // is the silent merge of a commit nobody reviewed. No record GitHub
    // keeps is guaranteed to precede a fast-forward arrival, so there is
    // no sound earlier floor to prefer.
    const movedAt = newestIn(node.forcePushes);
    // A RETARGET is the other way this PR becomes a different thing to
    // review, and it is deliberately NOT `movedAt`. Pointing a PR at a new
    // base changes the reviewed diff — sometimes completely — while the
    // head SHA, its statuses and its check suites all stand still. Every
    // other bound here is derived from the head, so without this floor a
    // standing `codex: success` survives a base change and a diff nothing
    // has read stays mergeable. GitHub stamps it as a BaseRefChangedEvent,
    // so the moment is the server's rather than anything to persist here.
    //
    // Kept separate from `movedAt` because the suite machinery below reads
    // that as "when the head ARRIVED", and a retarget pushes nothing: no
    // new check suite is ever born for one. Feeding it in as a head
    // arrival would make every retargeted head undatable forever — a gate
    // that can never clear, which is worse than the hole it closes.
    const retargetedAt = newestIn(node.retargets);
    let bound = laterOf(firstSeen, movedAt, retargetedAt);
    // Don't read reactions when the shared head has already decided.
    const NO_REACTIONS = {
      approved: false, approvedAt: null, staleApproval: false,
      unverifiedApproval: false, held: null, reading: false,
    };
    // Fetched once and re-read locally against every bound below, so the
    // rebounds cost no calls at all.
    let reactions = sharedHead
      ? []
      : await reactionNodes(api, node.reactions, { owner, name, number: node.number });
    const readAt = (since) => readReactions(reactions, { since, owner });
    let seen = sharedHead ? NO_REACTIONS : readAt(bound);
    // A 👍 spelled with Codex's login but with nothing to say the account
    // behind it is Codex. GraphQL cannot answer that for any reactor, so
    // the whole list is re-read from REST, where a bot's login carries the
    // `[bot]` suffix a username may not — and `user.type` besides. One call,
    // paid only while a clean pass is actually standing on this head.
    if (seen.unverifiedApproval) {
      reactions = await restReactions(api, { owner, name, number: node.number });
      seen = readAt(bound);
      // Still unattributable after the channel that CAN attribute it: either
      // someone really did register Codex's name and react with it, or
      // GitHub changed what a reaction's user looks like. Failing closed is
      // right in both cases, and silence is not — a gate that will never
      // clear says so in the run log rather than being diagnosed by hand.
      if (seen.unverifiedApproval) {
        log(`#${node.number}: 👍 under Codex's login from an account REST does not report as a bot — not approving`);
      }
    }
    // A Codex 👍 in play — fresh-looking or stale — is the case where a
    // check-suite birth record can change the answer, in either direction:
    // a suite born on this branch AFTER the 👍 proves the head arrived by
    // fast-forward later than the statuses admit (the 👍 belongs to the
    // previous head, and trusting it merges a commit nobody reviewed), and
    // a suite born BEFORE a slow status rescues a genuine 👍 the statuses
    // date too late. Suites are fetched only in those two cases, so an
    // ordinary sweep never pays the call.
    let births = null;
    if (!sharedHead && (seen.approved || seen.staleApproval)) {
      births = await checkSuiteBirths(api, {
        owner, name, sha: node.headRefOid, branch: node.headRefName, since: movedAt,
      });
      // A same-repo head always earns a suite on its own branch within
      // seconds — this workflow's own pull_request_target run creates one
      // on the head SHA even where no other CI does — so a missing branch
      // suite means the transition cannot be dated yet: the signature of a
      // fast-forward onto a pre-stamped commit, judged in the gap before
      // its first branch suite. Whether the commit's OLD records are suites
      // or only statuses changes nothing, so no suites at all is the same
      // undatable gap, not a pass. Fail closed and let the next sweep read
      // the suite that is about to exist. Fork heads are undatable FOREVER
      // by this test — GitHub reports no head_branch for their suites — so
      // a fork PR's 👍 never opens this gate: their fast-forward transition
      // has no server-stamped record at all, and an earlier exemption that
      // fell back to the status bound was a fail-open hole wearing a
      // compatibility excuse. A fork contribution merges by an admin
      // override or by the owner re-pushing it to a same-repo branch,
      // where every floor applies.
      const undatable = births.forBranch === null;
      if (seen.approved) {
        if (births.forBranch !== null) {
          const confirmed = laterOf(bound, births.forBranch);
          if (confirmed !== bound) {
            bound = confirmed;
            seen = readAt(bound);
          }
        } else if (undatable) {
          // The 👍's own time goes too: it may be the previous head's last
          // word, and treating it as an answer would read this head as
          // settled findings instead of an unanswered wait.
          seen = { ...seen, approved: false, approvedAt: null, staleApproval: true };
        }
      }
      // The rescue: a 👍 rejected purely for freshness may be genuine, with
      // the head merely dated too late by a slow external status. An
      // earlier birth record — the earliest suite, floored at both the
      // force-push event and the branch-born suite so a recycled commit's
      // old records cannot resurrect a previous life's approval — can lower
      // the bound and revive it. An undatable head gets no rescue: lowering
      // its bound with a foreign branch's suite is the same hole again.
      if (!undatable && !seen.approved && seen.staleApproval) {
        // `retargetedAt` floors the rescue too. Without it the rescue is a
        // way back under the retarget floor: a 👍 from before a base change
        // is exactly a 👍 "rejected purely for freshness", so the rescue
        // would lower the bound to a suite born before the retarget and
        // revive an approval of the old diff.
        const better = laterOf(
          earlierOf(firstSeen, births.any),
          laterOf(movedAt, retargetedAt, births.forBranch),
        );
        if (better !== null && (bound === null || better < bound)) {
          bound = better;
          seen = readAt(bound);
        }
      }
    }
    const { approved, approvedAt, held, reading } = seen;
    // A generated-only push onto an approved head inherits that approval;
    // read only once the lanes engine has published the claim, and never
    // for a shared head, which fails closed above whatever it inherits.
    const carried = carrier && !sharedHead && !held
      ? await carriedVerdict(api, {
        owner, name, number: node.number, base: node.baseRefName, branch: node.headRefName,
        head: node.headRefOid, carrier, createdAt: node.createdAt, retargetedAt, movedAt, cache: carryCache, log,
      })
      : null;
    // The finding and nudge streams are fetched whenever they could change
    // the answer. That includes an APPROVED head: an owner nudge newer than
    // the 👍 must reopen the wait, or auto-merge honors a verdict the owner
    // has already asked to be redone. Only a shared head, a hold, and a
    // read in progress settle without the walk; the `since` bound keeps it
    // to a page in practice. A carried verdict outranks the read, so a head
    // carrying one walks through it: the nudge or finding that would hold
    // the carry back has to be seen to hold it.
    const undecided = !sharedHead && !held && (!reading || Boolean(carried));
    // Seeded from the reaction so the settle-without-the-walk paths below
    // (shared head, hold, read in progress) carry the same value they always
    // did; the walk can only add an attributable clean comment to it.
    let cleanlyApproved = approved;
    let findings = false;
    let nudged = false;
    let nudgeAt = null;
    let reviewedAt = null;
    if (undecided) {
      reviewedAt = await codexReviewedAt(api, {
        owner, name, number: node.number, headRefOid: node.headRefOid,
        since: retargetedAt,
      });
      // The comment walk is bounded by the EARLIER of the head commit's own
      // date and the head's first server-stamped status — then floored at
      // the head-moved time above. The commit date covers a finding that
      // lands before the first status write; the server timestamp covers a
      // commit date forged into the future, which would otherwise hide a
      // later owner nudge — on an approved head, that is a stale success
      // left open for auto-merge. Taking the earlier of the two only ever
      // admits more — see `commentSignals`.
      const bornAt = utc(node.commits?.nodes?.[0]?.commit?.committedDate);
      // Floored at the retarget for the same reason as the reviews above:
      // a comment finding from before a base change describes the old diff,
      // and counting it settles the head so the loop stops watching.
      const walkSince = laterOf(earlierOf(bornAt, firstSeen), movedAt, retargetedAt);
      const signals = await codexCommentSignals(api, {
        owner, name, number: node.number, since: walkSince, head: node.headRefOid,
      });
      const codexAt = signals.codexAt;
      nudgeAt = signals.nudgeAt;
      // Codex's last word on this head, wherever it was said: a review, a
      // comment, or — for a clean pass, which leaves neither — the 👍.
      const answeredAt = laterOf(reviewedAt, codexAt, approvedAt, signals.cleanAt);
      // A nudge newer than Codex's last word reopens the wait: the answer
      // is due again, exactly as during a read — so the head counts as
      // awaiting and the clock runs. Deriving this from the comments on
      // EVERY sweep is what makes it robust: the state survives however
      // the run was started, including a nudge run replaced in the
      // concurrency queue by a grace-less successor. A TIE reopens it too:
      // GitHub stamps to the second, so a nudge in the same second as the
      // standing 👍 is an unresolved ordering, and the ambiguity must not
      // be what leaves a success open — only an answer strictly newer than
      // the ask settles it.
      nudged = Boolean(nudgeAt) && (answeredAt === null || nudgeAt >= answeredAt);
      // An attributable clean comment approves this head exactly as the 👍
      // does. It is ANDed with the same hold and nudge checks by sitting in
      // `approved`, so a 👎, a 👀 or a newer nudge still outranks it.
      // Only when it is Codex's LATEST word. A clean comment followed by a
      // findings review on the same head -- an owner nudge is the ordinary
      // way -- must not keep approving: the reaction can outrank findings
      // because Codex re-adds it after a re-read, but a comment is a fixed
      // point in time and has to be compared as one.
      const answeredElsewhereAt = laterOf(reviewedAt, codexAt);
      const cleanIsLatest = Boolean(signals.cleanAt)
        && (answeredElsewhereAt === null || signals.cleanAt > answeredElsewhereAt);
      // The 👍 gets the same latest-word test as the clean comment. The
      // reaction can outrank an OLDER findings review — after a fix-and-nudge
      // round Codex re-adds it to say it is satisfied — but only recency
      // makes that safe: Codex provably revokes the reaction on push, not
      // when it later posts findings on the SAME head, so a 👍 older than
      // Codex's last written word may be a leftover those findings
      // superseded, and honoring it would hand auto-merge a success with an
      // unaddressed finding standing. A tie is an unresolved ordering —
      // GitHub stamps to the second — and ambiguity must not be what opens
      // the gate, the same rule the nudge tie already follows.
      const approvedIsLatest = approved
        && (answeredElsewhereAt === null
          || (approvedAt !== null && approvedAt > answeredElsewhereAt));
      cleanlyApproved = approvedIsLatest || cleanIsLatest;
      findings = !cleanlyApproved && Boolean(answeredAt) && !nudged;
    }
    // A marker is OUR record that this head waited out a full window with
    // nothing arriving -- and the ask it waited on is the nudge, so a nudge
    // OLDER than the marker is already accounted for by that wait. Only a
    // NEWER one is a fresh ask. Without this the head alternates: `nudged`
    // outranks `unanswered` in `verdictFor`, an unanswered nudge stays
    // `nudged` forever, so the sweep after the park rewrites PENDING,
    // re-anchors the window on that change, and the two swap every
    // UNANSWERED_MINUTES -- restarting polling each time and walking the
    // gate marker forward, which is what the stickiness exists to prevent.
    //
    // Read the NEWEST status only, deliberately. A transient override — a
    // shared head, a hold, UNREADABLE — displaces the marker, and reading
    // past it to restore the park is wrong for a reason that took three
    // rounds to surface: a status belongs to the COMMIT, so the marker
    // underneath may be a different pull request's, and on a shared head
    // that override is the only status dating THIS one's life. Restoring
    // there parks a brand-new pull request on sight. Telling the two apart
    // needs a park scoped to the pull request rather than the commit — the
    // arrival-dating gap tracked in TODO.md. Until that exists an override
    // costs the marker one window, which is the behavior before this change
    // and the cheaper of the two wrongs.
    const parkedAt = PARKED.has(mine[0]?.description) ? utc(mine[0].created_at) : null;
    const parkStands = parkedAt !== null && (nudgeAt === null || parkedAt > nudgeAt);
    const verdict = verdictFor({
      isDraft: false, approved: cleanlyApproved, sharedHead, held, reading,
      findings, nudged: nudged && !parkStands, carried,
      // Read back off the head rather than recomputed: see UNANSWERED for
      // why this has to be sticky. Everything that should clear it -- a
      // nudge, a push, an answer -- outranks it in `verdictFor` or arrives
      // as a different head with its own status.
      // Sticky in that we PARKED, not in what we said: the marker is a
      // function of this head's topology, so it is recomputed rather than
      // replayed. A commit carries its statuses, so one parked in a
      // same-repo pull request and later reused as a fork head would
      // otherwise inherit `@codex review` -- the instruction that cannot
      // work there -- without the escalation, which is topology-aware,
      // ever running again. Correcting it writes once and then stands:
      // the age anchor skips every marker, so nothing re-arms the window.
      // `parkStands` rather than a bare `PARKED.has`, though the two cannot
      // be told apart from outside: where they differ the nudge is newer,
      // and `nudged` then outranks this anyway. Same concept, named once.
      unanswered: parkStands ? marker(node) : null,
    });
    const changed = await publish(api, { owner, name, pr: node, verdict, current: mine[0], log });
    if (changed) written.push({ number: node.number, ...verdict });
    if (verdict.state !== "pending") return 0;
    // Eyes on means the review genuinely started. That used to keep a
    // reading head on the clock unconditionally -- long reads being what
    // the loop is for -- because the answer's arrival had no webhook: the
    // 👍 emits nothing, so polling through the read was the only way to
    // see it land.
    //
    // Codex's status table changed that premise. It says, per row and per
    // commit, whether this head's code review is still `Running`, and it is
    // EDITED to `Completed` when the answer arrives -- an `issue_comment`
    // event every consumer already triggers on. So a read whose end will
    // announce itself does not need the fast clock: park the head (still
    // `pending` -- nothing fails open) and let that edit be the wake.
    // Measured on a private sibling's pull request, 2026-09-02: the edit's
    // run published the verdict seven seconds after firing, while the poll
    // it replaced had already been cancelled in the concurrency queue.
    //
    // Only `running` parks. Null -- no table, an unreadable one, or a row
    // about a different commit -- keeps the old behavior, so a shape that
    // stops matching costs polling rather than correctness.
    if (reading) {
      const table = await codeReviewTableStatus(api, {
        owner, name, number: node.number, head: node.headRefOid,
      });
      if (table === "running") {
        log(`#${node.number}: Codex is still reading this head and says so — parking until it says otherwise`);
        return 0;
      }
      return 1;
    }
    if (verdict.description === FINDINGS && reviewedAt) return 0;
    // Everything else pending is a wait for an answer that arrives within
    // minutes of the event that asked for it — the push for a fresh head,
    // the nudge for a re-review, the push for the 👍 a comment-only finding
    // may still be followed by. Past UNANSWERED_MINUTES with no answer,
    // Codex is not coming on its own: park the head (still `pending` for
    // the gate — nothing fails open) and let the next event or scheduled
    // sweep be the retry, instead of a forgotten PR keeping every loop
    // alive to its cap forever.
    //
    // The age is server-anchored on the NEWEST of the head-birth bound, the
    // owner's last nudge, and our own latest status write. The last one is
    // what keeps a just-arrived head with ancient records — the fast-forward
    // shapes above, whose bound predates the arrival by days — from being
    // parked on sight: its first sweep writes `pending`, and the write both
    // keeps this sweep's clock (a changed status is a state that just
    // moved) and anchors the next sweeps' age, so every head gets a full
    // UNANSWERED_MINUTES from the moment this loop first gated it. The
    // identical-write skip in `publish` means nothing refreshes the anchor
    // while the state stands still, so the window cannot self-extend.
    if (changed) return 1;
    // The anchor is our last status write that MOVED the state, which an
    // escalation is not: it reports the wait rather than restarting it.
    // Counting it would reset the window the moment we gave up, and the
    // head would poll another full one -- and skipping the whole age path
    // instead (an early return on the escalated description) is worse: a
    // commit carries its statuses, so one reused as another pull request's
    // head, or fast-forwarded back onto a branch, arrives already wearing
    // this marker and would park on its first sweep, before Codex's pickup
    // window even opens. That is exactly what the branch-born-suite
    // re-anchor below exists to stop, so the path has to reach it.
    // Polling and the marker are complements: UNANSWERED means this loop
    // gave up, so EVERY path that keeps the clock running has to take it
    // back. A clear on only one of them is not cosmetic -- the head goes on
    // telling the maintainer to nudge a review that is running normally.
    // The shape that found this: `bound` includes `movedAt`, so a
    // force-push away and back onto an already-parked commit makes the
    // window fresh at the FIRST age check, above the branch-born re-anchor
    // where the clear originally lived alone.
    //
    // Guarded on the wording, because a comment-only finding reaches this
    // path too (the FINDINGS fast-exit needs `reviewedAt`, which a bare
    // comment has none of) and its accurate word must not be reopened.
    const stillPolling = async () => {
      if (PARKED.has(verdict.description)) {
        const fresh = { state: "pending", description: PENDING };
        if (await publish(api, { owner, name, pr: node, verdict: fresh, current: mine[0], log })) {
          written.push({ number: node.number, ...fresh });
        }
      }
      return 1;
    };
    const anchoring = mine.find((s) => !PARKED.has(s.description));
    let waitedSince = laterOf(bound, nudgeAt, utc(anchoring?.created_at));
    if (!waitedSince) return stillPolling();
    let ms = Date.parse(waitedSince);
    if (Number.isNaN(ms)) return stillPolling();
    if (now() - ms < UNANSWERED_MINUTES * 60_000) return stillPolling();
    // The park now SAYS the head is unanswered rather than leaving
    // `PENDING` standing, so the one state that needs a person is not
    // spelled the same as the ordinary wait. Same status, same permission,
    // different words.
    const escalate = async () => {
      // Only the ordinary wait gets renamed. A comment-only finding -- one
      // Codex left without submitting a review -- is why: the FINDINGS
      // fast-exit above needs `reviewedAt`, so that head reaches here still
      // described as FINDINGS, and saying it was never answered would be
      // false. It would also not STAY said: `findings` outranks `unanswered`
      // in `verdictFor`, so the next sweep writes FINDINGS back, that change
      // re-anchors the age, and the head flaps between the two every
      // UNANSWERED_MINUTES forever -- walking its gate marker forward each
      // time, which is exactly what the stickiness exists to prevent. Park it
      // as before, keeping the truer word.
      if (verdict.description !== PENDING) return 0;
      const said = { state: "pending", description: marker(node) };
      if (await publish(api, { owner, name, pr: node, verdict: said, current: mine[0], log })) {
        written.push({ number: node.number, ...said });
      }
      return 0;
    };
    // Looks expired — but a fast-forward can land a head already carrying
    // an identical old PENDING from a previous life, and then nothing
    // above refreshed the anchor: no reaction means the suites were never
    // read, publish skipped the identical write, and the head would park
    // on its first sweep, before Codex's pickup window even opens. One
    // suites call, paid only on this would-park path, re-anchors the age
    // on the branch-born suite — the arrival's own record.
    if (births === null && node.headRefName) {
      births = await checkSuiteBirths(api, {
        owner, name, sha: node.headRefOid, branch: node.headRefName, since: movedAt,
      });
    }
    waitedSince = laterOf(waitedSince, births?.forBranch);
    ms = Date.parse(waitedSince);
    // The re-anchor proved the arrival fresh after all, so this is a
    // polling path like the ones above and clears the marker the same way.
    // It cannot flap: the head then reads PENDING, the sticky read stops
    // firing, and the write becomes this arrival's own anchor -- which is
    // what every fresh head gets anyway.
    if (now() - ms < UNANSWERED_MINUTES * 60_000) return stillPolling();
    return escalate();
  }

  for (const node of open) {
    if (node.isDraft) {
      log(`#${node.number}: draft, skipped`);
      continue;
    }
    // Settled heads are re-read every `revisitEvery` sweeps, not every
    // minute. `cadence` is shared across the run's sweeps like `streaks`,
    // and this is the REST budget holding: judging a head costs several
    // calls, and a repo can hold many settled PRs beside the one the loop
    // is actually waiting on — rescanning all of them every 60s is what
    // would blow the 1,000-requests/hour GITHUB_TOKEN ceiling and turn
    // healthy heads unreadable.
    //
    // Three things bypass the slow path, because each is a change the very
    // next sweep must see: a new head (the SHA check), a still-awaiting or
    // failing head, and ANY activity on the PR — `updatedAt` moved. The
    // last one is what keeps a nudge honest while a loop is already
    // running: the nudge's own event run only QUEUES behind the concurrency
    // group, so the active loop is the one that has to notice, and an
    // approved head skipped for four more sweeps would leave a stale
    // success mergeable for minutes after the owner asked for a re-read. A
    // nudge is a comment, comments move `updatedAt`, and `updatedAt` rides
    // the PR list query already paid for — so noticing costs nothing. What
    // remains on the slow path is only the change that moves no timestamp
    // anywhere: a reaction added or removed, which was on the 15-minute
    // trickle before this PR existed and now waits at most `revisitEvery`
    // sweeps.
    const seen = cadence.get(node.number);
    const touched = utc(node.updatedAt);
    // Shared-head membership is topology on OTHER PRs: a duplicate closing
    // or moving away changes this head's verdict while its own SHA and
    // `updatedAt` stand still, and the event-triggered successor only
    // queues behind this run. The set is computed fresh each sweep from the
    // list query already paid for, so rejudging on a flip costs nothing —
    // without it a survivor sits on a stale shared-head failure for up to
    // `revisitEvery` sweeps.
    const sharedNow = shared.has(node.headRefOid);
    if (seen && seen.sha === node.headRefOid && !seen.awaiting && seen.updatedAt === touched
      && seen.shared === sharedNow) {
      seen.age += 1;
      if (seen.age < revisitEvery) continue;
      seen.age = 0;
    }
    // One head's failure must not end the run. The canonical case is real:
    // right after a force-push the statuses API can 422 ("no commit found")
    // until the new SHA replicates, and a run that dies on it goes red —
    // which notifies the owner — for something the next sweep repairs on
    // its own. So the failure is logged (the message carries the method,
    // path and code from `createApi`, never a token or a body), the head is
    // counted as awaiting so the minute loop itself is the retry, and the
    // other heads still get judged.
    //
    // Containment is not forgiveness. `streaks` is shared across the run's
    // sweeps (main passes one map to every call), and a head still failing
    // after MAX_FAIL_STREAK consecutive sweeps is a real error wearing a
    // transient's clothes — worse, its published status may be stale: a
    // `success` earned before a hold or a re-review request landed keeps
    // the gate OPEN while the failures shield it, because branch protection
    // consumes the status, not this job's color. So persistence does two
    // things, in order: best-effort, it writes UNREADABLE `pending` over
    // the head — failing closed; the write path is often alive when the
    // reads are not, and when the write is what is broken there was no
    // fresh success being published anyway — and then it throws, making the
    // run red so the owner is notified once and the queued successor takes
    // over.
    // Streaks are keyed by number AND head: a force-push resets the count,
    // so the expected transient 422 on the brand-new SHA is not read as the
    // old head's fifth consecutive failure.
    const streakKey = `${node.number}:${node.headRefOid}`;
    try {
      const a = await judge(node);
      awaiting += a;
      cadence.set(node.number, {
        sha: node.headRefOid, awaiting: a === 1, age: 0, updatedAt: touched, shared: sharedNow,
      });
      streaks.delete(streakKey);
    } catch (err) {
      const run = (streaks.get(streakKey) ?? 0) + 1;
      streaks.set(streakKey, run);
      // A failing head is retried every sweep, never put on the slow path.
      cadence.set(node.number, {
        sha: node.headRefOid, awaiting: true, age: 0, updatedAt: touched, shared: sharedNow,
      });
      if (run >= MAX_FAIL_STREAK) {
        try {
          await api.rest(`/repos/${owner}/${name}/statuses/${node.headRefOid}`, {
            method: "POST",
            body: { context: CONTEXT, state: "pending", description: UNREADABLE },
          });
          log(`#${node.number}: failed ${run} sweeps straight — status failed closed`);
        } catch (writeErr) {
          // The write path is down too, so there is no stale success being
          // refreshed either; the red run below is all that is left to say.
          log(`#${node.number}: could not fail the status closed (${writeErr.message})`);
        }
        throw new Error(
          `#${node.number}: still failing after ${run} consecutive sweeps (${err.message})`,
          { cause: err },
        );
      }
      log(`#${node.number}: sweep failed (${err.message}) — retrying next sweep`);
      awaiting += 1;
      failed.push(node.number);
    }
  }

  // `awaiting` is what the loop runs on: the fast clock only matters while
  // Codex's answer is still due. A PR at `success` merges by auto-merge with
  // nothing to poll for, and one held at `failure` changes only by the owner
  // removing the reaction — the throttled schedule covers both. A pending
  // verdict is the one state where the next minute can change the answer.
  return { written, awaiting, failed };
}

/**
 * Sweep repeatedly until `minutes` have elapsed, `intervalSeconds` apart.
 *
 * The scheduled trigger cannot be the clock: GitHub throttles it, and eight
 * measured hours delivered a median gap of 14 minutes against the 5 asked
 * for. So the job itself is the clock — one run polls every minute for most
 * of an hour, and the verdict lands within about a poll interval of Codex's
 * reaction.
 *
 * What starts that run is an EVENT, not the cron. A push, a comment, and
 * Codex's own in-place edit of its review summary all wake this workflow, and
 * the schedule is only the backstop for what none of them report. So there is
 * deliberately no continuous chain of runs any more: at four-hourly the loop
 * cannot span the gap between fires, and is not meant to.
 *
 * Always sweeps at least once, so `minutes: 0` is the single pass a one-shot
 * invocation wants. An error escaping a sweep is deliberately NOT caught
 * here: it turns the run red, which is how a persistent failure is reported
 * rather than absorbed. `sweep` contains per-head errors itself (a transient
 * 422 on one write must not go red and notify the owner) and escalates only a
 * MAX_FAIL_STREAK-sweep persistence, AFTER failing that head's status closed —
 * so what escapes is either that, or a run that could not even list the open
 * pull requests.
 *
 * That last one is the case worth naming, because the schedule no longer
 * covers it quickly. It publishes nothing at all, so every head keeps the
 * status it already had — and a head carrying `success` that an event was
 * firing to invalidate (`reopened` and `edited` exist for exactly that, on an
 * unchanged SHA) stays mergeable on the old verdict. Recovery is the next
 * event or the next cron, and the cron is now up to four hours away rather
 * than one. Under the hourly chain a successor was usually already queued;
 * it usually is not now. Tracked in TODO.md — closing it needs a retry path,
 * not a shorter schedule, which is the thing this cadence exists to avoid.
 */
export async function runLoop({
  minutes, intervalSeconds, sweepOnce, sleep, now = Date.now,
  shouldContinue = () => true,
}) {
  const start = now();
  const until = start + minutes * 60_000;
  for (;;) {
    const result = await sweepOnce();
    // The lean gate: the fast clock runs only while a verdict is still due,
    // so runner time is proportional to pushes (each opens a pending window
    // of a few minutes) rather than to how long PRs sit open — a PR waiting
    // overnight on a human costs nothing. Everything else changes only by
    // human action, and the hourly schedule's trickle covers it. Two
    // accepted costs, both bounded: the first verdict after a quiet stretch
    // waits for the schedule to start a run once, and a PR whose review
    // never arrives keeps the loop warm for UNANSWERED_MINUTES, once per
    // run, before parking to wait for a nudge.
    //
    // There is deliberately no settling grace here. Every wait state is
    // derived from data the sweep itself reads — Codex's 👀, an unanswered
    // head, a nudge newer than Codex's last word — so it holds on every
    // sweep however the run was started, and the sweep is the only writer
    // of the `codex` status, so there is no unordered write to outwait. An
    // earlier version graced event-triggered runs to bridge both gaps, and
    // the grace kept failing the same way: trigger-level state does not
    // survive replacement in the concurrency queue, and no fixed window
    // bounds a delayed Actions run.
    if (now() >= until || !shouldContinue(result)) return;
    await sleep(intervalSeconds * 1000);
  }
}

/**
 * An action input, falling back to the environment variable the standalone
 * script used before this was packaged.
 *
 * The runner upper-cases the input name and replaces SPACES with underscores;
 * every other character, a hyphen included, is passed through. So
 * `loop-minutes` arrives as `INPUT_LOOP-MINUTES`, and reading
 * `INPUT_LOOP_MINUTES` -- as this did -- finds nothing, falls through to the
 * env fallback, finds nothing there either, and hands `main` an empty string.
 * The two hyphenated inputs are exactly the two that decide the loop, so
 * `minutes` became 0 and every run swept once and exited: the per-run
 * `cadence` map never survived to throttle anything, each run re-judged every
 * open head from cold, and the schedule became the only clock. `token` and
 * `repository` have no hyphen, which is why the action otherwise worked and
 * the failure looked like a scheduling problem for weeks.
 *
 * Both spellings are read because a hand-run is the documented way to unstick
 * a verdict, and `INPUT_LOOP_MINUTES` is what a person types.
 *
 * An input that was declared but left unset arrives as the empty string rather
 * than absent, so emptiness rather than `undefined` is what falls through --
 * otherwise a consumer omitting `loop-minutes` would get `Number("")`, which
 * is 0, instead of the default.
 */
export const input = (name, envVar) => {
  const upper = name.toUpperCase();
  const fromAction = process.env[`INPUT_${upper}`]
    || process.env[`INPUT_${upper.replaceAll("-", "_")}`];
  if (fromAction) return fromAction;
  return process.env[envVar] || "";
};

async function main() {
  // `github.token` is the default the action manifest supplies, so a consumer
  // has to opt out rather than remember to opt in.
  const token = input("token", "GITHUB_TOKEN");
  const slug = input("repository", "GITHUB_REPOSITORY");
  if (!token || !slug) throw new Error("a token and a repository are required");
  const [owner, name] = slug.split("/");
  // One streak map and one cadence map for the whole run: a head failing
  // sweep after sweep accumulates toward MAX_FAIL_STREAK instead of
  // resetting every minute, and settled heads keep their revisit age.
  const streaks = new Map();
  const cadence = new Map();
  await runLoop({
    minutes: Number(input("loop-minutes", "SWEEP_LOOP_MINUTES") || 0),
    intervalSeconds: Number(input("interval-seconds", "SWEEP_INTERVAL_SECONDS") || 60),
    sweepOnce: () => sweep({ owner, name, token, streaks, cadence }),
    shouldContinue: ({ awaiting }) => awaiting > 0,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}

// Only run the sweep when invoked as a script, so the tests can import the
// pieces without making a single network call.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
