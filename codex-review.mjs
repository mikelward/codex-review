// Publishes Codex's review verdict as a commit status, so branch protection
// can gate on something it can actually see.
//
// Codex posts no check run of its own, so its verdict is invisible to
// protection rules. Without this, auto-merge fires on green CI *before* Codex
// has looked, and a merged-too-early PR is indistinguishable from a correctly
// merged one.
//
// The verdict is read from what Codex WRITES, each piece tied to the commit
// it is about:
//
// - Its status-table comment (`codexCodeReview`): one comment per pull
//   request, edited in place, carrying a machine-readable state per review
//   kind -- the commit it read, `running`/`completed`, and whether it found
//   anything. A clean pass leaves nothing else: no review, no comment, only
//   this and a 👍.
// - Its findings: a submitted review carries the commit id
//   (`codexReviewedAt`), and a findings comment is bounded by the head's
//   arrival (`commentSignals`).
// - A clean comment naming the commit it read (`cleanVerdict`), which Codex
//   posts when asked with `@codex review`.
//
// A head is approved when Codex's latest word on it is clean. Its reactions
// decide nothing: the 👍 names no commit and can outlive the head it was
// about, and the 👀 stays up while ANY of its reviews runs -- a stuck
// security review included -- so every attempt to time them against each
// other turned up another case. Every one of the channels above is an
// `issue_comment` or review event, so an answer wakes the sweep by itself.
//
// Human review threads are deliberately not modeled: GitHub's "require
// conversation resolution" setting does that natively, and better.
//
// The repository owner's reactions run the other way: approval also needs no
// 👀 and no 👎 from the owner, and no owner "@codex review" newer than Codex's
// last word -- so a hold costs two seconds from a phone, which is the point:
// without it auto-merge can land a PR before someone who wanted a look gets
// one. The nudge case is the same idea one step later: asking Codex to look
// again means the standing verdict is no longer the one wanted, so the gate
// closes until the fresh answer lands.
//
// Only the owner, because this repo is public: anyone can react, and a hold
// deliberately outlives head changes, so an unrestricted one lets a passer-by
// block a PR for as long as they feel like it.
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

import { createSign } from "node:crypto";

export const CODEX_BOT = "chatgpt-codex-connector";
export const CONTEXT = "codex";

/**
 * The pending description.
 *
 * `publish` skips the write when state and description both match what is
 * already on the head, and that skip is what keeps the head's earliest
 * `codex` status — its gate marker — where it is. Rewrite the same status
 * each sweep and the marker moves forward every time, re-anchoring the
 * unanswered-head window (see `UNANSWERED_MINUTES`) so it never runs out:
 * the loop polls every head to its cap, with nothing failing to say so.
 *
 * It says *approve* rather than *review* because a head waiting on a
 * re-review sits here too — nothing is waiting for a first review by then,
 * only for the clean answer.
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
 * The pending description for a head that would otherwise be approved while
 * a Codex security finding on the pull request still stands unresolved.
 *
 * Separate from FINDINGS because the scope differs: FINDINGS is about this
 * head, and a push clears it. A security review runs when the pull request
 * opens, not on every push -- on mikelward/repo#56 one ran against about 40
 * code reviews -- so its finding names a commit the next push leaves behind,
 * and judging per head would let that head's clean review publish
 * `success` over it.
 * Resolving the thread is what clears it, the same act a ruleset requiring
 * conversation resolution already asks for.
 */
export const SECURITY = "Codex left a security finding — address it and resolve its thread";

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
 * The park wording an earlier version wrote on fork heads, whose 👍 it
 * could not accept. Nothing writes it now -- the verdict names its commit,
 * so a fork head is judged like any other -- but commits still wear it, so
 * it is still recognized as a marker this loop wrote: never replayed, and
 * cleared like any other.
 */
const LEGACY_FORK_MARKER =
  "A fork head\u0027s 👍 cannot be accepted — comment @codex review, or merge by admin override";

/**
 * Every wording this loop parks a head with.
 *
 * Read as a set rather than compared one at a time, because all three
 * places that care — the sticky read, the age anchor, and the clear — mean
 * "a marker we wrote when we gave up", not any particular sentence.
 */
const PARKED = new Set([UNANSWERED, LEGACY_FORK_MARKER]);

/**
 * The park wording for this head: one remedy for every head now.
 */
const marker = () => UNANSWERED;

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
 * that restart the clock. A review the table says is running parks at
 * once instead: its end is an edit, which wakes the sweep by itself.
 *
 * Thirty, not ten, and the difference was paid for: under a burst of
 * pushes (several amends across sibling repos inside ten minutes) Codex
 * queues, and the answer arrived at minute nine-to-twelve — right at the
 * old park, when the answer was a 👍 no webhook announced and five pull
 * requests sat mergeable for most of an hour on 2026-08-16. Every answer
 * is an event now, so the window matters less, but it is a ceiling, not a
 * duration — an answered head ends the loop within a poll interval — so
 * it costs only a head Codex never answers, once per push.
 */
export const UNANSWERED_MINUTES = 30;

const stripBot = (login) => String(login ?? "").replace(/\[bot\]$/, "");

/**
 * Is this login Codex's, spelled either way REST or GraphQL use? Login only
 * — no type evidence asked for or required, so it never decides a verdict.
 *
 * For GraphQL authors, where no type evidence exists: a review thread's
 * root author, read to count unresolved security findings. A lookalike
 * there can only hold a head at pending (see `unresolvedSecurityFindings`).
 */
export const matchesBotLogin = (login, botLogin = CODEX_BOT) => stripBot(login) === stripBot(botLogin);

/**
 * Is this actor Codex? Takes the whole user object where the caller has one.
 * For REST-sourced actors ONLY (review and comment authors) — see
 * `matchesBotLogin` for a GraphQL author, where no type evidence exists.
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
 * reaction and timeline `createdAt`) are `DateTime`, defined as UTC — so this changes
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
 * needed: a new push changes the head oid and every earlier review stops
 * matching.
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
    // it settles the head as answered on a diff nobody has read.
    //
    // A TIE is stale. GitHub stamps to the second, so a review submitted in
    // the same second as the retarget has no established order against it,
    // and the ambiguity must not be what settles a head. The comment and
    // table paths already require strictly newer; this is the same rule.
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
 * schedule. Approval itself never trusts the commit date at all: the
 * table and a clean comment name the commit they read.
 *
 * The nudge is owner-only for the same reason holds are: this repo is
 * public, and letting any comment shaped like a nudge hold the gate would
 * hand passers-by a merge block.
 *
 * `askAt` is the wider signal: the newest `@codex review` from anyone with
 * write access, owner included. Codex answers a collaborator's ask too, so
 * the ask restarts the polling clock, a backstop should the table's edit
 * be missed. It only wakes and never holds, so the worst a collaborator
 * can do with it is one UNANSWERED_MINUTES window of polling. Passers-by are still left out,
 * because on a public repo their asks would cost the runner and buy nothing.
 */
const WRITERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function commentSignals(comments, { since, owner, head }) {
  let codexAt = null;
  let nudgeAt = null;
  let askAt = null;
  let cleanAt = null;
  const bound = utc(since);
  if (!bound) return { codexAt, nudgeAt, askAt, cleanAt };
  for (const c of comments ?? []) {
    const at = utc(c.created_at) ?? "";
    if (matchesBot(c.user)) {
      // The status table is Codex's bookkeeping, not an answer: it is read
      // for what it states (`codexCodeReview`), never as a finding.
      if (String(c.body ?? "").includes(SUMMARY_MARKER)) continue;
      // Codex's word stays on created_at: its edits do not re-answer, and a
      // later timestamp here could only mask a nudge — the fail-open way.
      if (at <= bound) continue;
      const clean = cleanVerdict(c.body, head);
      if (clean === "head") {
        // An attributable clean verdict: Codex says it found nothing AND
        // names the commit it read, which is the same standard a review is
        // held to. Codex posts it when asked with `@codex review`.
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
    } else if (/@codex review/i.test(c.body ?? "")) {
      const isOwner = Boolean(owner) && c.user?.login === owner;
      if (!isOwner && !WRITERS.has(c.author_association)) continue;
      // A nudge can be EDITED into an old comment, whose created_at then
      // predates the head or the standing verdict — dating the ask by the later
      // of creation and edit is what hears it. REST's `since` already
      // filters on updated_at, so the edited comment reaches this walk; the
      // cost is that retouching an old nudge comment re-asks, and erring
      // toward blocking on an owner's ask is this file's stated direction.
      const asked = laterOf(at, utc(c.updated_at));
      if (!asked || asked <= bound) continue;
      if (askAt === null || asked > askAt) askAt = asked;
      if (isOwner && (nudgeAt === null || asked > nudgeAt)) nudgeAt = asked;
    }
  }
  return { codexAt, nudgeAt, askAt, cleanAt };
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
 * the gate holding -- the table still approves a clean pass -- rather than
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
// The marker Codex now opens its review comments with, any version: it names
// the comment kind and carries no prose.
const RECEIPT_MARKER = /^<!--[ \t]*codex-review-receipt:v\d+[ \t]*-->$/;

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
  // lines, after the one HTML marker Codex is known to open with. Since
  // 2026-10-15 its clean comment starts with `<!-- codex-review-receipt:v1
  // -->`, and counted as a third line it sent a clean verdict on a sibling
  // repo's pull request to FINDINGS. Only that marker, alone on the first
  // line, is dropped: the shape stays exact, so any other HTML comment, or
  // this one anywhere else, still fails it.
  const lines = text.split(/<details/i)[0]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length > 0 && RECEIPT_MARKER.test(lines[0])) lines.shift();
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
 * The marker on Codex's status-table comment.
 *
 * Since about 2026-08-26 Codex maintains one comment per pull request
 * carrying a row per review kind -- Code Review, Security Review -- each
 * naming the commit it is about and reading `Running` then `Completed`.
 * It EDITS that comment in place as each review lands, and the edit arrives
 * as an `issue_comment` event, a trigger every consumer already declares.
 * So the end of every review has a webhook.
 */
export const SUMMARY_MARKER = "codex-pull-request-review-summary";

// The machine-readable state riding in the same comment: per review kind,
// the commit it read, `running`/`completed`, and whether it found anything.
const STATE_MARKER = /<!--[ \t]*codex-review-state:v1[ \t]+(\{[\s\S]*?\})[ \t]*-->/;

/**
 * The `codex-review-state:v1` object in a summary comment, or null where
 * there is none or it does not parse. Null is the conservative answer:
 * without it nothing approves through the table.
 */
export function reviewState(body) {
  const m = STATE_MARKER.exec(String(body ?? ""));
  if (!m) return null;
  try {
    const state = JSON.parse(m[1]);
    return state && typeof state === "object" ? state : null;
  } catch {
    // Unparseable is unread: the caller logs it and nothing approves on it.
    return null;
  }
}

/**
 * The row of `kind` in Codex's status table when it names this head:
 * `{ status, at }`, with `status` `"running"`, `"completed"`, or null for a
 * word this file does not know, and `at` the time the row carries (when it
 * started running, or when it completed). Null where no such row names
 * this head -- a row about another commit says nothing about this one.
 *
 * Per ROW, because the rows disagree: observed live with Code Review
 * `Running` on one commit while Security Review still read `Completed` on
 * the commit before it.
 */
export function reviewTableRow(body, head, kind = "Code Review") {
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
    if (!cells[0].includes(kind)) continue;
    const named = /`([0-9a-f]{7,40})`/.exec(cells[2])?.[1];
    if (!named) return null;
    // The abbreviation is Codex's -- seven characters here where the API
    // gives forty -- so compare by prefix in the direction that cannot
    // collide, exactly as `cleanVerdict` does: the named id must be a
    // prefix of the full head, never the reverse.
    if (!head || !String(head).toLowerCase().startsWith(named.toLowerCase())) return null;
    const at = utc(/datetime="([^"]+)"/.exec(cells[1])?.[1] ?? null);
    if (/\*\*Running\*\*/.test(cells[1])) return { status: "running", at };
    if (/\*\*Completed\*\*/.test(cells[1])) return { status: "completed", at };
    return { status: null, at };
  }
  return null;
}

/** The status of this head's CODE review row: see `reviewTableRow`. */
export function reviewTableStatus(body, head) {
  return reviewTableRow(body, head)?.status ?? null;
}

/**
 * Codex's code review of this head, as its summary comment states it:
 * `{ status, findings, at }`, or null where the comment says nothing
 * about this head.
 *
 * - `status` is `"running"` or `"completed"` (or null for a word this file
 *   does not know, which neither parks nor approves).
 * - `findings` is the state's `has_unresolved_findings`: `false` is Codex
 *   saying nothing it found on this pull request is still open -- the clean
 *   pass that leaves no comment and no review, only a 👍 that names no
 *   commit. Not `has_any_findings`, which counts every finding the pull
 *   request ever drew, so a thread answered and resolved would hold every
 *   later head forever. A state without the field falls back to
 *   `has_any_findings`. Anything but `false` is not clean.
 * - `at` is when that row says it completed (or started), the time a clean
 *   answer is ordered by against findings and nudges.
 *
 * The state names the FULL commit, so it is matched exactly: nothing here
 * has to guess which head a verdict was about. The table row is read
 * alongside for its time, and has to agree on the status.
 *
 * Author-checked like every other Codex signal: a forged table could
 * otherwise approve.
 */
export async function codexCodeReview(api, { owner, name, number, head, log = () => {} }) {
  const sha = String(head ?? "").toLowerCase();
  for (let page = 1; ; page += 1) {
    const batch = await api.rest(
      `/repos/${owner}/${name}/issues/${number}/comments?per_page=100&page=${page}`,
    );
    for (const c of batch ?? []) {
      if (!matchesBot(c.user) || !String(c.body ?? "").includes(SUMMARY_MARKER)) continue;
      const row = reviewTableRow(c.body, head);
      const state = reviewState(c.body);
      if (state === null && /codex-review-state:/.test(c.body)) {
        log(`#${number}: Codex's review state did not parse — reading it as nothing said`);
      }
      const code = state?.code_review;
      if (code && typeof code.commit_sha === "string" && code.commit_sha.toLowerCase() === sha) {
        const status = code.status === "running" || code.status === "completed" ? code.status : null;
        // Only where the row agrees with the state: a state left at
        // "running" beside a finished row would otherwise park the sweep
        // on a review that is not running.
        const agreed = status !== null && row?.status === status;
        return {
          status: agreed ? status : null,
          findings: typeof code.has_unresolved_findings === "boolean"
            ? code.has_unresolved_findings
            : code.has_any_findings,
          at: agreed ? row.at : null,
        };
      }
      // A table with no state: still says whether a review of this head is
      // running, never that it was clean.
      if (row && !state) return { status: row.status, findings: null, at: row.at };
    }
    if (!batch || batch.length < 100) return null;
  }
}

/**
 * Is this review comment a Codex security finding? The HTML marker is the
 * machine-readable tag; the heading is accepted too, so that Codex dropping
 * the marker leaves the finding still blocking rather than silently not.
 */
export const isSecurityFinding = (body) =>
  /codex-security-review-finding|Codex Security Review/.test(String(body ?? ""));

/**
 * How many Codex security findings on this pull request still have an
 * unresolved thread.
 *
 * Read from the threads, not from the findings list in Codex's status-table
 * comment. That list also says Resolved, but in Codex's own words, which
 * could change; `isResolved` is GitHub's own field, and the same one a
 * ruleset requiring conversation resolution reads. Every thread counts,
 * outdated ones included, because a finding on an earlier commit is the
 * whole case.
 *
 * Only the login is checked, not a type, so a stranger who registers a
 * lookalike name can hold a head at pending. That costs no more than an
 * unresolved thread already costs under conversation resolution. Requiring
 * the type would instead let a real finding through whenever the type
 * failed to read.
 *
 * Nothing here waits on the security review itself. If it is out of
 * quota, not enabled, or never answers, it leaves no thread, and the code
 * review's verdict stands alone.
 */
export async function unresolvedSecurityFindings(api, { owner, name, number }) {
  let open = 0;
  for (let after = null; ;) {
    const data = await api.graphql(REVIEW_THREADS, { owner, name, number, after });
    // Unguarded, as the open-PR read is: a missing connection is a failed
    // read, and reading it as "no threads" would approve over a finding.
    const threads = data.repository.pullRequest.reviewThreads;
    for (const t of threads.nodes) {
      if (t.isResolved) continue;
      const root = t.comments?.nodes?.[0];
      if (!root || !matchesBotLogin(root.author?.login)) continue;
      if (isSecurityFinding(root.body)) open += 1;
    }
    if (!threads.pageInfo.hasNextPage) return open;
    after = threads.pageInfo.endCursor;
  }
}

export async function codexCommentSignals(api, { owner, name, number, since, head }) {
  let codexAt = null;
  let nudgeAt = null;
  let askAt = null;
  let cleanAt = null;
  if (!since) return { codexAt, nudgeAt, askAt, cleanAt };
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
      if (seen.askAt !== null && (askAt === null || seen.askAt > askAt)) askAt = seen.askAt;
      if (seen.cleanAt !== null && (cleanAt === null || seen.cleanAt > cleanAt)) cleanAt = seen.cleanAt;
      if (!batch || batch.length < 100) break;
    }
  }
  return { codexAt, nudgeAt, askAt, cleanAt };
}

/**
 * Decide the commit status for one pull request.
 * Returns null for a draft — nothing to gate until it is ready for review.
 */
export function verdictFor({
  isDraft, approved, sharedHead, held, reading, findings, nudged, unanswered, carried = null,
  security = false,
}) {
  if (isDraft) return null;

  // A status belongs to the commit; the review belongs to the PR. Two open
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

  // Above the carry and the approval, because neither is about it: both are
  // verdicts on a head, and an unresolved security finding belongs to the
  // pull request (see SECURITY).
  if (security) return { state: "pending", description: SECURITY };

  // Codex still reading is the answer being written, not a hold: `pending`,
  // even over an earlier clean answer, since whoever asked for the re-read
  // wants the new one.
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
  // last word — including a standing clean one. Honoring the old approval
  // while a re-review is pending is a merge nobody wants anymore, so the
  // gate closes until the fresh answer lands; a clean one postdating the
  // nudge reopens it through `approved` on a later sweep.
  if (nudged) return { state: "pending", description: PENDING };

  if (approved) {
    return { state: "success", description: "Codex reviewed this head, no findings" };
  }

  // Approval outranks findings on purpose: after a fix-and-nudge round the
  // old review still names this head, and the fresh clean answer is Codex
  // saying it is satisfied. The caller only sets `approved` when that answer
  // is strictly newer than Codex's last findings on the head (see `judge`),
  // so the standing order here never lets a leftover verdict outrank
  // findings that came after it. Reading outranks both.
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

const REVIEW_THREADS = `
query($owner:String!, $name:String!, $number:Int!, $after:String) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      reviewThreads(first:100, after:$after) {
        ${PAGE}
        nodes { isResolved comments(first:1) { nodes { author { login } body } } }
      }
    }
  }
}`;

// --- Authenticating as a GitHub App ------------------------------------------

/**
 * The sweep's own credential, when a consumer gives it one.
 *
 * Publishing the `codex` status with the workflow's `GITHUB_TOKEN` means the
 * status is posted by `github-actions[bot]` -- the identity EVERY workflow in
 * the repository holds, so branch protection cannot bind the required check to
 * one writer, and any workflow with `statuses: write` can forge the verdict
 * this action exists to make trustworthy. `boundAppsFromRules` already refuses
 * to trust a carried claim for exactly that reason; the same reasoning applies
 * to the status this file writes.
 *
 * Given `app-id` and `app-private-key`, the sweep authenticates as that App
 * instead, and the ruleset can then bind `codex` to it. The exchange is
 * GitHub's own long-stable flow -- sign a short-lived App JWT, look up this
 * repository's installation, mint a token from it -- and is the same one
 * mikelward/lanes performs for the `lanes` status. Minted per run and never
 * stored: an installation token expires in an hour, so a stored one would
 * leave every later run unable to publish.
 *
 * Done here rather than by a token-minting step in the caller's workflow so a
 * consumer's workflow stays what this repository's own rule asks of it -- no
 * dependencies, nothing to pin, the file it runs reviewable by reading it.
 */
function base64url(bufferOrString) {
  const buf = Buffer.isBuffer(bufferOrString) ? bufferOrString : Buffer.from(bufferOrString);
  return buf.toString("base64url");
}

function defaultSign(signingInput, privateKeyPem) {
  return createSign("RSA-SHA256").update(signingInput).sign(privateKeyPem);
}

/**
 * A short-lived JWT identifying the App itself, not an installation.
 *
 * `iat` is backdated 60s for drift between this runner's clock and GitHub's --
 * an `iat` GitHub reads as still in the future is rejected outright. `exp` is
 * 10 minutes, GitHub's own maximum for an App JWT, and this loop can run for
 * an hour: the token is minted once per run, before the sweep, and the JWT
 * itself is discarded immediately.
 */
export function signAppJwt(appId, privateKeyPem, now = Math.floor(Date.now() / 1000), sign = defaultSign) {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 600, iss: String(appId) };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  return `${signingInput}.${base64url(sign(signingInput, privateKeyPem))}`;
}

async function appApi(path, appJwt, fetchImpl, { method = "GET" } = {}) {
  const res = await fetchImpl(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${appJwt}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  // The status and the call, never the JWT or the body -- the same rule
  // `createApi` follows.
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, body: await res.json() };
}

/**
 * A token scoped to this App's installation on `repo`, and the login its
 * writes appear under -- or a thrown error
 * naming which half of the exchange failed. Never falls back to the
 * workflow's own token: a consumer that supplied a credential expects the
 * status to be posted by the App, and quietly posting it as
 * `github-actions[bot]` would leave a bound ruleset waiting for a check
 * nothing reports.
 *
 * The login comes from the installation lookup's `app_slug`, which is how
 * GitHub names the App's bot account (`<slug>[bot]`) on everything it
 * writes. It is read here rather than inferred later because this is the
 * only call that knows WHICH App the configured credential is, and the
 * rewrite below has to compare against that one exactly. A response with no
 * slug is a refusal for the same reason a failed lookup is: with the App
 * unnamed, an existing status can be neither trusted nor rewritten -- the
 * first leaves a bound ruleset blocked forever, the second rewrites every
 * head on every sweep and walks the earliest-gated marker forward with it.
 */
export async function appToken({ appId, privateKey, repo }, fetchImpl = fetch, sign = defaultSign) {
  const jwt = signAppJwt(appId, privateKey, undefined, sign);
  const found = await appApi(`/repos/${repo}/installation`, jwt, fetchImpl);
  if (!found.ok) {
    throw new Error(
      `could not find this App's installation on ${repo} (${found.status}) — is it installed there?`,
    );
  }
  const slug = found.body?.app_slug;
  if (typeof slug !== "string" || slug === "") {
    throw new Error(
      `the installation on ${repo} named no app_slug — without it this cannot tell `
      + "the App's own status writes from another App's, and would either leave a "
      + "stale one standing or rewrite every head on every sweep",
    );
  }
  const minted = await appApi(
    `/app/installations/${found.body.id}/access_tokens`,
    jwt,
    fetchImpl,
    { method: "POST" },
  );
  if (!minted.ok) {
    throw new Error(
      `could not mint an installation token (${minted.status}) — the App credential may be wrong or revoked`,
    );
  }
  return { token: minted.body.token, login: `${slug}[bot]` };
}

/**
 * The credential the STATUS is written with -- its token and the login the
 * write will appear under -- or null to write it with the workflow's own.
 *
 * Only the write changes identity. Every read the sweep makes -- the open
 * pull requests, their reviews and comments, check suites, the base
 * branch's rules -- stays on the workflow's `GITHUB_TOKEN`, which already
 * has exactly those permissions. The App the README asks for holds commit
 * statuses and nothing else, so routing the reads through it would fail the
 * first sweep on a private repository and never publish a verdict (Codex,
 * mikelward/codex-review#42). Widening the App instead would make a
 * credential that lives in an environment worth more to steal, for nothing
 * the binding needs.
 *
 * Half a credential is a refusal rather than a fallback. An operator who has
 * placed one secret and not the other is mid-migration, and publishing as
 * `github-actions[bot]` under a ruleset that may already require the App is
 * a gate waiting forever on a check nothing reports -- the failure this
 * whole file exists to prevent.
 */
export async function resolveStatusToken(
  { appId, privateKey, repo }, fetchImpl = fetch, sign = defaultSign,
) {
  if (!appId && !privateKey) return null;
  if (!appId || !privateKey) {
    throw new Error(
      "app-id and app-private-key are both needed to authenticate as the App — "
      + `only ${appId ? "app-id" : "app-private-key"} was given`,
    );
  }
  return appToken({ appId, privateKey, repo }, fetchImpl, sign);
}

/**
 * How long a minted installation token is reused before another is minted.
 *
 * GitHub expires one after an hour. `loop-minutes` defaults to 55 and this
 * repository's own manifest test holds the default under 60, but the input
 * takes any number a consumer writes, and a loop that outlives the token
 * would keep reading happily on the workflow's token while every status
 * write failed -- a hold or a re-review request arriving then would leave
 * an earlier `success` standing (Codex, mikelward/codex-review#42). Ten
 * minutes of headroom under the hour, since a sweep can take minutes.
 */
export const APP_TOKEN_REFRESH_MS = 50 * 60 * 1000;

/**
 * A getter for the status-writing credential that re-mints before expiry.
 *
 * Null throughout when no App credential is configured, and it costs
 * nothing then: `resolveStatusToken` answers without a call. The login it
 * carries is re-read with each minting rather than remembered across one,
 * so an App renamed mid-run is compared against its current name.
 */
export function statusTokenSource(creds, fetchImpl = fetch, sign = defaultSign, now = Date.now) {
  let minted = null;
  let mintedAt = 0;
  return async () => {
    if (minted && now() - mintedAt < APP_TOKEN_REFRESH_MS) return minted;
    minted = await resolveStatusToken(creds, fetchImpl, sign);
    mintedAt = now();
    return minted;
  };
}

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
 * The hold the PR-body reactions put on the gate, or null: `"👎"` or `"👀"`
 * from the repository owner.
 *
 * Reactions only ever hold now. Codex's own 👍 and 👀 decide nothing: they
 * name no commit, a 👍 can outlive the head it was about, and a 👀 stays up
 * while ANY of Codex's reviews runs, a stuck security review included, so
 * every attempt to time them against each other turned up another case.
 * Codex's verdict is read from what it writes instead (`codexCodeReview`,
 * `codexReviewedAt`, `cleanVerdict`).
 *
 * Owner only. On a public repo any account can react, and a hold
 * deliberately survives head changes, so an unrestricted hold lets a
 * passer-by block a PR indefinitely.
 *
 * Holds are deliberately NOT filtered by time: a 👎 left on an earlier head is
 * still someone saying don't merge this, and a new commit is not an answer to
 * it. That errs toward blocking, which is the safe direction here.
 */
export function readHolds(nodes, owner) {
  let held = null;
  if (!owner) return held;
  for (const r of nodes ?? []) {
    if (r.user?.login !== owner) continue;
    if (r.content === "THUMBS_DOWN") held = "👎";
    if (r.content === "EYES" && held === null) held = "👀";
  }
  return held;
}

/**
 * Every page of PR-body reactions, from the GraphQL connection the PR list
 * already carried.
 *
 * Every page, because a hold can be on a later one, and stopping early
 * would approve over it.
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
 * not rewrite an identical status. `firstSeen` dates the head's arrival for
 * the comment walk and the unanswered-head window, and spans every context:
 * any status is server-stamped proof the head existed by then, and a third
 * party's lands seconds after the push, before our own first write can.
 *
 * Paged to the end, because the endpoint returns *every* context, so a page
 * can be full of statuses that are not ours while older ones sit behind it.
 * The cap is a backstop against an endless loop, not an expected limit.
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
  // A fork head has no branch-born suite, and fails closed here. Floored at the branch's last force-push
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
 * Server-stamped birth records. Suites are created when the commit is
 * pushed, by Actions or any checks app. `forBranch` dates the moment the
 * commit reached THIS branch: a fast-forward onto a pre-existing commit
 * leaves no timeline event, so the suite its arrival triggers is the only
 * server-stamped record of the transition. Read by the carry, to establish
 * tenure, and by the would-park path, to give a just-arrived head its full
 * window. `head_branch` is a bare branch name — GitHub reports null for
 * fork heads, so a fork head never yields a `forBranch`.
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
      // leaving the event), then fast-forward BACK to the original SHA — the
      // return leaves no event and the SHA already has a branch-born suite
      // from its first tenure, which would date the arrival too early. Any
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

/**
 * Whether a status was posted by the App this run authenticates as.
 *
 * The identity is what a ruleset binds a required check to, so during a
 * migration an existing status can be identical in state and description
 * and still be the wrong one: written by `github-actions[bot]` before the
 * credential was placed, it satisfies no binding (Codex,
 * mikelward/codex-review#42).
 *
 * The comparison is against THAT App and not merely against "some App".
 * Reading any non-Actions bot as correct made a rotation invisible: a head
 * still carrying the previous App's status looked already migrated, so the
 * rewrite was skipped and a ruleset bound to the new App waited forever on
 * a verdict nothing would change (Codex, mikelward/codex-review#42). Logins
 * are case-folded, as GitHub compares them.
 */
function postedBy(status, login) {
  const creator = status?.creator ?? {};
  if (creator.type !== "Bot" || typeof creator.login !== "string") return false;
  return creator.login.toLowerCase() === login.toLowerCase();
}

export async function publish(api, { owner, name, pr, verdict, current, log, appLogin = null }) {
  const description =
    verdict.state === "success" ? stamp(verdict.description, pr.number) : verdict.description;
  // Every write shows up in the PR's check list, and a five-minute cadence
  // would otherwise bury it. It also keeps the marker still: rewriting the
  // same status would move the head's earliest-gated timestamp forward.
  //
  // Identical is not enough while the writer is changing: the status a
  // consumer already has on an open head was written by whoever wrote it
  // last -- the workflow bot before the credential was placed, or the App
  // rotated away from -- and skipping the write would leave it there for a
  // ruleset now bound to THIS App, a merge gate waiting forever on that
  // head since nothing else will change its verdict. So one write happens
  // per head that still carries a status this App did not post, and the
  // marker moves once for it (Codex, mikelward/codex-review#42, twice).
  const wrongWriter =
    appLogin !== null && current !== undefined && current !== null && !postedBy(current, appLogin);
  if (!wrongWriter && current?.state === verdict.state && current?.description === description) {
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
  owner, name, token, statusToken = null, fetchImpl = fetch, log = console.log,
  streaks = new Map(), cadence = new Map(), revisitEvery = 5, now = Date.now,
}) {
  const api = createApi({ token, fetchImpl });
  // The App's token WRITES the status; the workflow's own token does every
  // read. The App the README asks for holds commit statuses and nothing
  // else -- deliberately, since a credential kept in an environment should
  // be able to do exactly the one thing the binding is about -- so handing
  // it the pull request, check-suite and ruleset reads too would fail the
  // first sweep on a private repository and never publish a verdict at all
  // (Codex, mikelward/codex-review#42). What has to change identity is the
  // write, and only the write.
  const writer = statusToken ? createApi({ token: statusToken.token, fetchImpl }) : api;
  const appLogin = statusToken ? statusToken.login : null;
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
    // The head's status history: the newest `codex` entry is what a write
    // is compared against, and the earliest entry of any context dates the
    // head's arrival for the comment walk and the unanswered-head window.
    const { mine, firstSeen, carrier } = await codexStatuses(api, { owner, name, sha: node.headRefOid });
    // When this SHA became this PR's head. A push can move the PR onto a
    // commit that already existed, whose statuses date from its FIRST life.
    // A force-push leaves a server-stamped timeline event, so the comment
    // walk and the window are floored at the last one: a finding Codex left
    // on that commit in a previous life is not an answer about this one.
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
    // new check suite is ever born for one.
    const retargetedAt = newestIn(node.retargets);
    const bound = laterOf(firstSeen, movedAt, retargetedAt);
    // Reactions only ever HOLD now: the owner's 👀 or 👎. Codex's own 👍
    // and 👀 decide nothing -- its verdict is read from what it writes
    // (see `codexCodeReview`), which names the commit it is about.
    const held = sharedHead
      ? null
      : readHolds(await reactionNodes(api, node.reactions, { owner, name, number: node.number }), owner);
    // A generated-only push onto an approved head inherits that approval;
    // read only once the lanes engine has published the claim, and never
    // for a shared head, which fails closed above whatever it inherits.
    const carried = carrier && !sharedHead && !held
      ? await carriedVerdict(api, {
        owner, name, number: node.number, base: node.baseRefName, branch: node.headRefName,
        head: node.headRefOid, carrier, createdAt: node.createdAt, retargetedAt, movedAt, cache: carryCache, log,
      })
      : null;
    // Only a shared head and a hold settle without reading Codex.
    const undecided = !sharedHead && !held;
    let approved = false;
    let findings = false;
    let nudged = false;
    let reading = false;
    let nudgeAt = null;
    let askAt = null;
    let answeredAt = null;
    if (undecided) {
      const code = await codexCodeReview(api, {
        owner, name, number: node.number, head: node.headRefOid, log,
      });
      // A review of this commit still being written. Not a verdict either
      // way, and `pending` over any earlier one: whoever asked for it wants
      // the new answer, not the old.
      reading = code?.status === "running";
      const reviewedAt = await codexReviewedAt(api, {
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
      // a comment finding from before a base change describes the old diff.
      const walkSince = laterOf(earlierOf(bornAt, firstSeen), movedAt, retargetedAt);
      const signals = await codexCommentSignals(api, {
        owner, name, number: node.number, since: walkSince, head: node.headRefOid,
      });
      nudgeAt = signals.nudgeAt;
      askAt = signals.askAt;
      // The table's verdict counts only if it postdates a retarget: it
      // names the commit, and a retarget changes the diff without changing
      // the commit.
      const current = (t) => t !== null && (retargetedAt === null || t > retargetedAt);
      const done = code?.status === "completed" && current(code.at);
      const tableCleanAt = done && code.findings === false ? code.at : null;
      const tableFindingsAt = done && code.findings !== false ? code.at : null;
      // Every channel Codex answers on, each tied to this commit: the
      // table names it, a review carries its id, a clean comment names it,
      // and a findings comment is bounded by the walk above.
      const cleanAt = laterOf(signals.cleanAt, tableCleanAt);
      const findingsAt = laterOf(reviewedAt, signals.codexAt, tableFindingsAt);
      answeredAt = laterOf(cleanAt, findingsAt);
      // A nudge newer than Codex's last word reopens the wait. A TIE
      // reopens it too: GitHub stamps to the second, so an ask in the same
      // second as the answer is an unresolved ordering, and the ambiguity
      // must not be what leaves a success open.
      nudged = Boolean(nudgeAt) && (answeredAt === null || nudgeAt >= answeredAt);
      // Clean only as Codex's LATEST word on this commit: findings after a
      // clean answer -- an owner nudge is the ordinary way -- outrank it. A
      // tie is unresolved and does not approve.
      approved = cleanAt !== null && (findingsAt === null || cleanAt > findingsAt);
      findings = !approved && Boolean(answeredAt) && !nudged;
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
    // Only the current wording is sticky: a legacy marker is not replayed
    // but replaced, by an ordinary PENDING that starts a fresh window.
    const parkedAt = mine[0]?.description === UNANSWERED ? utc(mine[0].created_at) : null;
    const parkStands = parkedAt !== null && (nudgeAt === null || parkedAt > nudgeAt);
    const facts = {
      isDraft: false, approved, sharedHead, held, reading,
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
    };
    let verdict = verdictFor(facts);
    // Read only where it can change the answer: a security finding never
    // matters to a head that is not about to be approved.
    if (verdict.state === "success") {
      const security = await unresolvedSecurityFindings(api, { owner, name, number: node.number });
      if (security > 0) {
        log(`#${node.number}: ${security} unresolved Codex security finding(s) — not approving`);
        verdict = verdictFor({ ...facts, security: true });
      }
    }
    const changed = await publish(writer, { owner, name, pr: node, verdict, current: mine[0], log, appLogin });
    if (changed) written.push({ number: node.number, ...verdict });
    if (verdict.state !== "pending") return 0;
    // A review of this head still running parks it: Codex's status table
    // is EDITED to `Completed` when the answer lands, an `issue_comment`
    // event every consumer already triggers on, so the read announces its
    // own end and needs no fast clock. Still `pending` -- nothing fails
    // open. Measured on a private sibling's pull request, 2026-09-02: the
    // edit's run published the verdict seven seconds after firing.
    //
    // Confirmed by a second read before parking: the run the `Completed`
    // edit starts can read the comment a moment before the edit shows, and
    // parking on that stale `Running` would let the only wake go by. Not
    // confirmed, the head keeps the clock, which sees the edit land.
    if (reading) {
      const again = await codexCodeReview(api, {
        owner, name, number: node.number, head: node.headRefOid, log,
      });
      if (again?.status === "running") {
        log(`#${node.number}: Codex is still reading this head and says so — parking until it says otherwise`);
        return 0;
      }
      return 1;
    }
    // A head Codex left findings on waits for a push or a re-review, both of
    // which arrive as events (the push, the table edit), so it stops
    // polling. Not while someone has asked for a re-review since: the ask
    // restarts the window, as it does below. A tie counts as unanswered,
    // as it does for the nudge.
    const askOpen = Boolean(askAt) && (answeredAt === null || askAt >= answeredAt);
    if (verdict.description === FINDINGS && !askOpen) return 0;
    // SECURITY deliberately keeps the clock, unlike FINDINGS. What clears it
    // is a thread being resolved, and resolving emits nothing the listener
    // hears, so polling is the only way to see it. The age path below still
    // parks it after UNANSWERED_MINUTES, keeping its wording.
    // Everything else pending is a wait for an answer that arrives within
    // minutes of the event that asked for it — the push for a fresh head,
    // the nudge for a re-review. Past UNANSWERED_MINUTES with no answer,
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
    // Guarded on the wording, because a finding with an ask still open
    // reaches this path too, and its accurate word must not be reopened.
    const stillPolling = async () => {
      if (PARKED.has(verdict.description)) {
        const fresh = { state: "pending", description: PENDING };
        if (await publish(writer, { owner, name, pr: node, verdict: fresh, current: mine[0], log, appLogin })) {
          written.push({ number: node.number, ...fresh });
        }
      }
      return 1;
    };
    const anchoring = mine.find((s) => !PARKED.has(s.description));
    // `askAt` includes the owner's nudge, and any collaborator's ask restarts
    // the window the same way.
    let waitedSince = laterOf(bound, askAt, utc(anchoring?.created_at));
    if (!waitedSince) return stillPolling();
    let ms = Date.parse(waitedSince);
    if (Number.isNaN(ms)) return stillPolling();
    if (now() - ms < UNANSWERED_MINUTES * 60_000) return stillPolling();
    // The park now SAYS the head is unanswered rather than leaving
    // `PENDING` standing, so the one state that needs a person is not
    // spelled the same as the ordinary wait. Same status, same permission,
    // different words.
    const escalate = async () => {
      // Only the ordinary wait gets renamed. A finding with an ask still
      // open is why: that head reaches here still described as FINDINGS,
      // and saying it was never answered would be false. It would also not STAY said: `findings` outranks `unanswered`
      // in `verdictFor`, so the next sweep writes FINDINGS back, that change
      // re-anchors the age, and the head flaps between the two every
      // UNANSWERED_MINUTES forever -- walking its gate marker forward each
      // time, which is exactly what the stickiness exists to prevent. Park it
      // as before, keeping the truer word.
      if (verdict.description !== PENDING) return 0;
      const said = { state: "pending", description: marker(node) };
      if (await publish(writer, { owner, name, pr: node, verdict: said, current: mine[0], log, appLogin })) {
        written.push({ number: node.number, ...said });
      }
      return 0;
    };
    // Looks expired — but a fast-forward can land a head already carrying
    // an identical old PENDING from a previous life, and then nothing
    // above refreshed the anchor: publish skipped the identical write, and
    // the head would park on its first sweep, before Codex's pickup window
    // even opens. One suites call, paid only on this would-park path,
    // re-anchors the age on the branch-born suite — the arrival's own record.
    const births = node.headRefName
      ? await checkSuiteBirths(api, {
        owner, name, sha: node.headRefOid, branch: node.headRefName, since: movedAt,
      })
      : null;
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
          await writer.rest(`/repos/${owner}/${name}/statuses/${node.headRefOid}`, {
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
 * answer.
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
    // derived from data the sweep itself reads — Codex's status table, an
    // unanswered head, a nudge newer than Codex's last word — so it holds on every
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
  const slug = input("repository", "GITHUB_REPOSITORY");
  const workflowToken = input("token", "GITHUB_TOKEN");
  if (!workflowToken || !slug) throw new Error("a token and a repository are required");
  const [owner, name] = slug.split("/");
  // Minted before the loop, and again inside it if a long one outlives the
  // token. A failure is the run failing, not a fallback -- see
  // `resolveStatusToken`, which also says why only the write uses it.
  const nextStatusToken = statusTokenSource({
    appId: input("app-id", "CODEX_APP_ID"),
    privateKey: input("app-private-key", "CODEX_APP_PRIVATE_KEY"),
    repo: slug,
  });
  // Eagerly, so a credential that cannot mint fails the run now rather
  // than on the first head it would have gated.
  await nextStatusToken();
  // One streak map and one cadence map for the whole run: a head failing
  // sweep after sweep accumulates toward MAX_FAIL_STREAK instead of
  // resetting every minute, and settled heads keep their revisit age.
  const streaks = new Map();
  const cadence = new Map();
  await runLoop({
    minutes: Number(input("loop-minutes", "SWEEP_LOOP_MINUTES") || 0),
    intervalSeconds: Number(input("interval-seconds", "SWEEP_INTERVAL_SECONDS") || 60),
    sweepOnce: async () => sweep({
      owner, name, token: workflowToken, statusToken: await nextStatusToken(), streaks, cadence,
    }),
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
