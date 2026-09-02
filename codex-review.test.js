import { describe, it, expect } from "./vitest-shim.mjs";
import {
  verdictFor,
  runLoop,
  PENDING,
  FINDINGS,
  matchesBot,
  matchesBotLogin,
  readReactions,
  restReactions,
  findingsOn,
  commentSignals,
  sweep,
  sharedHeads,
  CODEX_BOT,
  CONTEXT,
  UNREADABLE,
  MAX_FAIL_STREAK,
  utc,
  newestIn,
  input,
  cleanVerdict,
  UNANSWERED,
  UNANSWERED_FORK,
  reviewTableStatus,
} from "./codex-review.mjs";

describe("verdictFor", () => {
  it("is pending until Codex has reacted", () => {
    // The case auto-merge would otherwise race: CI green, Codex silent.
    expect(verdictFor({ approved: false })).toEqual({
      state: "pending",
      description: PENDING,
    });
  });

  it("is success once it has", () => {
    expect(verdictFor({ approved: true }).state).toBe("success");
  });

  it("refuses a head shared with another open PR, reaction or not", () => {
    // A status belongs to the commit and the reaction to the PR, so one
    // status cannot describe both.
    expect(verdictFor({ approved: true, sharedHead: true })).toEqual({
      state: "failure",
      description: "Head shared with another open PR — verdict is ambiguous",
    });
  });

  it("holds when someone has reacted 👎, even with the verdict in", () => {
    // The cheap way to stop an auto-merge from a phone.
    expect(verdictFor({ approved: true, held: "👎" })).toEqual({
      state: "failure",
      description: "On hold: 👎 on the pull request",
    });
  });

  it("holds on 👀 too", () => {
    expect(verdictFor({ approved: true, held: "👀" }).state).toBe("failure");
  });

  it("stays pending while Codex is reading, even over a 👍", () => {
    // The state that must NOT go `failure`: pending is what the lean gate
    // counts, so this is what keeps the minute loop polling through a
    // review. Codex swaps its 👀 for 👍 with no webhook — a loop already idle
    // would leave that 👍 to whatever wakes next: its own edit of the review
    // summary comment usually, and failing that the four-hourly backstop.
    expect(verdictFor({ approved: false, reading: true })).toEqual({
      state: "pending",
      description: PENDING,
    });
    expect(verdictFor({ approved: true, reading: true }).state).toBe("pending");
  });

  it("marks findings as pending for the gate but settled for the clock", () => {
    // Same closed gate, different description: FINDINGS is what the sweep's
    // lean gate reads as "waiting on a push, not on the next minute".
    expect(verdictFor({ findings: true })).toEqual({
      state: "pending",
      description: FINDINGS,
    });
  });

  it("lets a fresh 👍 outrank findings still naming this head", () => {
    // After a fix-and-nudge round the old review still names the head; the
    // fresh reaction is Codex saying it is now satisfied.
    expect(verdictFor({ approved: true, findings: true }).state).toBe("success");
  });

  it("lets reading outrank findings — a re-read is the verdict changing", () => {
    expect(verdictFor({ reading: true, findings: true })).toEqual({
      state: "pending",
      description: PENDING,
    });
  });

  it("reopens the wait when the owner nudges over a standing 👍", () => {
    // Asking Codex to look again means the standing verdict is no longer
    // the one wanted — honoring it would let auto-merge take a PR the owner
    // just asked to have re-reviewed. Codex's fresh answer (a 👍 newer than
    // the nudge) restores success through `approved` on a later sweep.
    expect(verdictFor({ approved: true, nudged: true })).toEqual({
      state: "pending",
      description: PENDING,
    });
  });

  it("skips drafts", () => {
    expect(verdictFor({ isDraft: true, approved: true })).toBeNull();
  });
});

describe("readReactions", () => {
  const HEAD = "2026-08-14T12:00:00Z";
  const CODEX = `${CODEX_BOT}[bot]`;
  // Reactions default to after the head, so each test states only the thing
  // it is about; the staleness cases pass their own timestamp.
  const react = (login, content, createdAt = "2026-08-14T12:05:00Z") =>
    ({ content, createdAt, user: { login } });
  const OWNER = "repo-owner";
  const read = (nodes) => readReactions(nodes, { since: HEAD, owner: OWNER });

  it("ignores a 👍 older than the commit it would approve", () => {
    // Codex revokes on push, but asynchronously — so between a push and its
    // noticing, the PR carries a new head and the previous head's reaction.
    // Reading those together approves a commit nobody reviewed.
    const stale = readReactions([react(CODEX, "THUMBS_UP", "2026-08-14T18:00:00Z")], { since: "2026-08-14T19:00:00Z" });
    expect(stale.approved).toBe(false);
  });

  it("takes a 👍 newer than the commit", () => {
    const fresh = readReactions([react(CODEX, "THUMBS_UP", "2026-08-14T19:30:00Z")], { since: "2026-08-14T19:00:00Z" });
    expect(fresh.approved).toBe(true);
  });

  it("holds on the owner's 👎 from before the head — a new commit is not an answer", () => {
    expect(
      readReactions([react(OWNER, "THUMBS_DOWN", "2026-08-14T18:00:00Z")], {
        since: "2026-08-14T19:00:00Z", owner: OWNER,
      }).held,
    ).toBe("👎");
  });

  it("ignores a hold from anyone but the owner", () => {
    // Public repo: an unrestricted hold outlives every head, so a passer-by
    // could block a PR for as long as they left the reaction there.
    expect(read([react("passer-by", "THUMBS_DOWN")]).held).toBeNull();
    expect(read([react("passer-by", "EYES")]).held).toBeNull();
  });

  it("takes Codex's 👍 as the verdict", () => {
    expect(read([react(CODEX, "THUMBS_UP")])).toEqual({
      approved: true,
      approvedAt: "2026-08-14T12:05:00Z",
      staleApproval: false,
      unverifiedApproval: false,
      held: null,
      reading: false,
    });
  });

  it("does not approve a 👍 that arrives with no evidence of the account", () => {
    // What GraphQL returns for every reactor: a bare login on a field typed
    // `User`. A human may register that username — app slugs and usernames
    // are separate namespaces — so approving here is the one fail-open move
    // this file could make. It defers instead, and the caller re-reads the
    // list from REST.
    const seen = read([{ content: "THUMBS_UP", createdAt: "2026-08-14T12:05:00Z", user: { login: CODEX_BOT } }]);
    expect(seen.approved).toBe(false);
    expect(seen.unverifiedApproval).toBe(true);
    // Not stale either: staleApproval is what buys the check-suite lookup,
    // and an unattributed reaction must not spend that call.
    expect(seen.staleApproval).toBe(false);
  });

  it("approves a bare login that REST reports as a Bot", () => {
    const seen = read([
      { content: "THUMBS_UP", createdAt: "2026-08-14T12:05:00Z", user: { login: CODEX_BOT, type: "Bot" } },
    ]);
    expect(seen.approved).toBe(true);
    expect(seen.unverifiedApproval).toBe(false);
  });

  it("refuses a 👍 from a same-named account REST reports as a human", () => {
    // The residual this channel used to carry, now closed: the login
    // matches, the account is a person, and the gate stays shut. It reads
    // as unverified rather than as a stranger's reaction on purpose — the
    // sweep says so in its log, since a squatter is worth naming and a
    // permanently pending gate is worth explaining.
    const seen = read([
      { content: "THUMBS_UP", createdAt: "2026-08-14T12:05:00Z", user: { login: CODEX_BOT, type: "User" } },
    ]);
    expect(seen.approved).toBe(false);
    expect(seen.unverifiedApproval).toBe(true);
  });

  it("ignores anyone else's 👍", () => {
    // The reaction is only a verdict because Codex revokes it on push.
    expect(read([react("someone-else", "THUMBS_UP")]).approved).toBe(false);
  });

  it("takes the owner's 👎 as a hold", () => {
    expect(read([react(OWNER, "THUMBS_DOWN")]).held).toBe("👎");
  });

  it("reports Codex's own 👀 as reading, not as a hold", () => {
    // Reading blocks approval like a hold does, but it maps to `pending`,
    // not `failure` — pending is what the lean gate counts, so this is what
    // keeps the minute loop running while the review is in flight. Codex
    // clears its 👀 when it reacts 👍, so a 👀 still present means the
    // answer is still being written.
    expect(read([react(CODEX, "EYES")])).toEqual({
      approved: false,
      approvedAt: null,
      staleApproval: false,
      unverifiedApproval: false,
      held: null,
      reading: true,
    });
  });

  it("keeps reading a 👍 that has picked up a 👀 since — a re-read in progress", () => {
    expect(
      read([react(CODEX, "THUMBS_UP"), react(CODEX, "EYES")]),
    ).toEqual({
      approved: true, approvedAt: "2026-08-14T12:05:00Z", staleApproval: false, unverifiedApproval: false,
      held: null, reading: true,
    });
  });

  it("prefers 👎 over 👀 when both are present", () => {
    expect(
      read([react(OWNER, "EYES"), react(OWNER, "THUMBS_DOWN")]).held,
    ).toBe("👎");
  });

  it("ignores a reaction it has no rule for", () => {
    expect(read([react(OWNER, "HOORAY")])).toEqual({
      approved: false,
      approvedAt: null,
      staleApproval: false,
      unverifiedApproval: false,
      held: null,
      reading: false,
    });
  });
});

describe("findingsOn", () => {
  const at = (commit_id, login, submitted_at = "2026-08-15T08:00:00Z") =>
    [{ user: { login }, commit_id, submitted_at }];

  it("returns the time of Codex's review of exactly this head", () => {
    expect(findingsOn(at("abc", `${CODEX_BOT}[bot]`), "abc")).toBe("2026-08-15T08:00:00Z");
  });

  it("returns the newest when Codex has reviewed the head more than once", () => {
    // The timestamp is what a nudge is compared against, so it must be
    // Codex's LAST word, not its first.
    expect(findingsOn([
      ...at("abc", `${CODEX_BOT}[bot]`, "2026-08-15T08:00:00Z"),
      ...at("abc", `${CODEX_BOT}[bot]`, "2026-08-15T09:00:00Z"),
    ], "abc")).toBe("2026-08-15T09:00:00Z");
  });

  it("ignores a review of a previous head — the commit id is the staleness guard", () => {
    expect(findingsOn(at("old", `${CODEX_BOT}[bot]`), "abc")).toBeNull();
  });

  it("ignores anyone else's review", () => {
    // Owner replies to threads arrive as reviews too; they are not findings.
    expect(findingsOn(at("abc", "repo-owner"), "abc")).toBeNull();
  });

  it("treats missing review data as no findings", () => {
    expect(findingsOn(undefined, "abc")).toBeNull();
    expect(findingsOn([{ user: null, commit_id: null }], "abc")).toBeNull();
  });
});

describe("commentSignals", () => {
  const MARK = "2026-08-15T07:00:00Z";
  const OWNER = "repo-owner";
  const c = (login, created_at, body = "") => ({ user: { login }, created_at, body });
  const read = (batch) => commentSignals(batch, { since: MARK, owner: OWNER });

  it("reports a Codex comment newer than the head's own commit", () => {
    expect(read([c(`${CODEX_BOT}[bot]`, "2026-08-15T08:00:00Z")]).codexAt).toBe("2026-08-15T08:00:00Z");
  });

  it("ignores a comment from before this head existed — it belongs to a previous head", () => {
    // REST's `since` filters on update time, so an edited old comment can
    // arrive in the batch; the created_at guard is what keeps it stale.
    expect(read([c(`${CODEX_BOT}[bot]`, "2026-08-15T06:00:00Z")]).codexAt).toBeNull();
  });

  it("reports the owner's newest @codex review nudge", () => {
    const { nudgeAt } = read([
      c(OWNER, "2026-08-15T08:00:00Z", "@codex review"),
      c(OWNER, "2026-08-15T09:00:00Z", "please @codex review again"),
    ]);
    expect(nudgeAt).toBe("2026-08-15T09:00:00Z");
  });

  it("ignores a nudge-shaped comment from anyone but the owner", () => {
    // Public repo: a passer-by's nudge must not hold the loop open, for
    // the same reason their reactions cannot hold the gate.
    expect(read([c("passer-by", "2026-08-15T08:00:00Z", "@codex review")]).nudgeAt).toBeNull();
  });

  it("does not read an ordinary owner comment as a nudge", () => {
    expect(read([c(OWNER, "2026-08-15T08:00:00Z", "looks good")]).nudgeAt).toBeNull();
  });

  it("reports nothing when the head's commit date is missing", () => {
    // Defensive: with no bound nothing can be tied to this head, and
    // nothing is the safe direction — the loop keeps polling for minutes,
    // where a wrong "findings" strands the verdict on the throttled
    // schedule.
    expect(commentSignals([c(`${CODEX_BOT}[bot]`, "2026-08-15T08:00:00Z")], { since: undefined, owner: OWNER }))
      .toEqual({ codexAt: null, nudgeAt: null, cleanAt: null });
  });
});

describe("newestIn", () => {
  it("takes the newest node, not the first one", () => {
    // A GraphQL connection is oldest-first, so `nodes[0]` of a `last:N`
    // window is the Nth-most-recent event. Every caller asks for `last:1`
    // today, where the two coincide -- this is what keeps raising a bound
    // from silently flooring the verdict on the oldest event in the page.
    expect(newestIn({ nodes: [
      { createdAt: "2026-08-14T10:00:00Z" },
      { createdAt: "2026-08-14T12:00:00Z" },
      { createdAt: "2026-08-14T11:00:00Z" },
    ] })).toBe("2026-08-14T12:00:00Z");
  });

  it("is null for an absent, empty or malformed connection", () => {
    // The absent case is ordinary: a pull request that has never been
    // force-pushed or retargeted has no such event, and null means "no
    // floor from here" rather than an error.
    expect(newestIn(undefined)).toBeNull();
    expect(newestIn({ nodes: [] })).toBeNull();
    expect(newestIn({ nodes: [{}] })).toBeNull();
  });
});

describe("utc", () => {
  it("passes a UTC string through byte-identical", () => {
    // Reformatting would add millisecond precision and quietly change what
    // an identical-status comparison sees.
    expect(utc("2026-08-15T10:00:00Z")).toBe("2026-08-15T10:00:00Z");
  });

  it("converts an offset timestamp to UTC", () => {
    expect(utc("2026-08-15T05:00:00-07:00")).toBe("2026-08-15T12:00:00.000Z");
  });

  it("returns null for nothing and for garbage", () => {
    expect(utc(null)).toBeNull();
    expect(utc(undefined)).toBeNull();
    expect(utc("not a time")).toBeNull();
  });

  it("keeps a fresh 👍 fresh when its timestamp carries an offset", () => {
    // The comparison that goes wrong without normalization: 05:05-07:00 IS
    // 12:05Z — after the head — but as a raw string it sorts before
    // "...T12:00:00Z" and would read as stale, sticking the gate at
    // pending. Today GitHub sends UTC everywhere this file reads; this
    // pins the behavior if a future field swap brings offsets in.
    const seen = readReactions(
      [{ content: "THUMBS_UP", createdAt: "2026-08-14T05:05:00-07:00", user: { login: `${CODEX_BOT}[bot]` } }],
      { since: "2026-08-14T12:00:00Z" },
    );
    expect(seen.approved).toBe(true);
    expect(seen.approvedAt).toBe("2026-08-14T12:05:00.000Z");
  });
});

describe("matchesBot", () => {
  it("matches the suffixed spelling on its own — brackets are illegal in usernames", () => {
    expect(matchesBot(`${CODEX_BOT}[bot]`)).toBe(true);
    expect(matchesBot({ login: `${CODEX_BOT}[bot]` })).toBe(true);
  });

  it("matches the bare spelling only with REST's user.type saying Bot", () => {
    // App slugs and usernames are separate namespaces: a HUMAN registered
    // under the bot's name must not inherit its verdict authority. No type
    // on a bare login fails closed. __typename is deliberately NOT checked
    // here — matchesBot is for REST-sourced actors only; see matchesBotLogin
    // for why a GraphQL Reaction.user can never carry real type evidence.
    expect(matchesBot({ login: CODEX_BOT, type: "Bot" })).toBe(true);
    expect(matchesBot({ login: CODEX_BOT, type: "User" })).toBe(false);
    expect(matchesBot({ login: CODEX_BOT, __typename: "Bot" })).toBe(false);
    expect(matchesBot(CODEX_BOT)).toBe(false);
    expect(matchesBot({ login: CODEX_BOT })).toBe(false);
  });

  it("rejects anyone else, and a missing login", () => {
    // The reaction is only a verdict because Codex revokes it on push;
    // a human's 👍 carries no such guarantee.
    expect(matchesBot("someone-else")).toBe(false);
    expect(matchesBot({ login: "someone-else[bot]" })).toBe(false);
    expect(matchesBot(undefined)).toBe(false);
  });
});

describe("matchesBotLogin", () => {
  // GraphQL's Reaction.user is declared as the concrete User type, not the
  // polymorphic Actor interface — its __typename is a schema constant
  // ("User") for every reactor, so no type evidence can ever exist on this
  // one channel. A same-named human account forging a reaction is the
  // accepted residual risk here; this is why readReactions uses this check
  // and not matchesBot for the GraphQL nodes it reads.
  it("matches the bare spelling with no type evidence required", () => {
    expect(matchesBotLogin(CODEX_BOT)).toBe(true);
  });

  it("matches the suffixed spelling too", () => {
    expect(matchesBotLogin(`${CODEX_BOT}[bot]`)).toBe(true);
  });

  it("rejects anyone else, and a missing login", () => {
    expect(matchesBotLogin("someone-else")).toBe(false);
    expect(matchesBotLogin(undefined)).toBe(false);
  });
});

describe("restReactions", () => {
  const api = (pages) => ({
    calls: [],
    async rest(path) {
      this.calls.push(path);
      const n = Number(new URLSearchParams(path.split("?")[1]).get("page"));
      return pages[n - 1] ?? [];
    },
  });

  it("shapes REST reactions like the GraphQL nodes one reader reads", async () => {
    const client = api([[
      { content: "+1", created_at: "2026-08-14T12:05:00Z", user: { login: `${CODEX_BOT}[bot]`, type: "Bot" } },
      { content: "-1", created_at: "2026-08-14T12:06:00Z", user: { login: "o", type: "User" } },
      { content: "eyes", created_at: "2026-08-14T12:07:00Z", user: { login: "o", type: "User" } },
    ]]);
    expect(await restReactions(client, { owner: "o", name: "r", number: 1 })).toEqual([
      { content: "THUMBS_UP", createdAt: "2026-08-14T12:05:00Z", user: { login: `${CODEX_BOT}[bot]`, type: "Bot" } },
      { content: "THUMBS_DOWN", createdAt: "2026-08-14T12:06:00Z", user: { login: "o", type: "User" } },
      { content: "EYES", createdAt: "2026-08-14T12:07:00Z", user: { login: "o", type: "User" } },
    ]);
    expect(client.calls[0]).toBe("/repos/o/r/issues/1/reactions?per_page=100&page=1");
  });

  it("reads the PR-body reactions, which live on the issue endpoint", async () => {
    const client = api([[]]);
    await restReactions(client, { owner: "o", name: "r", number: 7 });
    expect(client.calls).toEqual(["/repos/o/r/issues/7/reactions?per_page=100&page=1"]);
  });

  it("pages to the end — a 👍 on a later page is still the verdict", async () => {
    const filler = Array.from({ length: 100 }, () => (
      { content: "heart", created_at: "2026-08-14T12:00:00Z", user: { login: "passer-by", type: "User" } }
    ));
    const client = api([filler, [
      { content: "+1", created_at: "2026-08-14T12:05:00Z", user: { login: `${CODEX_BOT}[bot]`, type: "Bot" } },
    ]]);
    const all = await restReactions(client, { owner: "o", name: "r", number: 1 });
    expect(all.length).toBe(101);
    expect(all.at(-1).content).toBe("THUMBS_UP");
    // A content with no rule keeps REST's own name rather than being
    // invented into a GraphQL one that does not exist here.
    expect(all[0].content).toBe("heart");
  });
});

describe("sharedHeads", () => {
  it("names only the SHAs carried by more than one PR", () => {
    expect([...sharedHeads([{ headRefOid: "a" }, { headRefOid: "a" }, { headRefOid: "b" }])]).toEqual(["a"]);
  });

  it("is empty when every head is distinct", () => {
    expect(sharedHeads([{ headRefOid: "a" }, { headRefOid: "b" }]).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sweep, driven by a fake fetch. Every request it makes is recorded, so these
// assert what it asked for as well as what it concluded.

const page = (nodes, hasNextPage = false, endCursor = null) => ({
  nodes,
  pageInfo: { hasNextPage, endCursor },
});

const GATED_AT = "2026-08-14T12:00:00Z";
const AFTER = "2026-08-14T12:05:00Z";
const BEFORE = "2026-08-14T11:00:00Z";

// Codex's status-table comment, in the shape observed live on 2026-09-02:
// a row per review kind, each naming its own commit, with the security row
// deliberately carrying a DIFFERENT one -- that is what the per-row reading
// has to survive.
const summaryTable = ({ status, commit, security = "Completed", securityCommit = "0beef12" }) => [
  "<!-- codex-pull-request-review-summary -->",
  `<!-- codex-security-review:v1 {"headSha":"${securityCommit}","status":"completed"} -->`,
  "## Codex Review Summary",
  "",
  "| Review | Status | Commit | Review trigger |",
  "| --- | --- | --- | --- |",
  `| 📝 **Code Review** | **${status}** <relative-time datetime="2026-09-02T14:05:12Z">t</relative-time> | \`${commit}\` | New commits |`,
  `| 🔒 **Security Review** | **${security}** <relative-time datetime="2026-09-02T14:04:07Z">t</relative-time> | \`${securityCommit}\` | PR opened |`,
  "",
  "<details> <summary>About Codex in GitHub</summary> boilerplate </details>",
].join("\n");
// When the head commit was made — the comment walk's lower bound, always
// earlier than the marker but later than anything about a previous head.
const BORN_AT = "2026-08-14T11:30:00Z";
const OWNER = "o";

// The marker: the earliest `codex` status on the head, saying when it was
// first gated. A reaction has to be newer than this to count as approval.
const gate = (created_at = GATED_AT, state = "pending", description = PENDING) =>
  ({ context: CONTEXT, state, description, created_at });

// The suite born on the PR's own branch — what dates a same-repo head's
// arrival. Approval fixtures need one: a head with no branch-born suite is
// undatable and fails closed by design.
const bornSuite = (created_at = "2026-08-14T11:59:00Z", head_branch = "claude/topic") =>
  ({ created_at, head_branch });

const prNode = (over = {}) => ({
  number: 1,
  isDraft: false,
  headRefOid: "abc1234",
  headRefName: "claude/topic",
  isCrossRepository: false,
  updatedAt: GATED_AT,
  commits: { nodes: [{ commit: { committedDate: BORN_AT } }] },
  reactions: page([]),
  ...over,
});

const review = (commit_id = "abc1234", login = `${CODEX_BOT}[bot]`, submitted_at = AFTER) => ({
  user: { login },
  commit_id,
  submitted_at,
});

const thumbs = (login = `${CODEX_BOT}[bot]`, createdAt = AFTER) => ({
  content: "THUMBS_UP",
  createdAt,
  user: { login },
});
// What GraphQL actually returns for a bot's reaction: the login with no
// `[bot]` suffix, on a field typed `User`, so nothing on it says Bot.
const bareThumbs = (createdAt = AFTER) => ({
  content: "THUMBS_UP",
  createdAt,
  user: { login: CODEX_BOT },
});
// The same reaction read back from REST, where a bot's login carries the
// suffix a username may not, and `user.type` says so besides.
const restThumbs = (user = { login: `${CODEX_BOT}[bot]`, type: "Bot" }, created_at = AFTER) => ({
  content: "+1",
  created_at,
  user,
});
const hold = (content = "THUMBS_DOWN", login = OWNER) => ({
  content,
  createdAt: AFTER,
  user: { login },
});

// `statuses` maps a SHA to its `codex` entries, newest first, as GitHub
// returns them. A GET on the statuses path reads them; a POST writes one.
// `issueComments` maps a PR number to REST-shaped comments; the fake honors
// paging but not `since` — the code under test re-filters by created_at.
function fakeFetch({
  graphqlResponses = [], statuses = {}, issueComments = {}, prReviews = {},
  reviewThreadComments = {}, checkSuites = {}, issueReactions = {},
  failStatusWrite = false, failComments = false,
} = {}) {
  const calls = [];
  const queue = [...graphqlResponses];
  const impl = async (url, opts = {}) => {
    const path = url.replace("https://api.github.com", "");
    const method = opts.method ?? "GET";
    calls.push({ path, method, body: opts.body ? JSON.parse(opts.body) : null });

    if (path === "/graphql") {
      const data = queue.shift();
      if (!data) throw new Error("unexpected extra graphql call");
      return { ok: true, status: 200, json: async () => (data.errors ? data : { data }) };
    }
    if (path.includes("/check-suites")) {
      const sha = path.split("/commits/")[1].split("/")[0];
      const page = Number(new URLSearchParams(path.split("?")[1] ?? "").get("page") ?? 1);
      const all = checkSuites[sha] ?? [];
      return {
        ok: true,
        status: 200,
        json: async () => ({ check_suites: all.slice((page - 1) * 100, page * 100) }),
      };
    }
    if (path.includes("/reactions")) {
      const number = path.split("/issues/")[1].split("/")[0];
      const page = Number(new URLSearchParams(path.split("?")[1] ?? "").get("page") ?? 1);
      const all = issueReactions[number] ?? [];
      return { ok: true, status: 200, json: async () => all.slice((page - 1) * 100, page * 100) };
    }
    if (path.includes("/comments")) {
      if (failComments) return { ok: false, status: 500, json: async () => ({}) };
      const kind = path.includes("/issues/") ? "/issues/" : "/pulls/";
      const number = path.split(kind)[1].split("/")[0];
      const page = Number(new URLSearchParams(path.split("?")[1] ?? "").get("page") ?? 1);
      const all = (kind === "/issues/" ? issueComments : reviewThreadComments)[number] ?? [];
      return { ok: true, status: 200, json: async () => all.slice((page - 1) * 100, page * 100) };
    }
    if (path.includes("/reviews")) {
      const number = path.split("/pulls/")[1].split("/")[0];
      const page = Number(new URLSearchParams(path.split("?")[1] ?? "").get("page") ?? 1);
      const all = prReviews[number] ?? [];
      return { ok: true, status: 200, json: async () => all.slice((page - 1) * 100, page * 100) };
    }
    if (path.includes("/statuses/")) {
      if (method === "GET") {
        const sha = path.split("/statuses/")[1].split("?")[0];
        const page = Number(new URLSearchParams(path.split("?")[1] ?? "").get("page") ?? 1);
        const all = statuses[sha] ?? [];
        return { ok: true, status: 200, json: async () => all.slice((page - 1) * 100, page * 100) };
      }
      if (failStatusWrite) return { ok: false, status: 422, json: async () => ({}) };
      return { ok: true, status: 201, json: async () => ({}) };
    }
    throw new Error(`unexpected path ${path}`);
  };
  return { impl, calls };
}

const repoPRs = (nodes, hasNextPage = false, endCursor = null) => ({
  repository: { pullRequests: page(nodes, hasNextPage, endCursor) },
});

// Most tests only care about what was written; `active` has its own cases.
// A fixed clock near the fixtures' own times, so the unanswered-head decay
// judges ages the way a live sweep would minutes after the events — not
// against the wall clock, which is years past every fixture.
const TEST_NOW = () => Date.parse("2026-08-14T12:06:00Z");
const runFull = (fake) => sweep({ owner: OWNER, name: "r", token: "t", fetchImpl: fake.impl, log: () => {}, now: TEST_NOW });
const run = async (fake) => (await runFull(fake)).written;

describe("sweep", () => {
  it("publishes pending for a PR Codex has not reacted to", async () => {
    // No `codex` status yet: this sweep is what first gates the head, and
    // writing that marker is what a later sweep judges a reaction against.
    const fake = fakeFetch({ graphqlResponses: [repoPRs([prNode()])] });
    expect(await run(fake)).toEqual([
      { number: 1, state: "pending", description: PENDING },
    ]);
    const write = fake.calls.find((c) => c.method === "POST" && c.path.includes("/statuses/"));
    expect(write.body).toMatchObject({ context: CONTEXT, state: "pending" });
    expect(write.path).toContain("abc1234");
  });

  it("publishes success once Codex has reacted", async () => {
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      checkSuites: { abc1234: [bornSuite()] },
      graphqlResponses: [repoPRs([prNode({ reactions: page([thumbs()]) })])],
    });
    expect((await run(fake))[0].state).toBe("success");
  });

  it("verifies a bare-login 👍 against REST before approving", async () => {
    // GraphQL spells a bot's login bare, and its `Reaction.user` is typed
    // `User`, so nothing there separates Codex from a human of the same
    // name. REST spells it `…[bot]` — illegal in a username — so the same
    // reaction, read there, is attributable.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      checkSuites: { abc1234: [bornSuite()] },
      graphqlResponses: [repoPRs([prNode({ reactions: page([bareThumbs()]) })])],
      issueReactions: { 1: [restThumbs()] },
    });
    expect((await run(fake))[0].state).toBe("success");
    expect(fake.calls.some((c) => c.path.startsWith("/repos/o/r/issues/1/reactions"))).toBe(true);
  });

  it("refuses the 👍 when REST reports the reactor as a human", async () => {
    // The squatting case the login alone could never catch: a person
    // registered under the bot's name reacts 👍, and the gate stays shut.
    const lines = [];
    const fake = fakeFetch({
      // A standing `success` from before the squatter's 👍 was refused, so
      // the refusal has something to write: an identical status is skipped.
      statuses: { abc1234: [gate(GATED_AT, "success")] },
      checkSuites: { abc1234: [bornSuite()] },
      graphqlResponses: [repoPRs([prNode({ reactions: page([bareThumbs()]) })])],
      issueReactions: { 1: [restThumbs({ login: CODEX_BOT, type: "User" })] },
    });
    const written = (await sweep({
      owner: OWNER, name: "r", token: "t", fetchImpl: fake.impl,
      log: (l) => lines.push(l), now: TEST_NOW,
    })).written;
    expect(written[0].state).toBe("pending");
    // A gate that will never clear on its own says why in the run log.
    expect(lines.some((l) => l.includes("not approving"))).toBe(true);
  });

  it("pays no REST call for a head with no 👍 in play", async () => {
    // The verification is bought only where it decides something: a head
    // Codex has not answered costs exactly what it did before.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      graphqlResponses: [repoPRs([prNode({ reactions: page([hold("EYES", "passer-by")]) })])],
    });
    await run(fake);
    expect(fake.calls.some((c) => c.path.includes("/reactions"))).toBe(false);
  });

  it("re-reads the verified list locally when a check suite moves the bound", async () => {
    // The rebound paths used to re-walk the reaction pagination for a list
    // that cannot change inside one sweep; now they cost nothing. One REST
    // read, however many bounds the head is judged against.
    const fake = fakeFetch({
      // A status later than the 👍, so the 👍 reads stale and the
      // earliest-suite rescue lowers the bound and revives it.
      statuses: { abc1234: [gate("2026-08-14T12:10:00Z")] },
      checkSuites: { abc1234: [bornSuite("2026-08-14T11:59:00Z")] },
      graphqlResponses: [repoPRs([prNode({ reactions: page([bareThumbs()]) })])],
      issueReactions: { 1: [restThumbs()] },
    });
    expect((await run(fake))[0].state).toBe("success");
    expect(fake.calls.filter((c) => c.path.includes("/reactions")).length).toBe(1);
  });

  it("ignores a thumbs-up from anyone else", async () => {
    const fake = fakeFetch({
      graphqlResponses: [repoPRs([prNode({ reactions: page([thumbs("someone-else")]) })])],
    });
    expect((await run(fake))[0].state).toBe("pending");
  });

  it("does not rewrite an identical status", async () => {
    const fake = fakeFetch({
      graphqlResponses: [repoPRs([prNode()])],
      statuses: { abc1234: [gate()] },
    });
    expect(await run(fake)).toEqual([]);
    // The GET shares this path, so only a POST counts as a rewrite.
    expect(fake.calls.some((c) => c.method === "POST" && c.path.includes("/statuses/"))).toBe(false);
  });

  it("rewrites when the state has moved on", async () => {
    const fake = fakeFetch({
      graphqlResponses: [repoPRs([prNode({ reactions: page([thumbs()]) })])],
      statuses: { abc1234: [{ ...gate(), description: "old" }] },
      checkSuites: { abc1234: [bornSuite()] },
    });
    expect((await run(fake))[0].state).toBe("success");
  });

  it("skips drafts without touching the status API", async () => {
    const fake = fakeFetch({ statuses: { abc1234: [gate()] }, graphqlResponses: [repoPRs([prNode({ isDraft: true })])] });
    expect(await run(fake)).toEqual([]);
    expect(fake.calls.filter((c) => c.path !== "/graphql")).toEqual([]);
  });

  it("follows reactor pages before declaring pending", async () => {
    // Codex's reaction past the first page would otherwise stick the status
    // on pending forever, refetching the same truncated page each sweep.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      checkSuites: { abc1234: [bornSuite()] },
      graphqlResponses: [
        repoPRs([prNode({ reactions: page([thumbs("someone-else")], true, "cursor9") })]),
        { repository: { pullRequest: { reactions: page([thumbs()]) } } },
      ],
    });
    expect((await run(fake))[0].state).toBe("success");
  });

  it("stays pending on a 👍 that predates the head being gated", async () => {
    // The push-vs-revoke race, end to end: new head, previous head's 👍.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      graphqlResponses: [repoPRs([prNode({ reactions: page([thumbs(undefined, BEFORE)]) })])],
    });
    // The head is already marked pending, so a correct sweep writes nothing;
    // what would show here is the 👍 flipping it to success.
    expect(await run(fake)).toEqual([]);
    expect(fake.calls.some((c) => c.method === "POST" && c.path.includes("/statuses/"))).toBe(false);
  });

  it("stays pending on a head that has never been gated", async () => {
    // No marker means nothing to date the reaction against, and an
    // unexpected result must not be readable as approval.
    const fake = fakeFetch({
      graphqlResponses: [
        repoPRs([prNode({ reactions: page([thumbs()]) })]),
      ],
    });
    expect((await run(fake))[0].state).toBe("pending");
  });

  it("pages past a head's other statuses to find the gate marker", async () => {
    // The endpoint returns every context, so a full page of Vercel statuses
    // can hide the marker. Losing it is not a harmless truncation: the sweep
    // would write a replacement, and the existing 👍 would be older than it
    // and rejected by every later sweep.
    const filler = Array.from({ length: 100 }, () => ({ context: "vercel", state: "success", created_at: AFTER }));
    const fake = fakeFetch({
      statuses: { abc1234: [...filler, gate()] },
      checkSuites: { abc1234: [bornSuite()] },
      graphqlResponses: [repoPRs([prNode({ reactions: page([thumbs()]) })])],
    });
    expect((await run(fake))[0].state).toBe("success");
  });

  it("withholds approval while someone is holding the PR", async () => {
    const fake = fakeFetch({
      graphqlResponses: [repoPRs([prNode({ reactions: page([thumbs(), hold()]) })])],
    });
    expect((await run(fake))[0]).toEqual({
      number: 1,
      state: "failure",
      description: "On hold: 👎 on the pull request",
    });
  });

  it("finds a hold on a later reaction page rather than approving over it", async () => {
    // Why the page walk has no short-circuit on the thumbs-up: stopping at
    // the verdict would merge past a hold nobody got to see.
    const fake = fakeFetch({
      graphqlResponses: [
        repoPRs([prNode({ reactions: page([thumbs()], true, "cursor9") })]),
        { repository: { pullRequest: { reactions: page([hold()]) } } },
      ],
    });
    expect((await run(fake))[0].state).toBe("failure");
  });

  it("counts only pending verdicts toward the loop's lean gate", async () => {
    // One PR waiting on Codex, one already approved, one draft: only the
    // first should keep the fast clock running.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()], bbb: [gate()] },
      checkSuites: { bbb: [bornSuite()] },
      graphqlResponses: [repoPRs([
        prNode(),
        prNode({ number: 2, headRefOid: "bbb", reactions: page([thumbs()]) }),
        prNode({ number: 3, isDraft: true, headRefOid: "d1" }),
      ])],
    });
    expect((await runFull(fake)).awaiting).toBe(1);
  });

  it("keeps the loop running while Codex is reading", async () => {
    // Codex's 👀 is the review in flight. It must land as `pending` and
    // count toward `awaiting`: the swap from 👀 to 👍 emits no webhook, so a
    // loop that treated reading as a hold would go idle at the exact moment
    // the next minute could change the answer, leaving the 👍 to the
    // throttled schedule.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      graphqlResponses: [repoPRs([
        prNode({ reactions: page([hold("EYES", `${CODEX_BOT}[bot]`)]) }),
      ])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(1);
    // Unchanged from the marker's pending, so nothing is rewritten either.
    expect(out.written).toEqual([]);
  });

  it("parks a reading head once Codex's table says it is still reading", async () => {
    // The premise of the test above -- that the answer's arrival has no
    // webhook -- stopped holding when Codex began maintaining a status
    // table it EDITS to `Completed`. That edit is an `issue_comment` event,
    // so the read no longer has to be polled through: park, and let the
    // edit be the wake. Still `pending`, so nothing fails open.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      issueComments: {
        1: [{
          user: { login: `${CODEX_BOT}[bot]`, type: "Bot" },
          created_at: BEFORE,
          body: summaryTable({ status: "Running", commit: "abc1234" }),
        }],
      },
      graphqlResponses: [repoPRs([
        prNode({ reactions: page([hold("EYES", `${CODEX_BOT}[bot]`)]) }),
      ])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(0);
    expect(out.written).toEqual([]);
  });

  it("keeps polling a reading head whose table is about another commit", async () => {
    // The other direction, and the one that matters: a table row naming a
    // commit that is not this head says nothing about this head, so the
    // clock has to keep running exactly as it did before the table
    // existed. Observed live -- the rows disagree, carrying different
    // commits at the same moment -- so this is the ordinary case after a
    // push, not a contrived one.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      issueComments: {
        1: [{
          user: { login: `${CODEX_BOT}[bot]`, type: "Bot" },
          created_at: BEFORE,
          body: summaryTable({ status: "Running", commit: "0beef12" }),
        }],
      },
      graphqlResponses: [repoPRs([
        prNode({ reactions: page([hold("EYES", `${CODEX_BOT}[bot]`)]) }),
      ])],
    });
    expect((await runFull(fake)).awaiting).toBe(1);
  });

  it("stops the clock once Codex has returned findings for the head", async () => {
    // A review naming the current head with no fresh 👍 means the next
    // change is a push — which restarts the loop by event — so polling for
    // it would only burn the runner. The status flips to the FINDINGS
    // wording so the check line says what is actually being waited for.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      prReviews: { 1: [review()] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(0);
    expect(out.written).toEqual([
      { number: 1, state: "pending", description: FINDINGS },
    ]);
  });

  it("closes the gate on a top-level comment but keeps the clock running", async () => {
    // The third finding stream: no submitted review, just a PR comment —
    // tied to the head by being newer than the head commit's own date,
    // since comments carry no commit id. That missing commit id is also why
    // the clock keeps running: Codex finishing the PREVIOUS head after a
    // push posts exactly this shape, and the clean 👍 it may still give the
    // current head emits no webhook — settling the loop here would leave
    // that 👍 to the throttled schedule. Only a review matched to this head
    // stops the clock.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      issueComments: { 1: [{ user: { login: `${CODEX_BOT}[bot]` }, created_at: AFTER }] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(1);
    expect(out.written[0].description).toBe(FINDINGS);
  });

  it("approves a FORK head on a clean comment, where its 👍 cannot", async () => {
    // The premise of the fork park's wording, asserted as behavior rather
    // than left implied by the sentence (Codex, PR #37). `judge` refuses a
    // fork head's 👍 because GitHub stamps no `head_branch` on a fork's
    // suites, so its arrival is undatable — but a clean COMMENT names the
    // commit it read, which is the attribution the reaction lacks, so
    // `cleanIsLatest` approves here with no suite consulted at all.
    //
    // Without this, the only thing pinning that asymmetry is the wording
    // test — and a wording test cannot notice the day someone gates
    // `cleanIsLatest` on the suites too, which would leave the published
    // sentence promising a remedy the code had quietly stopped honoring.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      issueComments: {
        1: [{
          user: { login: `${CODEX_BOT}[bot]` },
          created_at: AFTER,
          body: "Codex Review: Didn\u0027t find any major issues.\n\n**Reviewed commit:** `abc1234`",
        }],
      },
      graphqlResponses: [repoPRs([prNode({ isCrossRepository: true })])],
    });
    const out = await runFull(fake);
    expect(out.written[0].state).toBe("success");
    expect(out.awaiting).toBe(0);
  });

  it("approves on a clean comment that names this head", async () => {
    // Codex's footer promises a 👍 when it finds nothing; on codex-review#13
    // it posted a clean COMMENT instead and reacted to the nudge rather than
    // the PR body. With the reaction channel empty the gate read "answered,
    // not approved" = FINDINGS, over a pull request with no finding anywhere
    // on it. A clean verdict naming the head is the same attributable
    // evidence a review gives, so it approves.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      issueComments: {
        1: [{
          user: { login: `${CODEX_BOT}[bot]` },
          created_at: AFTER,
          body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `abc1234`",
        }],
      },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const out = await runFull(fake);
    expect(out.written[0].state).toBe("success");
    expect(out.awaiting).toBe(0);
  });

  it("stops approving when findings land after the clean comment", async () => {
    // A clean comment then a findings pass on the SAME head -- an owner
    // nudge is the ordinary route. The reaction may outrank findings
    // because Codex re-adds it after a re-read; a comment is a fixed point
    // in time, so the newest Codex answer has to win.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      issueComments: {
        1: [
          {
            user: { login: `${CODEX_BOT}[bot]` },
            created_at: AFTER,
            body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `abc1234`",
          },
          { user: { login: `${CODEX_BOT}[bot]` }, created_at: "2026-08-14T12:09:00Z" },
        ],
      },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const out = await runFull(fake);
    expect(out.written[0].description).toBe(FINDINGS);
  });

  it("does not let a clean comment on an older commit settle this head", async () => {
    // A sibling repo's pull request: a clean comment on an older commit,
    // nine hours and one head
    // earlier, was counted as an answer and published FINDINGS. It is
    // evidence about code that is gone, so it decides nothing here -- the
    // head goes back to waiting rather than claiming a verdict.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      issueComments: {
        1: [{
          user: { login: `${CODEX_BOT}[bot]` },
          created_at: AFTER,
          body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `0beef123`",
        }],
      },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const out = await runFull(fake);
    // Nothing is published: the head's standing marker is already PENDING,
    // and `publish` skips an unchanged write. Before this, the same fixture
    // wrote FINDINGS over it. The head also stays on the clock, so the 👍
    // or the real verdict is still caught within a poll interval.
    expect(out.written).toEqual([]);
    expect(out.awaiting).toBe(1);
  });

  it("hears a comment finding that landed before the head was first gated", async () => {
    // The no-marker ordering: Codex's comment arrives before any `codex`
    // status exists (a delayed first sweep), and the sweep's own first
    // write would then be a marker NEWER than the finding. Bounding the
    // comment walk by that marker filtered the finding out of every later
    // sweep, forever — an always-on loop with nothing left that could end
    // it. The bound is the head commit's own date, which precedes anything
    // said about the head by construction.
    const fake = fakeFetch({
      issueComments: { 1: [{ user: { login: `${CODEX_BOT}[bot]` }, created_at: AFTER }] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(1);
    expect(out.written[0].description).toBe(FINDINGS);
  });

  it("ignores a comment about a previous head — older than this head's commit", async () => {
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      issueComments: { 1: [{ user: { login: `${CODEX_BOT}[bot]` }, created_at: BEFORE }] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(1);
    expect(out.written).toEqual([]);
  });

  it("pages the comment stream to the end rather than trusting any window", async () => {
    // The eviction hazard: a finding buried behind ANY number of pages of
    // later chatter must still be found, or the loop revives for good — a
    // fixed page cap is the same hole one order of magnitude later, so the
    // finding here sits past what a ten-page cap would have read.
    const filler = Array.from({ length: 1000 }, () => ({ user: { login: "someone-else" }, created_at: AFTER }));
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      issueComments: { 1: [...filler, { user: { login: `${CODEX_BOT}[bot]` }, created_at: AFTER }] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(1);
    expect(out.written[0].description).toBe(FINDINGS);
  });

  it("pages the review stream to the end too", async () => {
    // Same eviction logic as comments: a Codex review of the current head
    // behind a full page of reply-reviews still stops the clock.
    const filler = Array.from({ length: 100 }, () => review("oldhead", "repo-owner"));
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      prReviews: { 1: [...filler, review()] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(0);
    expect(out.written[0].description).toBe(FINDINGS);
  });

  it("asks for no comments on a PR a hold already settles", async () => {
    // The streams are fetched only when they could change the answer. A
    // hold outranks everything a comment could say, so it costs no extra
    // call — but an APPROVED head still gets the walk: a newer owner nudge
    // must be able to reopen the wait (see below).
    const fake = fakeFetch({
      graphqlResponses: [repoPRs([prNode({ reactions: page([hold()]) })])],
    });
    await runFull(fake);
    expect(fake.calls.some((c) => c.path.includes("/comments"))).toBe(false);
  });

  it("reopens the wait when the owner nudges over a standing 👍", async () => {
    // A re-review request on an approved head: honoring the old 👍 while
    // the answer is due again would let auto-merge take a PR the owner just
    // asked to have re-read. The nudge is newer than the 👍 — Codex's last
    // word on a clean pass — so the gate closes and the head counts as
    // awaiting until the fresh answer lands.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      issueComments: { 1: [{ user: { login: OWNER }, created_at: "2026-08-14T12:10:00Z", body: "@codex review" }] },
      graphqlResponses: [repoPRs([prNode({ reactions: page([thumbs()]) })])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(1);
    // The marker already says PENDING, so nothing is rewritten either.
    expect(out.written).toEqual([]);
  });

  it("restores success once a fresh 👍 postdates the nudge", async () => {
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      checkSuites: { abc1234: [bornSuite()] },
      issueComments: { 1: [{ user: { login: OWNER }, created_at: "2026-08-14T12:10:00Z", body: "@codex review" }] },
      graphqlResponses: [repoPRs([prNode({ reactions: page([thumbs(undefined, "2026-08-14T12:15:00Z")]) })])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(0);
    expect(out.written[0].state).toBe("success");
  });

  it("stops approving when findings land after the 👍 on the same head", async () => {
    // The reaction channel's version of the clean-comment ordering bug: a
    // standing 👍, then a findings review naming the SAME head. Codex
    // provably revokes the reaction on push, not on a later findings pass,
    // so the leftover 👍 must not outrank the newer written word — honoring
    // it would hand auto-merge a success with an unaddressed finding.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      prReviews: { 1: [review("abc1234", undefined, "2026-08-14T12:09:00Z")] },
      graphqlResponses: [repoPRs([prNode({ reactions: page([thumbs()]) })])],
    });
    const out = await runFull(fake);
    expect(out.written[0].description).toBe(FINDINGS);
  });

  it("keeps approving on a 👍 newer than the findings it answers", async () => {
    // The fix-and-nudge round the standing order exists for: the old review
    // still names this head, and the fresh 👍 is Codex saying it is
    // satisfied. Recency is what separates this from the leftover above.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      checkSuites: { abc1234: [bornSuite()] },
      prReviews: { 1: [review()] },
      graphqlResponses: [repoPRs([prNode({ reactions: page([thumbs(undefined, "2026-08-14T12:15:00Z")]) })])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(0);
    expect(out.written[0].state).toBe("success");
  });

  it("fails closed when the 👍 and the findings share a second", async () => {
    // GitHub stamps to the second, so a tie is an unresolved ordering —
    // the same rule the nudge tie follows: ambiguity must not be what
    // opens the gate.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      prReviews: { 1: [review()] },
      graphqlResponses: [repoPRs([prNode({ reactions: page([thumbs()]) })])],
    });
    const out = await runFull(fake);
    expect(out.written[0].description).toBe(FINDINGS);
  });

  it("honors a 👍 that arrived before the sweep's own first status", async () => {
    // The delayed-first-sweep ordering: Codex approves before any `codex`
    // status exists, then the first write would date the head AFTER the 👍
    // and stale it forever. The freshness bound is the earliest status of
    // ANY context — a third party's (deploy, CI) lands seconds after the
    // push, before any genuine reaction can — so the 👍 stays fresh.
    const fake = fakeFetch({
      statuses: { abc1234: [
        gate("2026-08-14T12:00:00Z"),
        { context: "Vercel", state: "success", created_at: "2026-08-14T11:58:00Z" },
      ] },
      checkSuites: { abc1234: [{ created_at: "2026-08-14T11:58:30Z", head_branch: "claude/topic" }] },
      graphqlResponses: [repoPRs([prNode({ reactions: page([thumbs(undefined, "2026-08-14T11:59:00Z")]) })])],
    });
    const out = await runFull(fake);
    expect(out.written[0].state).toBe("success");
    // A fresh-looking 👍 pays one suites call to confirm the head did not
    // arrive by fast-forward onto a pre-stamped commit — the branch-born
    // suite predates the 👍 here, so the approval holds.
    expect(fake.calls.some((c) => c.path.includes("/check-suites"))).toBe(true);
  });

  it("fails closed when a same-repo head has no suites at all yet", async () => {
    // A fast-forwarded head can carry old STATUSES and no suites — judged
    // in the gap before this workflow's own run creates the branch suite.
    // Old records being statuses rather than suites changes nothing: with
    // no branch-born suite the transition cannot be dated, and trusting
    // the status bound is the same fail-open hole.
    const fake = fakeFetch({
      statuses: { abc1234: [{ context: "Vercel", state: "success", created_at: "2026-08-10T09:00:00Z" }] },
      graphqlResponses: [repoPRs([prNode({
        reactions: page([thumbs(undefined, "2026-08-10T09:05:00Z")]),
      })])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(1);
    expect(out.written[0].state).toBe("pending");
  });

  it("hears a nudge edited into an old comment", async () => {
    // An owner can ask for a re-review by editing "@codex review" into an
    // existing comment; its created_at then predates the head or the
    // standing 👍 and the ask would be filtered out or read as answered.
    // The ask is dated by the later of creation and edit — erring toward
    // blocking on an owner's ask, the file's stated direction.
    const fake = fakeFetch({
      statuses: { abc1234: [
        gate("2026-08-14T12:00:00Z"),
        { context: "Vercel", state: "success", created_at: "2026-08-14T11:58:00Z" },
      ] },
      checkSuites: { abc1234: [{ created_at: "2026-08-14T11:58:30Z", head_branch: "claude/topic" }] },
      issueComments: { 1: [{
        user: { login: OWNER },
        created_at: "2026-08-13T09:00:00Z",
        updated_at: "2026-08-14T12:30:00Z",
        body: "@codex review",
      }] },
      graphqlResponses: [repoPRs([prNode({ reactions: page([thumbs(undefined, "2026-08-14T12:15:00Z")]) })])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(1);
    // The head already carries `pending`; the point is that the edited-in
    // ask keeps the 👍 from flipping it to success.
    expect(out.written).toEqual([]);
  });

  it("ignores a previous life's records on a recycled head", async () => {
    // A force-push can move the PR onto a commit that already existed —
    // whose statuses, suites, and even a 👍 date from its first life. The
    // birth bound is floored at the force-push event (server-stamped), so
    // nothing from before the commit became THIS PR's head can approve it.
    const era = "2026-08-10T09:00:00Z";
    const fake = fakeFetch({
      statuses: { abc1234: [{ context: "Vercel", state: "success", created_at: era }] },
      checkSuites: { abc1234: [{ created_at: era, head_branch: "claude/topic" }] },
      graphqlResponses: [repoPRs([prNode({
        forcePushes: { nodes: [{ createdAt: "2026-08-14T12:00:00Z" }] },
        reactions: page([thumbs(undefined, "2026-08-10T09:05:00Z")]),
      })])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(1);
    expect(out.written[0].state).toBe("pending");
  });

  it("asks GitHub for the retarget event, not only the force-push", async () => {
    // THE assertion for the retarget hole, and it has to be made against the
    // query rather than a fixture. A retarget moves nothing else — head SHA,
    // statuses and check suites all stand still — so the only thing that can
    // reveal it is a BaseRefChangedEvent in the timeline, and the stub here
    // does not model GitHub's own `itemTypes` filtering: a fixture timeline
    // node is returned whatever the query asked for. So the two behavior
    // tests below would pass against the pre-fix query too. This one cannot.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      graphqlResponses: [repoPRs([prNode({})])],
    });
    await runFull(fake);
    const query = fake.calls.find((c) => c.path === "/graphql")?.body?.query;
    // Assert the query was found before asserting anything about it: a
    // `toContain` against undefined would throw, but a future refactor
    // could leave this reading an empty string and passing vacuously.
    expect(typeof query).toBe("string");
    expect(query).toContain("BASE_REF_CHANGED_EVENT");
    expect(query).toContain("... on BaseRefChangedEvent");
    // The force-push floor is not replaced by it — both are floors, and the
    // query takes `last:1` over both types, which is their maximum.
    expect(query).toContain("HEAD_REF_FORCE_PUSHED_EVENT");
  });

  it("revokes a standing 👍 dated before the newest timeline floor", async () => {
    // What the retarget event buys once it is in the timeline: a 👍 older
    // than it reads stale, so a base change cannot leave `codex: success`
    // standing over a diff nothing has read. The head already carries
    // `pending`, so the assertion is that nothing flipped it to success --
    // which is what the pre-fix code did with the same fixture.
    const fake = fakeFetch({
      statuses: { abc1234: [gate("2026-08-14T11:50:00Z")] },
      checkSuites: { abc1234: [bornSuite("2026-08-14T11:49:00Z")] },
      graphqlResponses: [repoPRs([prNode({
        updatedAt: "2026-08-14T12:01:00Z",
        // The retarget, AFTER the 👍 below.
        retargets: { nodes: [{ createdAt: "2026-08-14T12:00:00Z" }] },
        reactions: page([thumbs(undefined, "2026-08-14T11:55:00Z")]),
      })])],
    });
    const out = await runFull(fake);
    expect(out.written).toEqual([]);
    expect(out.awaiting).toBe(1);
  });

  it("does not let a pre-retarget review settle the head", async () => {
    // A review record is tied to the head by its commit id, which is enough
    // while the head is the only thing that moves — but a retarget changes
    // the diff underneath an unchanged head, so the old review still
    // matches. Counting it holds the gate closed (safe) while marking the
    // head ANSWERED, which drops it off the minute loop; the clean 👍 that
    // follows a re-review emits no webhook, so the gate would then sit
    // pending until the hourly sweep. Awaiting must stay 1.
    const fake = fakeFetch({
      statuses: { abc1234: [gate("2026-08-14T11:50:00Z")] },
      checkSuites: { abc1234: [bornSuite("2026-08-14T11:49:00Z")] },
      prReviews: { 1: [review("abc1234", undefined, "2026-08-14T11:55:00Z")] },
      graphqlResponses: [repoPRs([prNode({
        updatedAt: "2026-08-14T12:01:00Z",
        retargets: { nodes: [{ createdAt: "2026-08-14T12:00:00Z" }] },
      })])],
    });
    const out = await runFull(fake);
    expect(out.written).toEqual([]);
    expect(out.awaiting).toBe(1);
  });

  it("treats a review tied with the retarget second as stale", async () => {
    // GitHub stamps to the second, so a review submitted in the same second
    // as the base change has no established order against it. The reaction
    // and comment paths already resolve that ambiguity toward stale; this
    // asserts the review path does too, rather than settling the head on a
    // tie and stopping the loop.
    const fake = fakeFetch({
      statuses: { abc1234: [gate("2026-08-14T11:50:00Z")] },
      checkSuites: { abc1234: [bornSuite("2026-08-14T11:49:00Z")] },
      prReviews: { 1: [review("abc1234", undefined, "2026-08-14T12:00:00Z")] },
      graphqlResponses: [repoPRs([prNode({
        updatedAt: "2026-08-14T12:01:00Z",
        retargets: { nodes: [{ createdAt: "2026-08-14T12:00:00Z" }] },
      })])],
    });
    const out = await runFull(fake);
    expect(out.written).toEqual([]);
    expect(out.awaiting).toBe(1);
  });

  it("keeps approving when the 👍 postdates the timeline floor", async () => {
    // The other direction, so the guard above cannot be satisfied by a rule
    // that simply refuses every pull request carrying one of these events:
    // Codex re-reading AFTER the retarget is the verdict we want honored.
    const fake = fakeFetch({
      statuses: { abc1234: [gate("2026-08-14T11:50:00Z")] },
      checkSuites: { abc1234: [bornSuite("2026-08-14T11:49:00Z")] },
      graphqlResponses: [repoPRs([prNode({
        updatedAt: "2026-08-14T12:04:00Z",
        retargets: { nodes: [{ createdAt: "2026-08-14T12:00:00Z" }] },
        // Codex re-read after the retarget.
        reactions: page([thumbs(undefined, "2026-08-14T12:03:00Z")]),
      })])],
    });
    const out = await runFull(fake);
    expect(out.written[0].state).toBe("success");
  });

  it("rescues a 👍 dated too late only by a slow external status", async () => {
    // The gap the all-statuses-ours gate left open: a deploy status landing
    // AFTER the 👍 suppressed the suite lookup while still dating the head
    // too late. The lookup now runs whenever a Codex 👍 was rejected purely
    // for freshness — the one case an earlier bound could change the answer.
    const fake = fakeFetch({
      statuses: { abc1234: [
        gate("2026-08-14T12:00:00Z"),
        { context: "Vercel", state: "success", created_at: "2026-08-14T12:10:00Z" },
      ] },
      checkSuites: { abc1234: [{ created_at: "2026-08-14T11:58:00Z", head_branch: "claude/topic" }] },
      graphqlResponses: [repoPRs([prNode({ reactions: page([thumbs(undefined, "2026-08-14T11:59:00Z")]) })])],
    });
    const out = await runFull(fake);
    expect(out.written[0].state).toBe("success");
  });

  it("rejects a lingering 👍 when the head arrived by fast-forward", async () => {
    // A fast-forward onto a pre-existing commit — a stacked branch
    // graduating — leaves NO force-push event, and the commit's old
    // statuses and suites predate the previous head's 👍, which Codex has
    // not yet revoked. The suite born on this PR's own branch is the only
    // server-stamped record of the transition; a 👍 older than it belongs
    // to a head nobody is looking at anymore.
    const era = "2026-08-10T09:00:00Z";
    const fake = fakeFetch({
      statuses: { abc1234: [{ context: "Vercel", state: "success", created_at: era }] },
      checkSuites: { abc1234: [
        { created_at: era, head_branch: "stack/upper" },
        { created_at: "2026-08-14T12:00:00Z", head_branch: "claude/topic" },
      ] },
      graphqlResponses: [repoPRs([prNode({
        reactions: page([thumbs(undefined, "2026-08-10T09:05:00Z")]),
      })])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(1);
    expect(out.written[0].state).toBe("pending");
  });

  it("fails closed when a same-repo head's suites name only other branches", async () => {
    // The gap before the fast-forwarded head's first branch suite exists:
    // old foreign-branch suites prove the commit predates its arrival here,
    // and nothing yet dates the arrival. Trusting the status bound in that
    // window is exactly the fast-forward hole, so the head waits the sweep
    // out — CI runs on every same-repo push, so the dating suite is seconds
    // away.
    const era = "2026-08-10T09:00:00Z";
    const fake = fakeFetch({
      statuses: { abc1234: [{ context: "Vercel", state: "success", created_at: era }] },
      checkSuites: { abc1234: [{ created_at: era, head_branch: "stack/upper" }] },
      graphqlResponses: [repoPRs([prNode({
        reactions: page([thumbs(undefined, "2026-08-10T09:05:00Z")]),
      })])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(1);
    expect(out.written[0].state).toBe("pending");
  });

  it("fails closed for a fork head, whose suites never name a branch", async () => {
    // GitHub reports head_branch: null for suites on cross-repository
    // heads, so nothing ever dates a fork head's transition — and an
    // exemption that fell back to the status bound let a fast-forwarded
    // fork head inherit the previous head's 👍. Fork contributions merge
    // by admin override or a same-repo re-push; this gate stays closed.
    const fake = fakeFetch({
      statuses: { abc1234: [
        gate("2026-08-14T12:00:00Z"),
        { context: "Vercel", state: "success", created_at: "2026-08-14T11:58:00Z" },
      ] },
      checkSuites: { abc1234: [{ created_at: "2026-08-14T11:58:30Z", head_branch: null }] },
      graphqlResponses: [repoPRs([prNode({
        isCrossRepository: true,
        reactions: page([thumbs(undefined, "2026-08-14T11:59:00Z")]),
      })])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(1);
    expect(out.written).toEqual([]);
  });

  it("reopens the wait on a nudge tied with the 👍 to the second", async () => {
    // GitHub stamps to the second; a nudge in the same second as the
    // standing 👍 is an unresolved ordering, and ambiguity must not be
    // what leaves a success open for auto-merge.
    const fake = fakeFetch({
      statuses: { abc1234: [gate("2026-08-14T12:00:00Z")] },
      checkSuites: { abc1234: [bornSuite()] },
      issueComments: { 1: [{ user: { login: OWNER }, created_at: AFTER, body: "@codex review" }] },
      graphqlResponses: [repoPRs([prNode({ reactions: page([thumbs(undefined, AFTER)]) })])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(1);
    expect(out.written).toEqual([]);
  });

  it("re-anchors a would-park head on its branch-born suite", async () => {
    // A fast-forward can land a head already wearing an identical old
    // PENDING: no reaction, so the suites were never read; no write, so
    // nothing refreshed the anchor — and the head would park on its first
    // sweep, before Codex's pickup window opens. The would-park path pays
    // one suites call and finds the arrival's own record.
    const at = (suiteAt, t) => sweep({
      owner: OWNER, name: "r", token: "t",
      fetchImpl: fakeFetch({
        statuses: { abc1234: [gate("2026-08-14T11:40:00Z")] },
        checkSuites: { abc1234: [{ created_at: suiteAt, head_branch: "claude/topic" }] },
        graphqlResponses: [repoPRs([prNode()])],
      }).impl,
      log: () => {}, now: () => Date.parse(t),
    });
    // The suite says the head arrived two minutes ago: keep the clock.
    expect((await at("2026-08-14T12:24:00Z", "2026-08-14T12:26:00Z")).awaiting).toBe(1);
    // An old suite corroborates the old marker: park.
    expect((await at("2026-08-14T11:39:00Z", "2026-08-14T12:26:00Z")).awaiting).toBe(0);
  });

  it("keeps the rescue from lowering the bound past the branch-born suite", async () => {
    // The rescue exists to lower a too-late bound with an earlier birth
    // record — but on a fast-forwarded head the earlier records belong to
    // the commit's previous life. Floored at the branch-born suite, the
    // rescue can no longer revive the previous head's 👍 through the side
    // door the confirm path just closed.
    const fake = fakeFetch({
      statuses: { abc1234: [gate("2026-08-14T12:00:00Z")] },
      checkSuites: { abc1234: [
        { created_at: "2026-08-14T11:50:00Z", head_branch: "stack/upper" },
        { created_at: "2026-08-14T12:05:00Z", head_branch: "claude/topic" },
      ] },
      graphqlResponses: [repoPRs([prNode({
        reactions: page([thumbs(undefined, "2026-08-14T11:59:00Z")]),
      })])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(1);
    // The head already carries `pending`; the point is that no success
    // replaces it.
    expect(out.written).toEqual([]);
  });

  it("dates the head by its check suites when no one writes statuses", async () => {
    // A repo whose CI reports check runs, not commit statuses: with only
    // our own writes on the head, the bound would rest on the very marker a
    // delayed first sweep writes too late — the self-poisoning shape. Check
    // suites are created at push, server-stamped, so a 👍 that beat our
    // first write still approves.
    const fake = fakeFetch({
      statuses: { abc1234: [gate("2026-08-14T12:00:00Z")] },
      checkSuites: { abc1234: [{ created_at: "2026-08-14T11:58:00Z", head_branch: "claude/topic" }] },
      graphqlResponses: [repoPRs([prNode({ reactions: page([thumbs(undefined, "2026-08-14T11:59:00Z")]) })])],
    });
    const out = await runFull(fake);
    expect(out.written[0].state).toBe("success");
  });

  it("hears a nudge hidden behind a future-dated commit", async () => {
    // The commit date is author-controlled; forged past the owner's
    // "@codex review" it would filter the nudge out of the walk, and on an
    // approved head that fails OPEN — a stale success left for auto-merge.
    // The walk bound is the EARLIER of the commit date and the head's first
    // server-stamped status, so the forged date only ever loses.
    const future = { nodes: [{ commit: { committedDate: "2026-08-14T13:00:00Z" } }] };
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      issueComments: { 1: [{ user: { login: OWNER }, created_at: "2026-08-14T12:10:00Z", body: "@codex review" }] },
      graphqlResponses: [repoPRs([prNode({ commits: future, reactions: page([thumbs()]) })])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(1);
    expect(out.written).toEqual([]);
  });

  it("keeps the clock running while an owner nudge awaits Codex's answer", async () => {
    // A nudge newer than Codex's last word means the answer is due again —
    // the head counts as awaiting on EVERY sweep, however the run was
    // started. This is what makes the nudge race immune to queue
    // replacement: no trigger-level grace has to survive anything.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      prReviews: { 1: [review()] },
      issueComments: { 1: [{ user: { login: OWNER }, created_at: "2026-08-14T12:10:00Z", body: "@codex review" }] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(1);
    // PENDING, not FINDINGS — the marker already says PENDING, so no write.
    expect(out.written).toEqual([]);
  });

  it("settles again once Codex answers the nudge", async () => {
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      prReviews: { 1: [review()] },
      issueComments: { 1: [
        { user: { login: OWNER }, created_at: "2026-08-14T12:10:00Z", body: "@codex review" },
        { user: { login: `${CODEX_BOT}[bot]` }, created_at: "2026-08-14T12:15:00Z", body: "still the same finding" },
      ] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(0);
    expect(out.written[0].description).toBe(FINDINGS);
  });

  it("hears a nudge typed as an inline review-thread reply", async () => {
    // The rebuttal-plus-nudge round most naturally happens ON the finding's
    // thread, which is the pulls comment stream, not the issues one — and
    // the sweep is the sole source of nudge state, so missing that stream
    // would settle FINDINGS over a nudge that was plainly made.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      prReviews: { 1: [review()] },
      reviewThreadComments: { 1: [{ user: { login: OWNER }, created_at: "2026-08-14T12:10:00Z", body: "not a real issue — @codex review" }] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    expect((await runFull(fake)).awaiting).toBe(1);
  });

  it("keeps the clock running when the findings belong to a previous head", async () => {
    // The review's own commit id is the staleness guard: a push moves the
    // head oid and every earlier review stops matching, so a fresh head with
    // an old review is simply awaiting a verdict again.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      prReviews: { 1: [review("oldhead")] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(1);
    expect(out.written).toEqual([]);
  });

  it("keeps the clock running through a re-read of a head with findings", async () => {
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      prReviews: { 1: [review()] },
      graphqlResponses: [repoPRs([
        prNode({ reactions: page([hold("EYES", `${CODEX_BOT}[bot]`)]) }),
      ])],
    });
    expect((await runFull(fake)).awaiting).toBe(1);
  });

  it("holds on the owner's 👀 without keeping the fast clock running", async () => {
    // The owner's 👀 is a deliberate hold: `failure`, cleared only by human
    // action, which the throttled schedule notices on its own.
    const fake = fakeFetch({
      graphqlResponses: [repoPRs([
        prNode({ reactions: page([hold("EYES")]) }),
      ])],
    });
    const out = await runFull(fake);
    expect(out.written[0].state).toBe("failure");
    expect(out.awaiting).toBe(0);
  });

  it("refuses two open PRs sharing a head, and asks nothing further", async () => {
    const fake = fakeFetch({
      graphqlResponses: [
        repoPRs([prNode({ number: 1, reactions: page([thumbs()]) }), prNode({ number: 2 })]),
      ],
    });
    const out = await run(fake);
    expect(out.map((w) => w.state)).toEqual(["failure", "failure"]);
    // The set settled it, so no reaction lookup was needed.
    expect(fake.calls.filter((c) => c.path === "/graphql")).toHaveLength(1);
  });

  it("still judges PRs whose heads are distinct", async () => {
    const fake = fakeFetch({
      // bbb has no marker yet, so its first gating is this sweep.
      statuses: { aaa: [gate()] },
      checkSuites: { aaa: [bornSuite()] },
      graphqlResponses: [
        repoPRs([
          prNode({ number: 1, headRefOid: "aaa", reactions: page([thumbs()]) }),
          prNode({ number: 2, headRefOid: "bbb" }),
        ]),
      ],
    });
    expect((await run(fake)).map((w) => w.state)).toEqual(["success", "pending"]);
  });

  it("follows pull-request pages", async () => {
    const fake = fakeFetch({
      graphqlResponses: [
        repoPRs([prNode({ number: 1 })], true, "prCursor"),
        repoPRs([prNode({ number: 2, headRefOid: "def5678" })]),
      ],
    });
    expect((await run(fake)).map((w) => w.number)).toEqual([1, 2]);
  });

  it("surfaces a GraphQL error instead of publishing anything", async () => {
    const fake = fakeFetch({ statuses: { abc1234: [gate()] }, graphqlResponses: [{ errors: [{ message: "bad query" }] }] });
    await expect(run(fake)).rejects.toThrow(/bad query/);
    expect(fake.calls.some((c) => c.path.includes("/statuses/"))).toBe(false);
  });

  it("contains a failed status write instead of going red", async () => {
    // The canonical case: a 422 moments after a force-push, before the new
    // SHA replicates. A run that died here went red — which notifies the
    // owner every time — for something the next sweep repairs by itself.
    // The head counts as awaiting, so the minute loop IS the retry; the
    // log names the call and its code, never the token or the body.
    const lines = [];
    const fake = fakeFetch({ graphqlResponses: [repoPRs([prNode()])], failStatusWrite: true });
    const out = await sweep({
      owner: OWNER, name: "r", token: "t", fetchImpl: fake.impl, log: (l) => lines.push(l),
    });
    expect(out.awaiting).toBe(1);
    expect(out.written).toEqual([]);
    // Contained is not forgiven: the head is reported so runLoop can turn a
    // persistent streak into a red run.
    expect(out.failed).toEqual([1]);
    expect(lines.join("\n")).toMatch(/#1: sweep failed \(POST \/repos\/o\/r\/statuses\/abc1234 failed: 422\)/);
  });

  it("still judges the other heads after one head's failure", async () => {
    const fake = fakeFetch({
      graphqlResponses: [repoPRs([
        prNode({ number: 1, headRefOid: "aaa" }),
        prNode({ number: 2, headRefOid: "bbb" }),
      ])],
      failStatusWrite: true,
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(2);
    expect(out.failed).toEqual([1, 2]);
    // Both writes were attempted — the first failure did not end the loop.
    const posts = fake.calls.filter((c) => c.method === "POST" && c.path.includes("/statuses/"));
    expect(posts.map((c) => c.path)).toEqual([
      "/repos/o/r/statuses/aaa",
      "/repos/o/r/statuses/bbb",
    ]);
  });

  it("fails the status closed and goes red once a head stays unreadable", async () => {
    // Branch protection consumes the STATUS, not this job's color: an
    // approved head whose reads then start failing may be carrying a
    // success earned before a hold or re-review request landed, and a red
    // run alone leaves that gate open. At the streak threshold the sweep
    // writes UNREADABLE pending over the head — the write path here is
    // alive even though the reads are not — and then throws.
    const streaks = new Map();
    const runOnce = () => {
      const fake = fakeFetch({
        statuses: { abc1234: [gate()] },
        graphqlResponses: [repoPRs([prNode({ reactions: page([thumbs()]) })])],
        failComments: true,
      });
      return { fake, run: sweep({ owner: OWNER, name: "r", token: "t", fetchImpl: fake.impl, log: () => {}, streaks }) };
    };
    for (let i = 1; i < MAX_FAIL_STREAK; i += 1) {
      const { run } = runOnce();
      const out = await run;
      expect(out.failed).toEqual([1]);
    }
    const { fake, run } = runOnce();
    await expect(run).rejects.toThrow(/#1: still failing after 5 consecutive sweeps/);
    const post = fake.calls.find((c) => c.method === "POST" && c.path.includes("/statuses/"));
    expect(post.body).toMatchObject({ context: CONTEXT, state: "pending", description: UNREADABLE });
  });

  it("still goes red when the fail-closed write fails too", async () => {
    // Nothing fresh was being published through a broken write path, so
    // there is no stale success to invalidate — the red run is all that is
    // left to say, and it must still be said.
    const streaks = new Map();
    const runOnce = () => {
      const fake = fakeFetch({ graphqlResponses: [repoPRs([prNode()])], failStatusWrite: true });
      return sweep({ owner: OWNER, name: "r", token: "t", fetchImpl: fake.impl, log: () => {}, streaks });
    };
    for (let i = 1; i < MAX_FAIL_STREAK; i += 1) await runOnce();
    await expect(runOnce()).rejects.toThrow(/#1: still failing after 5 consecutive sweeps/);
  });

  it("forgives a failure streak that ends", async () => {
    const streaks = new Map();
    const failing = fakeFetch({ graphqlResponses: [repoPRs([prNode()])], failStatusWrite: true });
    await sweep({ owner: OWNER, name: "r", token: "t", fetchImpl: failing.impl, log: () => {}, streaks });
    expect(streaks.get("1:abc1234")).toBe(1);
    const healthy = fakeFetch({ graphqlResponses: [repoPRs([prNode()])] });
    await sweep({ owner: OWNER, name: "r", token: "t", fetchImpl: healthy.impl, log: () => {}, streaks });
    expect(streaks.has("1:abc1234")).toBe(false);
  });

  it("resets the failure streak when the head changes", async () => {
    // A force-push right at the threshold: the expected transient 422 on
    // the brand-new SHA must not be read as the old head's fifth
    // consecutive failure — the streak is keyed by head, not PR number.
    const streaks = new Map();
    const failOnce = (sha) => {
      const fake = fakeFetch({
        graphqlResponses: [repoPRs([prNode({ headRefOid: sha })])],
        failStatusWrite: true,
      });
      return sweep({ owner: OWNER, name: "r", token: "t", fetchImpl: fake.impl, log: () => {}, streaks });
    };
    for (let i = 1; i < MAX_FAIL_STREAK; i += 1) await failOnce("abc1234");
    const out = await failOnce("def5678");
    expect(out.failed).toEqual([1]);
    expect(streaks.get("1:def5678")).toBe(1);
  });

  it("revisits settled heads on the slow cadence, awaiting heads every sweep", async () => {
    // The REST budget holding: a settled head costs several calls to judge,
    // and rescanning every settled PR each minute is what would blow the
    // 1,000/hour token ceiling. Awaiting heads and new SHAs stay on the
    // minute clock; a fresh event run starts with an empty cadence map, so
    // human actions that emit webhooks are still seen in seconds.
    const cadence = new Map();
    const settledSweep = (revisitEvery = 5) => {
      const fake = fakeFetch({
        statuses: { abc1234: [gate()] },
        prReviews: { 1: [review()] },
        graphqlResponses: [repoPRs([prNode()])],
      });
      return sweep({
        owner: OWNER, name: "r", token: "t", fetchImpl: fake.impl, log: () => {}, cadence, revisitEvery,
      }).then((out) => ({ out, fake }));
    };
    // First sweep judges and settles (review findings → awaiting 0).
    const first = await settledSweep();
    expect(first.out.awaiting).toBe(0);
    expect(first.fake.calls.some((c) => c.path.includes("/statuses/"))).toBe(true);
    // Sweeps 2–5 skip the head entirely: no status reads, no walks.
    for (let i = 0; i < 4; i += 1) {
      const skipped = await settledSweep();
      expect(skipped.fake.calls.filter((c) => c.path.includes("/statuses/"))).toEqual([]);
      expect(skipped.out.awaiting).toBe(0);
    }
    // Sweep 6 is the revisit: the head is read again.
    const revisit = await settledSweep();
    expect(revisit.fake.calls.some((c) => c.path.includes("/statuses/"))).toBe(true);
    // A new head on the same PR is judged immediately, cadence or not.
    const moved = fakeFetch({
      graphqlResponses: [repoPRs([prNode({ headRefOid: "def5678" })])],
    });
    await sweep({ owner: OWNER, name: "r", token: "t", fetchImpl: moved.impl, log: () => {}, cadence });
    expect(moved.calls.some((c) => c.path.includes("/statuses/def5678"))).toBe(true);
  });

  it("rejudges a survivor the moment its duplicate closes", async () => {
    // Shared-head membership is topology on OTHER PRs: the duplicate
    // closing changes this head's verdict while its own SHA and updatedAt
    // stand still, and the closed-event successor only queues behind the
    // active run — so the active loop must notice the flip itself.
    const cadence = new Map();
    const both = fakeFetch({
      graphqlResponses: [repoPRs([
        prNode(),
        prNode({ number: 2, headRefName: "claude/other" }),
      ])],
    });
    const first = await sweep({
      owner: OWNER, name: "r", token: "t", fetchImpl: both.impl, log: () => {}, cadence,
    });
    expect(first.written.map((w) => w.state)).toEqual(["failure", "failure"]);
    // Same survivor, same SHA, same updatedAt — but the duplicate is gone,
    // and the very next sweep must rejudge rather than sit on the failure.
    const alone = fakeFetch({
      statuses: { abc1234: [] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const second = await sweep({
      owner: OWNER, name: "r", token: "t", fetchImpl: alone.impl, log: () => {}, cadence,
    });
    expect(second.written.map((w) => w.state)).toEqual(["pending"]);
  });

  it("keeps the rewound head's 👍 from approving a fast-forward return", async () => {
    // Rewind to an ancestor (a force-push, leaving the event), earn a 👍
    // there, fast-forward BACK to the original SHA: the return leaves no
    // event, and the SHA's branch-born suite from its first tenure would
    // date the arrival too early. Suites before the last force-push belong
    // to a previous life, so the floor leaves only the re-arrival's fresh
    // suite — which the rewound head's 👍 predates.
    const fake = fakeFetch({
      statuses: { abc1234: [{ context: "Vercel", state: "success", created_at: "2026-08-14T10:05:00Z" }] },
      checkSuites: { abc1234: [
        { created_at: "2026-08-14T10:00:00Z", head_branch: "claude/topic" },
        { created_at: "2026-08-14T12:20:00Z", head_branch: "claude/topic" },
      ] },
      graphqlResponses: [repoPRs([prNode({
        forcePushes: { nodes: [{ createdAt: "2026-08-14T12:00:00Z" }] },
        reactions: page([thumbs(undefined, "2026-08-14T12:10:00Z")]),
      })])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(1);
    expect(out.written[0].state).toBe("pending");
  });

  it("publishes wording that names the failure and its remedy", () => {
    // Every other test here compares production output back to the constant
    // it imported, which proves the code writes the marker but says nothing
    // about what the marker SAYS -- reword the constant and they all still
    // pass (Codex, PR #37). That hole matters more here than it would
    // anywhere else in this file: the description is not an internal token
    // but an instruction, published to every consumer's merge gate and read
    // by a person deciding what to do. So the text is pinned, and a reword
    // is a deliberate edit rather than something that slides through.
    expect(UNANSWERED).toBe("Codex has not answered this head — comment @codex review");
    // The two properties that make it work, stated separately so a future
    // reword knows what it has to keep. The remedy has to be copy-pasteable
    // rather than paraphrased...
    expect(UNANSWERED).toContain("@codex review");
    // ...and it has to survive the trip: GitHub truncates a commit-status
    // description at 140 characters, and a truncated instruction is a
    // broken one.
    expect(UNANSWERED.length).toBeLessThan(141);
  });

  it("publishes a fork remedy that a fork maintainer can actually take", () => {
    // Same reasoning, and it matters more here: this wording exists
    // precisely because the other one names an impossible action on a fork
    // head, so a reword that lost the remedy would restore the bug it was
    // added to fix.
    expect(UNANSWERED_FORK).toBe(
      "A fork head\u0027s 👍 cannot be accepted — comment @codex review, or merge by admin override",
    );
    // It keeps the ordinary remedy, which the first version of this wording
    // wrongly dropped (Codex, PR #37): only the REACTION channel is closed
    // on a fork. `cleanlyApproved` is `approvedIsLatest || cleanIsLatest`,
    // and `cleanIsLatest` never consults `checkSuiteBirths` — so a clean
    // comment naming this SHA approves a fork head exactly as it would any
    // other, and a re-review can genuinely settle it.
    expect(UNANSWERED_FORK).toContain("@codex review");
    // ...and it keeps the fallback for when Codex answers with the 👍 alone,
    // which is the case that cannot be accepted here.
    expect(UNANSWERED_FORK).toContain("admin override");
    // The claim it must NOT make is the absolute one: an over-claim here
    // sends a maintainer to an admin override past a remedy that works.
    expect(UNANSWERED_FORK).not.toMatch(/cannot approve/);
    expect(UNANSWERED_FORK.length).toBeLessThan(141);
  });

  it("parks an unanswered head after UNANSWERED_MINUTES", async () => {
    // Codex answers within minutes of the event that woke it or it never
    // started — a forgotten PR with no verdict must not keep every loop
    // alive to its cap forever. The head still gates pending; only the
    // clock lets go, and a nudge or push (both events) is the retry.
    const at = (t) => sweep({
      owner: OWNER, name: "r", token: "t",
      fetchImpl: fakeFetch({
        statuses: { abc1234: [gate("2026-08-14T12:00:00Z")] },
        graphqlResponses: [repoPRs([prNode()])],
      }).impl,
      log: () => {}, now: () => Date.parse(t),
    });
    // Inside the window the head keeps the fast clock…
    expect((await at("2026-08-14T12:29:00Z")).awaiting).toBe(1);
    // …and past it the loop parks.
    const parked = await at("2026-08-14T12:31:00Z");
    expect(parked.awaiting).toBe(0);
    // And it SAYS so — the exported `UNANSWERED` description — rather than
    // parking silently. This used to assert
    // nothing was written, which left `PENDING` standing on the one head
    // that needs a person -- spelled identically to a review still in
    // flight. The status is the only channel that costs nothing: the sweep
    // already holds `statuses: write` and is already this head's writer, so
    // no comment, assignment or new permission is involved.
    expect(parked.written).toEqual([
      { number: 1, state: "pending", description: UNANSWERED },
    ]);
  });

  it("tells a fork head the remedy that actually works", async () => {
    // Codex, PR #37. A fork head is undatable forever -- GitHub reports no
    // `head_branch` for its suites -- so `judge` refuses its 👍 by design,
    // and the ordinary marker would tell the maintainer to ask for a review
    // whose clean answer is rejected identically. Publishing an instruction
    // that provably cannot work is worse than the silence this change
    // replaced, so the fork case names the remedy the code already
    // documents: an admin override, or a re-push to a branch in this repo.
    const parked = await sweep({
      owner: OWNER, name: "r", token: "t",
      fetchImpl: fakeFetch({
        statuses: { abc1234: [gate("2026-08-14T12:00:00Z")] },
        graphqlResponses: [repoPRs([prNode({ isCrossRepository: true })])],
      }).impl,
      log: () => {}, now: () => Date.parse("2026-08-14T12:31:00Z"),
    });
    expect(parked.awaiting).toBe(0);
    expect(parked.written).toEqual([
      { number: 1, state: "pending", description: UNANSWERED_FORK },
    ]);
  });

  it("says the fork remedy exactly once, like any other marker", async () => {
    // The stickiness reads the marker back off the head, so it has to
    // recognize BOTH wordings -- a fork head that re-escalated every sweep
    // would walk its gate marker forward exactly as the same-repo one would.
    const parked = await sweep({
      owner: OWNER, name: "r", token: "t",
      fetchImpl: fakeFetch({
        statuses: { abc1234: [
          gate("2026-08-14T12:30:00Z", "pending", UNANSWERED_FORK),
          gate("2026-08-14T11:00:00Z"),
        ] },
        graphqlResponses: [repoPRs([prNode({ isCrossRepository: true })])],
      }).impl,
      log: () => {}, now: () => Date.parse("2026-08-14T12:31:00Z"),
    });
    expect(parked.awaiting).toBe(0);
    expect(parked.written).toEqual([]);
  });

  it("re-words an inherited marker for the head it is now on", async () => {
    // Codex, PR #37. Making the ESCALATION topology-aware was half the job:
    // the sticky read replayed whatever the commit already wore, so a SHA
    // parked in a same-repo pull request and later reused as a fork head
    // kept advertising `@codex review` -- the instruction that provably
    // cannot work there, arriving by inheritance instead of by escalation.
    // The marker is a function of the head's topology, never of what a
    // previous life wrote, so it is recomputed rather than replayed.
    const asFork = await sweep({
      owner: OWNER, name: "r", token: "t",
      fetchImpl: fakeFetch({
        statuses: { abc1234: [gate("2026-08-14T11:00:00Z", "pending", UNANSWERED)] },
        graphqlResponses: [repoPRs([prNode({ isCrossRepository: true })])],
      }).impl,
      log: () => {}, now: () => Date.parse("2026-08-14T12:31:00Z"),
    });
    expect(asFork.written).toEqual([
      { number: 1, state: "pending", description: UNANSWERED_FORK },
    ]);
    // And the other direction: the owner re-pushes a fork contribution to a
    // branch here, so `@codex review` starts working and the admin-override
    // wording stops being the remedy.
    const asOwn = await sweep({
      owner: OWNER, name: "r", token: "t",
      fetchImpl: fakeFetch({
        statuses: { abc1234: [gate("2026-08-14T11:00:00Z", "pending", UNANSWERED_FORK)] },
        graphqlResponses: [repoPRs([prNode()])],
      }).impl,
      log: () => {}, now: () => Date.parse("2026-08-14T12:31:00Z"),
    });
    expect(asOwn.written).toEqual([
      { number: 1, state: "pending", description: UNANSWERED },
    ]);
  });

  it("clears an inherited fork marker on a fresh window too", async () => {
    // The clear means "we are still polling, so take the marker back", and
    // that is true of BOTH wordings -- a fork head force-pushed back onto a
    // parked commit is as much a fresh arrival as any other. Pinned because
    // the probe found this the one place the fork marker was not yet
    // recognized: a clear that only knew the same-repo sentence left a fork
    // head advertising a remedy while the window it was given was still
    // running.
    const moved = await sweep({
      owner: OWNER, name: "r", token: "t",
      fetchImpl: fakeFetch({
        statuses: { abc1234: [gate("2026-08-14T11:00:00Z", "pending", UNANSWERED_FORK)] },
        graphqlResponses: [repoPRs([prNode({
          isCrossRepository: true,
          forcePushes: { nodes: [{ createdAt: "2026-08-14T12:30:00Z" }] },
        })])],
      }).impl,
      log: () => {}, now: () => Date.parse("2026-08-14T12:31:00Z"),
    });
    expect(moved.awaiting).toBe(1);
    expect(moved.written).toEqual([
      { number: 1, state: "pending", description: PENDING },
    ]);
  });

  it("parks a comment-only finding without calling it unanswered", async () => {
    // Codex, PR #37. The FINDINGS fast-exit above needs `reviewedAt`, so a
    // finding left as a bare COMMENT — no submitted review — falls through
    // to the age path with FINDINGS standing. Escalating there would be
    // false (Codex answered) and, worse, unstable: `findings` outranks
    // `unanswered` in `verdictFor`, so the next sweep writes FINDINGS back,
    // that change re-anchors the age, and the head flaps between the two
    // every UNANSWERED_MINUTES forever — walking its gate marker forward
    // each time, which is the failure the stickiness exists to prevent.
    const parked = await sweep({
      owner: OWNER, name: "r", token: "t",
      fetchImpl: fakeFetch({
        statuses: { abc1234: [gate("2026-08-14T12:00:00Z", "pending", FINDINGS)] },
        issueComments: { 1: [{ user: { login: `${CODEX_BOT}[bot]` }, created_at: AFTER }] },
        graphqlResponses: [repoPRs([prNode()])],
      }).impl,
      log: () => {}, now: () => Date.parse("2026-08-14T12:31:00Z"),
    });
    // The clock still lets go — that half is right and unchanged.
    expect(parked.awaiting).toBe(0);
    // But nothing is rewritten: the head keeps the true, more specific word.
    expect(parked.written).toEqual([]);
  });

  it("parks an inherited marker on a recreated branch exactly as it parks PENDING", async () => {
    // Codex, PR #37: a branch name reused for the same SHA carries BOTH an
    // old status and an old branch-born suite, and with no force-push on
    // the new pull request there is no floor to exclude either -- so
    // `forBranch` picks the previous life's suite and the fresh arrival
    // parks at once.
    //
    // Real, and NOT introduced by the escalation: this asserts the two
    // descriptions behave identically, so the limitation belongs to the
    // arrival-dating machinery rather than to UNANSWERED. Fixing it means
    // changing what dates an arrival, which also guards the approval path
    // against a rewound head's 👍 -- a much larger blast radius than this
    // change, and tracked separately.
    const withStatus = (description) => sweep({
      owner: OWNER, name: "r", token: "t",
      fetchImpl: fakeFetch({
        statuses: { abc1234: [gate("2026-08-14T11:00:00Z", "pending", description)] },
        checkSuites: { abc1234: [bornSuite("2026-08-14T11:00:00Z"), bornSuite("2026-08-14T12:30:00Z")] },
        graphqlResponses: [repoPRs([prNode()])],
      }).impl,
      log: () => {}, now: () => Date.parse("2026-08-14T12:31:00Z"),
    });
    expect((await withStatus(PENDING)).awaiting).toBe(0);
    expect((await withStatus(UNANSWERED)).awaiting).toBe(0);
  });

  it("does not let its own escalation restart the window", async () => {
    // The age anchor is our last status write, and the escalation is a
    // write — so counting it resets the very window that produced it, and
    // the head polls another full one having already given up. The older
    // PENDING is the real anchor; the UNANSWERED on top of it reports the
    // wait rather than restarting it.
    const parked = await sweep({
      owner: OWNER, name: "r", token: "t",
      fetchImpl: fakeFetch({
        statuses: {
          abc1234: [
            gate("2026-08-14T12:30:00Z", "pending", UNANSWERED),
            gate("2026-08-14T11:00:00Z"),
          ],
        },
        graphqlResponses: [repoPRs([prNode()])],
      }).impl,
      log: () => {}, now: () => Date.parse("2026-08-14T12:31:00Z"),
    });
    expect(parked.awaiting).toBe(0);
    // Already said: the identical write is skipped, so the marker stays put.
    expect(parked.written).toEqual([]);
  });

  it("gives a reused commit its own window despite an inherited marker", async () => {
    // A status belongs to the COMMIT, so a commit that earned UNANSWERED
    // once — reused as another pull request's head, or fast-forwarded back
    // onto a branch — arrives already wearing it. Parking on sight would
    // deny the new arrival its pickup window before Codex has even been
    // asked, which is the failure the branch-born-suite re-anchor exists to
    // stop. The suite here is born a minute ago: the head is NEW, whatever
    // its inherited status says.
    const parked = await sweep({
      owner: OWNER, name: "r", token: "t",
      fetchImpl: fakeFetch({
        statuses: { abc1234: [gate("2026-08-14T11:00:00Z", "pending", UNANSWERED)] },
        checkSuites: { abc1234: [bornSuite("2026-08-14T12:30:00Z")] },
        graphqlResponses: [repoPRs([prNode()])],
      }).impl,
      log: () => {}, now: () => Date.parse("2026-08-14T12:31:00Z"),
    });
    expect(parked.awaiting).toBe(1);
    // And the inherited wording is CLEARED, not just ignored. This used to
    // assert nothing was written, which left the head telling the
    // maintainer to nudge for the whole fresh window while Codex was
    // queued normally -- a false instruction, published to every consumer
    // (Codex, PR #37). The sticky read in `verdictFor` cannot know better;
    // this path can, because the branch-born suite has just dated the
    // arrival, on a call this path already paid for.
    expect(parked.written).toEqual([
      { number: 1, state: "pending", description: PENDING },
    ]);
  });

  it("clears only the inherited marker, never a finding", async () => {
    // The clear is guarded on the wording for a reason: a comment-only
    // finding reaches this path too (the FINDINGS fast-exit needs
    // `reviewedAt`, which a bare comment has none of), and a fresh branch
    // suite would then rewrite its accurate FINDINGS to PENDING -- reopening
    // the gate's wording on a head Codex has actually answered. Only the
    // marker this loop wrote itself is safe to take back.
    const kept = await sweep({
      owner: OWNER, name: "r", token: "t",
      fetchImpl: fakeFetch({
        statuses: { abc1234: [gate("2026-08-14T11:00:00Z", "pending", FINDINGS)] },
        checkSuites: { abc1234: [bornSuite("2026-08-14T12:30:00Z")] },
        issueComments: { 1: [{ user: { login: `${CODEX_BOT}[bot]` }, created_at: AFTER }] },
        graphqlResponses: [repoPRs([prNode()])],
      }).impl,
      log: () => {}, now: () => Date.parse("2026-08-14T12:31:00Z"),
    });
    expect(kept.awaiting).toBe(1);
    expect(kept.written).toEqual([]);
  });

  it("clears an inherited marker on a force-push back onto the same SHA", async () => {
    // Codex, PR #37. `bound` includes `movedAt`, so a force-push away and
    // back to an already-parked commit makes the window fresh at the FIRST
    // age check -- above the branch-born re-anchor, where the clear used to
    // live alone. The head kept the clock (right) while still telling the
    // maintainer to nudge a review the synchronize event had just queued
    // (wrong). Polling and the marker are complements: any path that keeps
    // the clock has to take it back.
    const moved = await sweep({
      owner: OWNER, name: "r", token: "t",
      fetchImpl: fakeFetch({
        statuses: { abc1234: [gate("2026-08-14T11:00:00Z", "pending", UNANSWERED)] },
        graphqlResponses: [repoPRs([prNode({
          forcePushes: { nodes: [{ createdAt: "2026-08-14T12:30:00Z" }] },
        })])],
      }).impl,
      log: () => {}, now: () => Date.parse("2026-08-14T12:31:00Z"),
    });
    expect(moved.awaiting).toBe(1);
    expect(moved.written).toEqual([
      { number: 1, state: "pending", description: PENDING },
    ]);
  });

  it("clears an inherited marker once, not every sweep", async () => {
    // The other half of the clear above: having rewritten the head to
    // PENDING, the next sweep must find nothing to do. It does, and by two
    // independent routes -- the sticky read no longer fires, and the write
    // just made is this arrival's own age anchor, so the head is young and
    // never reaches the clearing path at all. Without both, clearing the
    // wording would trade one false instruction for a status rewritten
    // every sweep, which is what walks a gate marker forward.
    const again = await sweep({
      owner: OWNER, name: "r", token: "t",
      fetchImpl: fakeFetch({
        statuses: { abc1234: [
          gate("2026-08-14T12:30:30Z"),
          gate("2026-08-14T11:00:00Z", "pending", UNANSWERED),
        ] },
        checkSuites: { abc1234: [bornSuite("2026-08-14T12:30:00Z")] },
        graphqlResponses: [repoPRs([prNode()])],
      }).impl,
      log: () => {}, now: () => Date.parse("2026-08-14T12:31:00Z"),
    });
    expect(again.awaiting).toBe(1);
    expect(again.written).toEqual([]);
  });

  it("says the unanswered head is unanswered exactly once", async () => {
    // The age is anchored partly on our own last status write, so a naive
    // escalation resets that anchor: the next sweep finds the head young,
    // rewrites PENDING, and the two alternate forever -- rewriting the
    // head's status every sweep, which is what walks its gate marker
    // forward until no reaction can outrank it. Sticky instead: read back
    // off the head, and once said, say nothing more.
    const parked = await sweep({
      owner: OWNER, name: "r", token: "t",
      fetchImpl: fakeFetch({
        statuses: { abc1234: [gate("2026-08-14T12:00:00Z", "pending", UNANSWERED)] },
        graphqlResponses: [repoPRs([prNode()])],
      }).impl,
      log: () => {}, now: () => Date.parse("2026-08-14T12:31:00Z"),
    });
    expect(parked.awaiting).toBe(0);
    expect(parked.written).toEqual([]);
  });

  it("keeps a reading head on the clock past the window", async () => {
    // 👀 means the review genuinely started; the swap to 👍 emits no
    // webhook, so a parked reading head would strand the verdict on the
    // hourly schedule at the exact moment the next minute matters.
    const fake = fakeFetch({
      statuses: { abc1234: [gate("2026-08-14T12:00:00Z")] },
      graphqlResponses: [repoPRs([prNode({
        reactions: page([{ content: "EYES", createdAt: "2026-08-14T12:00:30Z", user: { login: `${CODEX_BOT}[bot]` } }]),
      })])],
    });
    const out = await sweep({
      owner: OWNER, name: "r", token: "t", fetchImpl: fake.impl,
      log: () => {}, now: () => Date.parse("2026-08-14T12:45:00Z"),
    });
    expect(out.awaiting).toBe(1);
  });

  it("parks a nudged head UNANSWERED_MINUTES after the ask", async () => {
    // The nudge restarts the window from its own time — and when Codex
    // ignores it too, the next nudge is another event, not a loop held to
    // its cap.
    const at = (t) => sweep({
      owner: OWNER, name: "r", token: "t",
      fetchImpl: fakeFetch({
        statuses: { abc1234: [gate("2026-08-14T12:00:00Z")] },
        issueComments: { 1: [{ user: { login: OWNER }, created_at: "2026-08-14T12:10:00Z", body: "@codex review" }] },
        graphqlResponses: [repoPRs([prNode()])],
      }).impl,
      log: () => {}, now: () => Date.parse(t),
    });
    expect((await at("2026-08-14T12:35:00Z")).awaiting).toBe(1);
    expect((await at("2026-08-14T12:41:00Z")).awaiting).toBe(0);
  });

  it("keeps a timed-out nudge parked instead of alternating with it", async () => {
    // Codex, PR #37. `nudged` sits ABOVE `unanswered` in `verdictFor`, and
    // an old nudge stays `nudged` forever while nothing answers -- so the
    // sweep after the park rewrote PENDING over the marker, re-anchored the
    // window on that change, and the head alternated between the two every
    // UNANSWERED_MINUTES, restarting polling each time. The test above
    // stops at the first timeout and never saw the sweep that follows it.
    //
    // The marker IS the record that this head waited out a full window with
    // nothing arriving, and the ask it waited on is the nudge -- so a nudge
    // OLDER than the marker is already accounted for, and only a newer one
    // is a fresh ask.
    const after = (statuses, comments) => sweep({
      owner: OWNER, name: "r", token: "t",
      fetchImpl: fakeFetch({
        statuses: { abc1234: statuses },
        issueComments: { 1: comments },
        graphqlResponses: [repoPRs([prNode()])],
      }).impl,
      log: () => {}, now: () => Date.parse("2026-08-14T12:45:00Z"),
    });
    const nudge = (at) => [{ user: { login: OWNER }, created_at: at, body: "@codex review" }];
    const parked = [
      gate("2026-08-14T12:40:00Z", "pending", UNANSWERED),
      gate("2026-08-14T12:00:00Z"),
    ];
    // The marker postdates the nudge, so it stands and nothing is written.
    const held = await after(parked, nudge("2026-08-14T12:10:00Z"));
    expect(held.awaiting).toBe(0);
    expect(held.written).toEqual([]);
    // A nudge NEWER than the marker is a fresh ask: the wait reopens and the
    // head goes back on the clock, exactly as it would without a marker.
    const asked = await after(parked, nudge("2026-08-14T12:44:00Z"));
    expect(asked.awaiting).toBe(1);
    expect(asked.written).toEqual([
      { number: 1, state: "pending", description: PENDING },
    ]);
  });

  it("reopens the wait for a newer nudge that has itself aged out", async () => {
    // The case that separates "the marker outranks an older nudge" from
    // "the marker outranks every nudge". Inside the window the clear on the
    // still-polling path masks the difference -- it rewrites PENDING either
    // way -- so only a nudge that is both NEWER than the marker and already
    // past UNANSWERED_MINUTES shows it: absorb it and a fresh ask is
    // silently swallowed by a stale marker, never putting the head back on
    // the clock at all.
    const asked = await sweep({
      owner: OWNER, name: "r", token: "t",
      fetchImpl: fakeFetch({
        statuses: { abc1234: [
          gate("2026-08-14T12:40:00Z", "pending", UNANSWERED),
          gate("2026-08-14T12:00:00Z"),
        ] },
        issueComments: { 1: [
          { user: { login: OWNER }, created_at: "2026-08-14T12:44:00Z", body: "@codex review" },
        ] },
        graphqlResponses: [repoPRs([prNode()])],
      }).impl,
      log: () => {}, now: () => Date.parse("2026-08-14T13:20:00Z"),
    });
    expect(asked.awaiting).toBe(1);
    expect(asked.written).toEqual([
      { number: 1, state: "pending", description: PENDING },
    ]);
  });

  it("gives a just-gated head the full window whatever its records say", async () => {
    // The fast-forward shapes arrive carrying records days old; anchored
    // only on the bound they would be parked on sight, and the run their
    // own push started would exit before the dating suite exists. The
    // first sweep's own `pending` write keeps that sweep's clock and
    // anchors the next ones, so every head gets UNANSWERED_MINUTES from
    // its first gating.
    const era = "2026-08-10T09:00:00Z";
    const fake = fakeFetch({
      statuses: { abc1234: [{ context: "Vercel", state: "success", created_at: era }] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const out = await sweep({
      owner: OWNER, name: "r", token: "t", fetchImpl: fake.impl,
      log: () => {}, now: () => Date.parse("2026-08-14T12:06:00Z"),
    });
    expect(out.written[0].state).toBe("pending");
    expect(out.awaiting).toBe(1);
  });

  it("revisits a settled head at once when the PR is touched", async () => {
    // The queued-nudge hole: while a loop is already running, a nudge's own
    // event run only queues behind the concurrency group — the ACTIVE loop
    // has to notice, or an approved head skipped for four more sweeps
    // leaves a stale success mergeable for minutes after the owner asked
    // for a re-read. A nudge is a comment and comments move `updatedAt`,
    // which rides the PR list query the sweep already pays for.
    const cadence = new Map();
    const sweepAt = (updatedAt) => {
      const fake = fakeFetch({
        statuses: { abc1234: [gate()] },
        prReviews: { 1: [review()] },
        graphqlResponses: [repoPRs([prNode({ updatedAt })])],
      });
      return sweep({
        owner: OWNER, name: "r", token: "t", fetchImpl: fake.impl, log: () => {}, cadence,
      }).then(() => fake);
    };
    await sweepAt(GATED_AT);
    // Untouched: skipped.
    const quiet = await sweepAt(GATED_AT);
    expect(quiet.calls.filter((c) => c.path.includes("/statuses/"))).toEqual([]);
    // Touched (a comment landed): judged on the very next sweep.
    const touched = await sweepAt("2026-08-14T12:20:00Z");
    expect(touched.calls.some((c) => c.path.includes("/statuses/"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The workflow holds `statuses: write`, and its safety is largely the
// *absence* of something — a checkout, a branch-selectable trigger, a second
// writer — which nothing else would notice going missing.

describe("runLoop", () => {
  // Fake clock: sleeping is what advances time, so the deadline arithmetic
  // is exercised without a single real wait.
  function harness({ minutes, failOn = Infinity }) {
    let clock = 0;
    let sweeps = 0;
    const sleeps = [];
    const run = runLoop({
      minutes,
      intervalSeconds: 60,
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      sweepOnce: async () => { sweeps += 1; if (sweeps === failOn) throw new Error("boom"); },
    });
    return { run, count: () => sweeps, sleeps };
  }

  it("stops after one sweep when no verdict is due — the lean gate", async () => {
    // Runner time must be proportional to pushes, not to how long PRs sit
    // open: an always-on loop is what makes this unaffordable on a private
    // repo, and a PR waiting overnight on a human is not a reason to poll.
    // Wired exactly as main() wires it.
    // The clock advances through sleep so a broken gate runs to the deadline
    // and fails on the count, rather than starving the runner forever on an
    // instantly-resolving fake sleep.
    let clock = 0;
    let sweeps = 0;
    await runLoop({
      minutes: 55,
      intervalSeconds: 60,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      sweepOnce: async () => { sweeps += 1; return { written: [], awaiting: 0 }; },
      shouldContinue: ({ awaiting }) => awaiting > 0,
    });
    expect(sweeps).toBe(1);
  });

  it("keeps looping while verdicts are due, and stops when the last settles", async () => {
    let clock = 0;
    let sweeps = 0;
    const awaitingBySweep = [2, 1, 0];
    await runLoop({
      minutes: 55,
      intervalSeconds: 60,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      sweepOnce: async () => { sweeps += 1; return { written: [], awaiting: awaitingBySweep.shift() }; },
      shouldContinue: ({ awaiting }) => awaiting > 0,
    });
    expect(sweeps).toBe(3);
  });

  it("sweeps once when minutes is 0 — the one-shot invocation", async () => {
    const h = harness({ minutes: 0 });
    await h.run;
    expect(h.count()).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it("keeps sweeping a poll interval apart until the deadline", async () => {
    const h = harness({ minutes: 3 });
    await h.run;
    // t=0,60s,120s,180s — the sweep at the deadline still runs.
    expect(h.count()).toBe(4);
    expect(h.sleeps).toEqual([60_000, 60_000, 60_000]);
  });

  it("lets an error escape rather than looping over a broken sweep", async () => {
    // A red job is visible and the queued successor starts immediately; a
    // loop that swallows failures looks healthy while the gate stalls.
    const h = harness({ minutes: 60, failOn: 2 });
    await expect(h.run).rejects.toThrow("boom");
    expect(h.count()).toBe(2);
  });

});

describe("input", () => {
  const withEnv = (vars, fn) => {
    const saved = { ...process.env };
    for (const [k, v] of Object.entries(vars)) process.env[k] = v;
    try {
      return fn();
    } finally {
      for (const k of Object.keys(vars)) {
        if (k in saved) process.env[k] = saved[k]; else delete process.env[k];
      }
    }
  };

  it("reads a hyphenated input under the name the runner actually sets", () => {
    // The runner replaces SPACES with underscores and passes hyphens through,
    // so `loop-minutes` arrives as INPUT_LOOP-MINUTES. Reading only the
    // underscored spelling found nothing, `minutes` fell to 0, and every run
    // swept once instead of looping for the hour. Nothing else caught it:
    // action.yml's default is applied by the runner, so the value was always
    // present and always unreadable.
    expect(withEnv({ "INPUT_LOOP-MINUTES": "55" },
      () => input("loop-minutes", "SWEEP_LOOP_MINUTES"))).toBe("55");
  });

  it("still reads the underscored spelling a hand-run would type", () => {
    // Running the script by hand is the documented way to unstick a verdict,
    // and INPUT_LOOP_MINUTES is what a person exports.
    expect(withEnv({ INPUT_LOOP_MINUTES: "5" },
      () => input("loop-minutes", "SWEEP_LOOP_MINUTES"))).toBe("5");
  });

  it("prefers the runner's spelling when both are set", () => {
    expect(withEnv({ "INPUT_LOOP-MINUTES": "55", INPUT_LOOP_MINUTES: "5" },
      () => input("loop-minutes", "SWEEP_LOOP_MINUTES"))).toBe("55");
  });

  it("falls back to the standalone env var, then to empty", () => {
    expect(withEnv({ SWEEP_LOOP_MINUTES: "30" },
      () => input("loop-minutes", "SWEEP_LOOP_MINUTES"))).toBe("30");
    expect(input("no-such-input", "NO_SUCH_ENV")).toBe("");
  });

  it("reads an unhyphenated input, which is why the action worked at all", () => {
    // `token` and `repository` carry no hyphen, so they resolved correctly
    // under the old code and the loop bug looked like a scheduling problem.
    expect(withEnv({ INPUT_REPOSITORY: "owner/name" },
      () => input("repository", "GITHUB_REPOSITORY"))).toBe("owner/name");
  });
});

describe("reviewTableStatus", () => {
  const HEAD = "b9f8d3213f5895509362ccd581b990bd0d830d3b";

  it("reads the code row as running for this head", () => {
    expect(reviewTableStatus(summaryTable({ status: "Running", commit: "b9f8d32" }), HEAD))
      .toBe("running");
  });

  it("reads the code row as completed for this head", () => {
    expect(reviewTableStatus(summaryTable({ status: "Completed", commit: "b9f8d32" }), HEAD))
      .toBe("completed");
  });

  it("never answers for the code row out of the security row", () => {
    // Observed live on a private sibling, 2026-09-02: Code Review `Running` on the new
    // head while Security Review still read `Completed` on the commit
    // before it. A reading that took the first row it understood, or the
    // `codex-security-review:v1` marker's `headSha`, would report the
    // security pass's state as the code review's -- so this asks about the
    // commit the SECURITY row names and must still get null.
    const body = summaryTable({
      status: "Running", commit: "b9f8d32",
      security: "Completed", securityCommit: "4cc14a9",
    });
    expect(reviewTableStatus(body, "4cc14a9cc0a7f19938a6d7d5c676a1ec98aedf69")).toBeNull();
  });

  it("refuses a comment without the marker", () => {
    // Any comment can hold a table-shaped block; only Codex's carries the
    // marker, and without it this is just someone's prose.
    const body = summaryTable({ status: "Running", commit: "b9f8d32" })
      .replace("codex-pull-request-review-summary", "something-else");
    expect(reviewTableStatus(body, HEAD)).toBeNull();
  });

  it("compares by prefix only in the direction that cannot collide", () => {
    // As in `cleanVerdict`: the row's abbreviated id must be a prefix of
    // the head, never the reverse, which would let a long id speak for a
    // head it merely starts with.
    expect(reviewTableStatus(summaryTable({ status: "Running", commit: "b9f8d3213f5" }), "b9f8d32"))
      .toBeNull();
  });

  it("says nothing while the table carries no code row yet", () => {
    // Observed on this action's own pull request: the comment is CREATED
    // with the security row alone, and the code row arrives in a later
    // edit. A reading that took the first row it could parse would report
    // the security pass's state as the code review's during that window.
    const body = summaryTable({ status: "Running", commit: "7284e2e" })
      .split("\n")
      .filter((l) => !l.includes("Code Review"))
      .join("\n");
    expect(reviewTableStatus(body, "7284e2e8f880ff0a93d3549c5c852f4940d72f07")).toBeNull();
  });

  it("refuses a status word it does not know", () => {
    // Degrading to null keeps polling, which is what the caller did before
    // the table existed -- so a new state upstream costs runner minutes,
    // never a wrong answer.
    expect(reviewTableStatus(summaryTable({ status: "Queued", commit: "b9f8d32" }), HEAD))
      .toBeNull();
  });
});

describe("cleanVerdict", () => {
  const CLEAN = "Codex Review: Didn\u2019t find any major issues. Swish!\n\n**Reviewed commit:** `5f3881b6c0`";
  const HEAD = "5f3881b6c0fc1c4bb74ca076dc6bac9ddc2631da";

  it("reads a clean comment naming this head", () => {
    // Codex's footer promises a 👍 when it finds nothing, and it does not
    // always keep that promise -- it posted exactly this on codex-review#13
    // and on a sibling repo's, leaving the reaction channel empty and both
    // gates shut.
    expect(cleanVerdict(CLEAN, HEAD)).toBe("head");
  });

  it("accepts the straight apostrophe too", () => {
    expect(cleanVerdict(CLEAN.replace("\u2019", "'"), HEAD)).toBe("head");
  });

  it("calls a clean verdict on another commit what it is", () => {
    // A sibling repo's: a clean comment on an older commit from nine hours
    // earlier was
    // counted as an ANSWER on a head it had never seen, so the status read
    // "Codex left findings on this head" with no finding anywhere on it.
    expect(cleanVerdict(CLEAN, "0beef12383aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe("other");
  });

  it("does not read a findings comment as clean", () => {
    expect(cleanVerdict("Codex Review: 2 findings\n\n**Reviewed commit:** `5f3881b6c0`", HEAD)).toBe(null);
  });

  it("refuses a clean verdict that names no commit", () => {
    // Unattributable: nothing ties it to this head, and approving on it
    // would let a word about superseded code open the gate.
    expect(cleanVerdict("Codex Review: Didn't find any major issues.", HEAD)).toBe(null);
  });

  it("compares by prefix only in the direction that cannot collide", () => {
    // Codex abbreviates to ten characters where the API gives forty, so the
    // named id must be a prefix of the head -- never the reverse, which
    // would let a forty-character id approve a head it merely starts with.
    expect(cleanVerdict(CLEAN, "5f3881b6")).toBe("other");
  });

  it("refuses a headline that continues into its opposite", () => {
    // "Didn't find any major issues in this fixture, but found a gate bug"
    // opens with the clean words and reports a finding. A prefix match reads
    // it as approval, so the sentence has to END at "issues" -- the `.` or
    // `!` is what separates the real headline from a continuation.
    const continued = "Codex Review: Didn't find any major issues in this fixture, but found a gate bug.\n\n**Reviewed commit:** `5f3881b6c0`";
    expect(cleanVerdict(continued, HEAD)).toBe(null);
  });

  it("refuses the headline anywhere but the first content line", () => {
    // A fenced or quoted example is not a verdict, and this parser's own
    // review comments quote the sentence -- so the material to forge one
    // with is already sitting on the pull request.
    const fenced = "Here is the shape it matches:\n\n```\nCodex Review: Didn't find any major issues.\n```\n\n**Reviewed commit:** `5f3881b6c0`";
    expect(cleanVerdict(fenced, HEAD)).toBe(null);
  });

  it("refuses an unbadged finding on a later line", () => {
    // The headline is clean and the finding sits two lines down, wearing no
    // badge. Enumerating forbidden phrases cannot catch this; requiring the
    // whole known shape does.
    const later = "Codex Review: Didn't find any major issues.\n\nHowever, I found a blocking bug.\n\n**Reviewed commit:** `5f3881b6c0`";
    expect(cleanVerdict(later, HEAD)).toBe(null);
  });

  it("accepts the real comment with its details footer", () => {
    // The shipped shape: headline, reviewed commit, then Codex's
    // collapsible boilerplate, which is dropped before the shape is checked.
    const real = [
      "Codex Review: Didn't find any major issues. Keep them coming!",
      "",
      "**Reviewed commit:** `5f3881b6c0`",
      "",
      "<details> <summary>ℹ️ About Codex in GitHub</summary>",
      "<br/>",
      "",
      "Reviews are triggered when you open a pull request for review.",
      "</details>",
    ].join("\n");
    expect(cleanVerdict(real, HEAD)).toBe("head");
  });

  it("accepts a plain finding written as a continuation, knowingly", () => {
    // "Didn't find any major issues. However, I found a blocking bug." is
    // the exploit both the allowlist and the blacklist this repo tried were
    // built to catch. Neither survived contact with the real tail variety
    // Codex actually sends (see the comment above cleanVerdict), so this is
    // now accepted on purpose: every real incident so far has been this
    // function refusing a genuine clean verdict over unenumerated wording,
    // never a hidden finding sneaking through. If that balance ever flips,
    // this is the test to make fail again.
    const however = "Codex Review: Didn't find any major issues. However, I found a blocking bug.\n\n**Reviewed commit:** `5f3881b6c0`";
    expect(cleanVerdict(however, HEAD)).toBe("head");
  });

  it("accepts a cheer it has not seen before, or any tail at all", () => {
    // The allowlist this replaced would have failed closed here, waiting on
    // someone to add the exact wording. The tail is not inspected at all
    // now -- the headline sentence alone is the verdict.
    const novel = "Codex Review: Didn't find any major issues. Nice one!\n\n**Reviewed commit:** `5f3881b6c0`";
    expect(cleanVerdict(novel, HEAD)).toBe("head");
  });

  it("accepts real cheers from the fleet that no allowlist ever named", () => {
    // Sampled from the survey that motivated this: each was seen exactly
    // once or twice across ~220 clean verdicts in 17 repos.
    const cheers = [
      "You're on a roll.",
      "Chef's kiss.",
      "Already looking forward to the next diff.",
      "Another round soon, please!",
      "What shall we delve into next?",
      ":+1:",
    ];
    for (const cheer of cheers) {
      const comment = `Codex Review: Didn't find any major issues. ${cheer}\n\n**Reviewed commit:** \`5f3881b6c0\``;
      expect(cleanVerdict(comment, HEAD)).toBe("head");
    }
  });

  it("accepts the bare sentence with no cheer at all", () => {
    expect(cleanVerdict("Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `5f3881b6c0`", HEAD)).toBe("head");
  });

  it("accepts the emoji-shortcode cheer, which arrives unrendered", () => {
    // Observed on this very pull request: Codex answered clean with
    // ":tada:", a tail the first version of the allowlist did not know, and
    // the gate held exactly as the fail-closed design says it should.
    const tada = "Codex Review: Didn't find any major issues. :tada:\n\n**Reviewed commit:** `5f3881b6c0`";
    expect(cleanVerdict(tada, HEAD)).toBe("head");
  });

  it("accepts the real cheers, which vary", () => {
    const swish = "Codex Review: Didn't find any major issues. Swish!\n\n**Reviewed commit:** `5f3881b6c0`";
    const keep = "Codex Review: Didn't find any major issues. Keep them coming!\n\n**Reviewed commit:** `5f3881b6c0`";
    expect(cleanVerdict(swish, HEAD)).toBe("head");
    expect(cleanVerdict(keep, HEAD)).toBe("head");
  });

  it("refuses a findings comment that quotes the clean sentence", () => {
    // Codex quotes this very sentence when it reviews this parser -- the P1
    // that found this did -- and a findings comment carries the same
    // `Reviewed commit` footer, so an unanchored match would read a finding
    // as an approval and publish a false success.
    const quoting = [
      "### 💡 Codex Review",
      "",
      "The marker `Didn't find any major issues` is matched unanchored here.",
      "",
      "**Reviewed commit:** `5f3881b6c0`",
    ].join("\n");
    expect(cleanVerdict(quoting, HEAD)).toBe(null);
  });

  it("refuses a badged finding even if it opens with the clean headline", () => {
    const badged = `Codex Review: Didn't find any major issues.\n\n![P1 Badge](x) something\n\n**Reviewed commit:** \`5f3881b6c0\``;
    expect(cleanVerdict(badged, HEAD)).toBe(null);
  });

  it("refuses the sentence quoted inside a reply", () => {
    const quoted = "> Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `5f3881b6c0`";
    expect(cleanVerdict(quoted, HEAD)).toBe(null);
  });

  it("returns null for an empty or absent body", () => {
    expect(cleanVerdict(undefined, HEAD)).toBe(null);
    expect(cleanVerdict("", HEAD)).toBe(null);
  });
});

describe("the published wording", () => {
  it("says approve rather than review in the pending description", () => {
    // A head Codex has reviewed and left findings on sits at pending too, so
    // "waiting to review" would name the one thing that already happened.
    // This is the string a consumer's branch-protection UI shows, so it is
    // part of the action's contract rather than an implementation detail.
    expect(PENDING).toMatch(/approve/);
  });

  it("publishes under the context a ruleset names", () => {
    // Renaming this silently orphans every required-check rule pointing at
    // the old name: the rule waits for a status nothing writes any more, and
    // a check that never reports blocks every merge. It is the action's
    // public surface, so a change here is a major version.
    expect(CONTEXT).toBe("codex");
  });
});
