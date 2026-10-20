import { describe, it, expect } from "./vitest-shim.mjs";
import {
  verdictFor,
  carriedClaim,
  runLoop,
  PENDING,
  FINDINGS,
  SECURITY,
  isSecurityFinding,
  unresolvedSecurityFindings,
  matchesBot,
  matchesBotLogin,
  readHolds,
  reviewState,
  reviewTableRow,
  codexCodeReview,
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
  reviewTableStatus,
  signAppJwt,
  appToken,
  resolveStatusToken,
  statusTokenSource,
  APP_TOKEN_REFRESH_MS,
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

  it("reopens the wait when the owner nudges over a standing verdict", () => {
    // Asking Codex to look again means the standing verdict is no longer
    // the one wanted — honoring it would let auto-merge take a PR the owner
    // just asked to have re-reviewed. Codex's fresh answer (a clean review
    // newer than the nudge) restores success through `approved` later.
    expect(verdictFor({ approved: true, nudged: true })).toEqual({
      state: "pending",
      description: PENDING,
    });
  });

  it("skips drafts", () => {
    expect(verdictFor({ isDraft: true, approved: true })).toBeNull();
  });

  it("carries the previous head's verdict across a generated push", () => {
    // The lanes engine vouched that this head is the previous one plus the
    // files CI wrote back; Codex's answer there is the answer here.
    expect(verdictFor({ carried: "abc1234" })).toEqual({
      state: "success",
      description: "Codex reviewed abc1234; verdict carried across generated files",
    });
  });

  it("lets a carried verdict outrank a read in progress", () => {
    // Codex re-reading rendered images is the revocation the carry exists
    // to survive; waiting for it is the wait it exists to end.
    expect(verdictFor({ carried: "abc1234", reading: true }).state).toBe("success");
  });

  it("holds a carried verdict below findings, a nudge, a hold and a shared head", () => {
    // Each is about THIS head, which a verdict on the previous one cannot
    // answer.
    expect(verdictFor({ carried: "abc1234", findings: true })).toEqual({
      state: "pending",
      description: FINDINGS,
    });
    expect(verdictFor({ carried: "abc1234", nudged: true }).state).toBe("pending");
    expect(verdictFor({ carried: "abc1234", held: "👎" }).state).toBe("failure");
    expect(verdictFor({ carried: "abc1234", sharedHead: true }).state).toBe("failure");
    expect(verdictFor({ carried: "abc1234", isDraft: true })).toBeNull();
  });

  it("withholds approval, carried or earned, over an unresolved security finding", () => {
    // The finding belongs to the pull request, not the head, so neither a
    // 👍 on this head nor a verdict carried from the last one answers it.
    expect(verdictFor({ approved: true, security: true })).toEqual({
      state: "pending",
      description: SECURITY,
    });
    expect(verdictFor({ carried: "abc1234", security: true })).toEqual({
      state: "pending",
      description: SECURITY,
    });
    // A hold and a shared head still say what they say: both already
    // block, and both name a remedy the security wording does not.
    expect(verdictFor({ approved: true, security: true, held: "👎" }).state).toBe("failure");
    expect(verdictFor({ approved: true, security: true, sharedHead: true }).state).toBe("failure");
    expect(verdictFor({ approved: true, security: true, isDraft: true })).toBeNull();
  });
});

describe("carriedClaim", () => {
  const lanes = (over = {}) => ({
    context: "lanes",
    state: "success",
    description: "Generated-only push; verdict carried forward from abc1234. [base 0beef12]",
    creator: { login: "lanes-app[bot]", type: "Bot" },
    ...over,
  });

  it("reads the carried head off the engine's own wording", () => {
    expect(carriedClaim([lanes()]).from).toBe("abc1234");
  });

  it("claims nothing for a fresh verdict, a docs skip or a failure", () => {
    expect(carriedClaim([lanes({ description: "Every required job passed. [base 0beef12]" })])).toBeNull();
    expect(carriedClaim([lanes({ description: "Documentation-only diff; the heavy jobs were skipped." })])).toBeNull();
    expect(carriedClaim([lanes({ state: "pending" })])).toBeNull();
    expect(carriedClaim([lanes({ state: "failure" })])).toBeNull();
    expect(carriedClaim([])).toBeNull();
    expect(carriedClaim(null)).toBeNull();
  });

  it("reads the attestation before the required check, and the newest of each", () => {
    // The attestation is the heavy jobs' verdict posted before the push
    // that writes generated files; `lanes` itself still says pending then.
    const attest = lanes({ context: "lanes-attest", description: "Generated-only push; verdict carried forward from 1111111. [base 0beef12]" });
    expect(carriedClaim([lanes({ state: "pending" }), attest]).from).toBe("1111111");
    // Newest first, so an older carried entry under a fresh code verdict is
    // not the claim.
    const fresh = lanes({ description: "Every required job passed. [base 0beef12]" });
    expect(carriedClaim([fresh, lanes()])).toBeNull();
  });
});

describe("readHolds", () => {
  const CODEX = `${CODEX_BOT}[bot]`;
  const react = (login, content, createdAt = "2026-08-14T12:05:00Z") =>
    ({ content, createdAt, user: { login } });
  const OWNER = "repo-owner";
  const read = (nodes) => readHolds(nodes, OWNER);

  it("holds on the owner's 👎 from before the head — a new commit is not an answer", () => {
    expect(read([react(OWNER, "THUMBS_DOWN", "2026-08-01T00:00:00Z")])).toBe("👎");
  });

  it("holds on the owner's 👀", () => {
    expect(read([react(OWNER, "EYES")])).toBe("👀");
  });

  it("prefers 👎 over 👀 when both are present", () => {
    expect(read([react(OWNER, "EYES"), react(OWNER, "THUMBS_DOWN")])).toBe("👎");
  });

  it("ignores a hold from anyone but the owner", () => {
    // Public repo: an unrestricted hold outlives every head, so a passer-by
    // could block a PR for as long as they left the reaction there.
    expect(read([react("passer-by", "THUMBS_DOWN")])).toBeNull();
    expect(read([react("passer-by", "EYES")])).toBeNull();
  });

  it("reads nothing from Codex's own reactions", () => {
    // Its 👍 and 👀 name no commit, so they neither approve nor hold.
    expect(read([react(CODEX, "THUMBS_UP"), react(CODEX, "EYES")])).toBeNull();
  });

  it("ignores a reaction it has no rule for, and holds nothing with no owner", () => {
    expect(read([react(OWNER, "HOORAY")])).toBeNull();
    expect(readHolds([react(OWNER, "THUMBS_DOWN")], null)).toBeNull();
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
    // Public repo: a passer-by's nudge must not hold the gate, for the same
    // reason their reactions cannot. Nor does it wake the clock: their ask
    // costs the runner and buys nothing.
    const seen = read([c("passer-by", "2026-08-15T08:00:00Z", "@codex review")]);
    expect(seen.nudgeAt).toBeNull();
    expect(seen.askAt).toBeNull();
  });

  it("hears a collaborator's @codex review as an ask, never a nudge", () => {
    // Codex answers it, so the clock has to hear it, but only the owner's
    // ask holds the gate.
    const ask = { ...c("collaborator", "2026-08-15T08:00:00Z", "@codex review"), author_association: "COLLABORATOR" };
    const seen = read([ask]);
    expect(seen.askAt).toBe("2026-08-15T08:00:00Z");
    expect(seen.nudgeAt).toBeNull();
  });

  it("counts the owner's nudge as an ask too", () => {
    const seen = read([c(OWNER, "2026-08-15T08:00:00Z", "@codex review")]);
    expect(seen.askAt).toBe("2026-08-15T08:00:00Z");
    expect(seen.nudgeAt).toBe("2026-08-15T08:00:00Z");
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
      .toEqual({ codexAt: null, nudgeAt: null, askAt: null, cleanAt: null });
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
// Codex's summary comment as it reads once a code review of `commit` has
// run: the machine-readable state names the full commit and whether the
// review found anything, and the table row carries its time. The default is
// the clean pass Codex leaves no other comment for.
const codexTable = ({
  commit = "abc1234", status = "completed", findings = false, at = AFTER,
  security = "completed", securityCommit = "0beef12",
} = {}) => {
  const word = { completed: "Completed", running: "Running" }[status] ?? status;
  const sword = { completed: "Completed", running: "Running" }[security] ?? security;
  const state = {
    code_review: { commit_sha: commit, has_any_findings: status === "completed" ? findings : null, status },
    security_review: { commit_sha: securityCommit, has_any_findings: null, status: security },
  };
  return [
    "<!-- codex-pull-request-review-summary -->",
    `<!-- codex-review-state:v1 ${JSON.stringify(state)} -->`,
    "## Codex Review Summary",
    "",
    "| Review | Status | Commit | Review trigger |",
    "| --- | --- | --- | --- |",
    `| 📝 **Code Review** | ✅ **${word}** <relative-time datetime="${at}">${at}</relative-time> | \`${commit.slice(0, 7)}\` | New commits |`,
    `| 🔒 **Security Review** | **${sword}** <relative-time datetime="${BEFORE}">t</relative-time> | \`${securityCommit.slice(0, 7)}\` | PR opened |`,
    "",
    "<details> <summary>About Codex in GitHub</summary> boilerplate </details>",
  ].join("\n");
};
// The same, as the comment REST returns: created at PR open, edited since.
const codexSummary = (over = {}, { created_at = BEFORE, updated_at = over.at ?? AFTER } = {}) => ({
  user: { login: `${CODEX_BOT}[bot]`, type: "Bot" },
  created_at,
  updated_at,
  body: codexTable(over),
});

// When the head commit was made — the comment walk's lower bound, always
// earlier than the marker but later than anything about a previous head.
const BORN_AT = "2026-08-14T11:30:00Z";
const OWNER = "o";
// The park wording an earlier version wrote on fork heads; commits still
// wear it, so it is still recognized and re-worded.
const LEGACY_FORK_MARKER = "A fork head\u0027s 👍 cannot be accepted — comment @codex review, or merge by admin override";

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
  createdAt: "2026-08-14T10:00:00Z",
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
const hold = (content = "THUMBS_DOWN", login = OWNER) => ({
  content,
  createdAt: AFTER,
  user: { login },
});

// `statuses` maps a SHA to its `codex` entries, newest first, as GitHub
// returns them. A GET on the statuses path reads them; a POST writes one.
// `issueComments` maps a PR number to REST-shaped comments; the fake honors
// paging but not `since` — the code under test re-filters by created_at.
// `branchRules` is what `GET /rules/branches/<base>` returns; `apps` maps
// an App slug to its record; `combined` maps a ref to its combined status
// (`GET /commits/<ref>/status`), the one read that resolves a short SHA.
// `reviewThreads` maps a PR number to GraphQL thread nodes, served 100 to a
// page by their own query rather than from `graphqlResponses`, so a test that
// never mentions threads reads none.
function fakeFetch({
  graphqlResponses = [], statuses = {}, issueComments = {}, prReviews = {},
  reviewThreadComments = {}, checkSuites = {}, issueReactions = {},
  failStatusWrite = false, failComments = false,
  branchRules = null, apps = {}, combined = {}, prCommits = {},
  reviewThreads = {},
} = {}) {
  const calls = [];
  const queue = [...graphqlResponses];
  const impl = async (url, opts = {}) => {
    const path = url.replace("https://api.github.com", "");
    const method = opts.method ?? "GET";
    calls.push({
      path, method, body: opts.body ? JSON.parse(opts.body) : null,
      auth: opts.headers?.authorization,
    });

    if (path === "/graphql" && JSON.parse(opts.body).query.includes("reviewThreads")) {
      const { number, after } = JSON.parse(opts.body).variables;
      const all = reviewThreads[number] ?? [];
      const start = after === null ? 0 : Number(after);
      const nodes = all.slice(start, start + 100);
      const hasNextPage = start + 100 < all.length;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: page(nodes, hasNextPage, hasNextPage ? String(start + 100) : null),
              },
            },
          },
        }),
      };
    }
    if (path === "/graphql") {
      const data = queue.shift();
      if (!data) throw new Error("unexpected extra graphql call");
      return { ok: true, status: 200, json: async () => (data.errors ? data : { data }) };
    }
    if (/\/pulls\/\d+\/commits/.test(path)) {
      const number = path.split("/pulls/")[1].split("/")[0];
      const page = Number(new URLSearchParams(path.split("?")[1] ?? "").get("page") ?? 1);
      const all = prCommits[number] ?? [];
      return { ok: true, status: 200, json: async () => all.slice((page - 1) * 100, page * 100) };
    }
    if (path.includes("/rules/branches/")) {
      if (branchRules === null) throw new Error(`unexpected rules read ${path}`);
      return { ok: true, status: 200, json: async () => branchRules };
    }
    if (path.startsWith("/apps/")) {
      const app = apps[path.slice("/apps/".length)];
      return app
        ? { ok: true, status: 200, json: async () => app }
        : { ok: false, status: 404, json: async () => ({}) };
    }
    if (/\/commits\/[^/]+\/status$/.test(path)) {
      const ref = path.split("/commits/")[1].split("/")[0];
      const c = combined[ref];
      return c
        ? { ok: true, status: 200, json: async () => c }
        : { ok: false, status: 404, json: async () => ({}) };
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
      // A function is called per read, for a comment that changes between them.
      const source = (kind === "/issues/" ? issueComments : reviewThreadComments)[number];
      const all = (typeof source === "function" ? source() : source) ?? [];
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
      issueComments: { 1: [codexSummary()] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    expect((await run(fake))[0].state).toBe("success");
  });

  // What the sweep is handed once an App credential is configured: the
  // minted token, and the login its writes appear under.
  const APP_CREDENTIAL = { token: "ghs_app", login: "codex-verdict[bot]" };

  it("writes the status as the App and reads as the workflow", async () => {
    // The App the README asks for holds commit statuses and nothing else,
    // so every read has to stay on the workflow's own token: routing them
    // through the App would fail the first sweep on a private repository
    // and never publish a verdict (Codex, mikelward/codex-review#42).
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      checkSuites: { abc1234: [bornSuite()] },
      issueComments: { 1: [codexSummary()] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const { written } = await sweep({
      owner: OWNER, name: "r", token: "gh_workflow", statusToken: APP_CREDENTIAL,
      fetchImpl: fake.impl, log: () => {}, now: TEST_NOW,
    });
    expect(written[0].state).toBe("success");
    const write = fake.calls.find((c) => c.method === "POST" && c.path.includes("/statuses/"));
    expect(write.auth).toBe("Bearer ghs_app");
    const reads = fake.calls.filter((c) => c !== write);
    expect(reads.length > 0).toBe(true);
    expect(reads.every((c) => c.auth === "Bearer gh_workflow")).toBe(true);
    // And with no App credential, one token does both -- an ordinary
    // consumer's sweep is unchanged.
    const plain = fakeFetch({
      statuses: { abc1234: [gate()] },
      checkSuites: { abc1234: [bornSuite()] },
      issueComments: { 1: [codexSummary()] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    await run(plain);
    expect(plain.calls.every((c) => c.auth === "Bearer t")).toBe(true);
  });

  it("stamps a success with the pull request that earned it", async () => {
    // A status belongs to the COMMIT and says nothing about which pull
    // request earned it, which is what the carry could never establish
    // from the outside. The writer knows, so it records it: this action
    // only ever writes on the pull request's own head, so a success naming
    // #N on a commit is the record that the commit was #N's head when it
    // was written (Codex round 9).
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      checkSuites: { abc1234: [bornSuite()] },
      issueComments: { 1: [codexSummary()] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    expect((await run(fake))[0].state).toBe("success");
    const write = fake.calls.find((c) => c.method === "POST" && c.path.includes("/statuses/"));
    expect(write.body.description).toBe("Codex reviewed this head, no findings (#1)");
    // And read back: an identical stamped status is not rewritten, so the
    // stamp does not cost a write on every sweep.
    const again = fakeFetch({
      statuses: { abc1234: [gate("2026-08-14T12:05:00Z", "success", "Codex reviewed this head, no findings (#1)")] },
      checkSuites: { abc1234: [bornSuite()] },
      issueComments: { 1: [codexSummary()] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    expect(await run(again)).toEqual([]);
  });

  it("rewrites an identical status the App did not post", async () => {
    // The migration case: an open head already carries a `codex: success`
    // from `github-actions[bot]`, identical in state and description to
    // what this sweep would write. Skipping it as unchanged would leave a
    // ruleset bound to the App waiting forever on that head, since nothing
    // else will change its verdict (Codex, mikelward/codex-review#42).
    const standing = (creator) => ({
      abc1234: [gate("2026-08-14T12:05:00Z", "success", "Codex reviewed this head, no findings (#1)")].map(
        (s) => ({ ...s, creator }),
      ),
    });
    const workflowBot = fakeFetch({
      statuses: standing({ login: "github-actions[bot]", type: "Bot" }),
      checkSuites: { abc1234: [bornSuite()] },
      issueComments: { 1: [codexSummary()] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const { written } = await sweep({
      owner: OWNER, name: "r", token: "gh_workflow", statusToken: APP_CREDENTIAL,
      fetchImpl: workflowBot.impl, log: () => {}, now: TEST_NOW,
    });
    expect(written[0].state).toBe("success");
    const write = workflowBot.calls.find((c) => c.method === "POST" && c.path.includes("/statuses/"));
    expect(write.auth).toBe("Bearer ghs_app");
    // Once the App's own status is there, the identical-write skip is back:
    // the rewrite happens once per head, not every sweep.
    const appPosted = fakeFetch({
      statuses: standing({ login: "codex-verdict[bot]", type: "Bot" }),
      checkSuites: { abc1234: [bornSuite()] },
      issueComments: { 1: [codexSummary()] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const second = await sweep({
      owner: OWNER, name: "r", token: "gh_workflow", statusToken: APP_CREDENTIAL,
      fetchImpl: appPosted.impl, log: () => {}, now: TEST_NOW,
    });
    expect(second.written).toEqual([]);
    // A DIFFERENT App's status is the same finding, not a pass. Reading
    // any non-Actions bot as correct made a rotation invisible: the head
    // looked migrated, the rewrite was skipped, and a ruleset bound to the
    // App now configured waited forever (Codex, mikelward/codex-review#42).
    const otherApp = fakeFetch({
      statuses: standing({ login: "old-verdict[bot]", type: "Bot" }),
      checkSuites: { abc1234: [bornSuite()] },
      issueComments: { 1: [codexSummary()] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const rotated = await sweep({
      owner: OWNER, name: "r", token: "gh_workflow", statusToken: APP_CREDENTIAL,
      fetchImpl: otherApp.impl, log: () => {}, now: TEST_NOW,
    });
    expect(rotated.written[0].state).toBe("success");
    // A login differing only in case is the same account, as GitHub
    // compares them -- so that one is not rewritten.
    const cased = fakeFetch({
      statuses: standing({ login: "Codex-Verdict[bot]", type: "Bot" }),
      checkSuites: { abc1234: [bornSuite()] },
      issueComments: { 1: [codexSummary()] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const sameApp = await sweep({
      owner: OWNER, name: "r", token: "gh_workflow", statusToken: APP_CREDENTIAL,
      fetchImpl: cased.impl, log: () => {}, now: TEST_NOW,
    });
    expect(sameApp.written).toEqual([]);
    // And with no App credential the skip is unconditional, as before.
    const plain = fakeFetch({
      statuses: standing({ login: "github-actions[bot]", type: "Bot" }),
      checkSuites: { abc1234: [bornSuite()] },
      issueComments: { 1: [codexSummary()] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    expect(await run(plain)).toEqual([]);
  });

  it("leaves pending and failure descriptions unstamped", async () => {
    // Both are read back by exact string -- the parked marker, the
    // findings check -- and neither is ever carried, so neither is
    // stamped.
    const pending = fakeFetch({ graphqlResponses: [repoPRs([prNode()])] });
    await run(pending);
    const first = pending.calls.find((c) => c.method === "POST" && c.path.includes("/statuses/"));
    expect(first.body.description).toBe(PENDING);
    const shared = fakeFetch({
      graphqlResponses: [repoPRs([prNode(), prNode({ number: 2 })])],
    });
    await run(shared);
    const write = shared.calls.find((c) => c.method === "POST" && c.path.includes("/statuses/"));
    expect(write.body.state).toBe("failure");
    expect(write.body.description.includes("(#")).toBe(false);
  });

  it("ignores a summary table that is not Codex's", async () => {
    // A forged table could otherwise approve: anyone can comment.
    const forged = { ...codexSummary(), user: { login: "someone-else", type: "User" } };
    const fake = fakeFetch({
      issueComments: { 1: [forged] },
      graphqlResponses: [repoPRs([prNode()])],
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
      issueComments: { 1: [codexSummary()] },
      graphqlResponses: [repoPRs([prNode()])],
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

  it("reads nothing from Codex's 👍 — it names no commit", async () => {
    // A 👍 can outlive the head it was about, so it approves nothing; only
    // what Codex writes about this commit does.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      graphqlResponses: [repoPRs([prNode({ reactions: page([thumbs()]) })])],
    });
    // The head is already marked pending, so a correct sweep writes nothing.
    expect(await run(fake)).toEqual([]);
  });

  it("approves a head the table names, gated or not", async () => {
    // The table names the full commit, so no marker is needed to date it.
    const fake = fakeFetch({
      issueComments: { 1: [codexSummary()] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    expect((await run(fake))[0].state).toBe("success");
  });

  it("does not approve on a table about another commit", async () => {
    const fake = fakeFetch({
      issueComments: { 1: [codexSummary({ commit: "0beef12" })] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    expect((await run(fake))[0].state).toBe("pending");
  });

  it("does not approve on a review the table says found something", async () => {
    const fake = fakeFetch({
      issueComments: { 1: [codexSummary({ findings: true })] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    expect((await run(fake))[0]).toEqual({ number: 1, state: "pending", description: FINDINGS });
  });

  it("parks a head whose review the table says is running, over an earlier clean one", async () => {
    // A review of this commit still being written: whoever asked for it
    // wants the new answer. The table's edit to Completed is the wake.
    const fake = fakeFetch({
      statuses: { abc1234: [gate(GATED_AT, "success", "Codex reviewed this head, no findings (#1)")] },
      issueComments: { 1: [codexSummary({ status: "running" })] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const out = await runFull(fake);
    expect(out.written).toEqual([{ number: 1, state: "pending", description: PENDING }]);
    expect(out.awaiting).toBe(0);
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
      issueComments: { 1: [codexSummary()] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    expect((await run(fake))[0].state).toBe("success");
  });

  it("withholds approval while someone is holding the PR", async () => {
    const fake = fakeFetch({
      issueComments: { 1: [codexSummary()] },
      graphqlResponses: [repoPRs([prNode({ reactions: page([hold()]) })])],
    });
    expect((await run(fake))[0]).toEqual({
      number: 1,
      state: "failure",
      description: "On hold: 👎 on the pull request",
    });
  });

  it("finds a hold on a later reaction page rather than approving over it", async () => {
    // Why the page walk reads every page: a hold nobody got to see would
    // otherwise merge past.
    const fake = fakeFetch({
      issueComments: { 1: [codexSummary()] },
      graphqlResponses: [
        repoPRs([prNode({ reactions: page([hold("HOORAY")], true, "cursor9") })]),
        { repository: { pullRequest: { reactions: page([hold()]) } } },
      ],
    });
    expect((await run(fake))[0].state).toBe("failure");
  });

  it("counts only pending verdicts toward the loop's lean gate", async () => {
    // One PR waiting on Codex, one already approved, one draft: only the
    // first should keep the fast clock running.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()], bbb1234: [gate()] },
      issueComments: { 2: [codexSummary({ commit: "bbb1234" })] },
      graphqlResponses: [repoPRs([
        prNode(),
        prNode({ number: 2, headRefOid: "bbb1234" }),
        prNode({ number: 3, isDraft: true, headRefOid: "d1" }),
      ])],
    });
    expect((await runFull(fake)).awaiting).toBe(1);
  });

  it("keeps the loop running on Codex's 👀 alone — it names no review", async () => {
    // A 👀 with no table to say what is running is just an unanswered head:
    // pending, on the clock, until its window runs out.
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

  it("parks a head once Codex's table says its review is running", async () => {
    // The table is EDITED to `Completed` when the answer lands, an
    // `issue_comment` event, so the read need not be polled through: park,
    // and let the edit be the wake. Still `pending`, so nothing fails open.
    // A table with no state line still says this much.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      issueComments: {
        1: [{
          user: { login: `${CODEX_BOT}[bot]`, type: "Bot" },
          created_at: BEFORE,
          body: summaryTable({ status: "Running", commit: "abc1234" }),
        }],
      },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(0);
    expect(out.written).toEqual([]);
  });

  it("keeps the clock when a second read no longer says the review is running", async () => {
    // The run the `Completed` edit starts can read the comment just before
    // the edit shows. Parking on that first read would let the only wake
    // go by, so the park waits for a second read to agree.
    let reads = 0;
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      issueComments: {
        1: () => [codexSummary(reads++ === 0 ? { status: "running" } : {})],
      },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(1);
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

  it("closes the gate on a top-level comment and stops the clock", async () => {
    // The third finding stream: no submitted review, just a PR comment —
    // tied to the head by being newer than the head commit's own date,
    // since comments carry no commit id. The clock can stop: whatever comes
    // next (a push, or a re-review's table edit) arrives as an event.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      issueComments: { 1: [{ user: { login: `${CODEX_BOT}[bot]` }, created_at: AFTER }] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(0);
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
    expect(out.awaiting).toBe(0);
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
    expect(out.awaiting).toBe(0);
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

  it("reopens the wait when the owner nudges over a standing clean review", async () => {
    // A re-review request on an approved head: honoring the old verdict
    // while the answer is due again would let auto-merge take a PR the owner
    // just asked to have re-read. The nudge is newer than Codex's last word,
    // so the gate closes until the fresh answer lands.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      issueComments: { 1: [
        codexSummary(),
        { user: { login: OWNER }, created_at: "2026-08-14T12:10:00Z", body: "@codex review" },
      ] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(1);
    // The marker already says PENDING, so nothing is rewritten either.
    expect(out.written).toEqual([]);
  });

  it("restores success once a fresh clean review postdates the nudge", async () => {
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      issueComments: { 1: [
        codexSummary({ at: "2026-08-14T12:15:00Z" }),
        { user: { login: OWNER }, created_at: "2026-08-14T12:10:00Z", body: "@codex review" },
      ] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(0);
    expect(out.written[0].state).toBe("success");
  });

  it("stops approving when findings land after a clean review of the same head", async () => {
    // A clean review, then a findings review naming the SAME head: the
    // newer written word wins, or auto-merge would take a success with an
    // unaddressed finding standing.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      prReviews: { 1: [review("abc1234", undefined, "2026-08-14T12:09:00Z")] },
      issueComments: { 1: [codexSummary()] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const out = await runFull(fake);
    expect(out.written[0].description).toBe(FINDINGS);
  });

  it("approves on a clean review newer than the findings it answers", async () => {
    // The fix-and-nudge round: the old review still names this head, and
    // the fresh clean review is Codex saying it is satisfied.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      prReviews: { 1: [review()] },
      issueComments: { 1: [codexSummary({ at: "2026-08-14T12:15:00Z" })] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(0);
    expect(out.written[0].state).toBe("success");
  });

  it("fails closed when the clean review and the findings share a second", async () => {
    // GitHub stamps to the second, so a tie is an unresolved ordering —
    // the same rule the nudge tie follows: ambiguity must not be what
    // opens the gate.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      prReviews: { 1: [review()] },
      issueComments: { 1: [codexSummary()] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const out = await runFull(fake);
    expect(out.written[0].description).toBe(FINDINGS);
  });

  it("hears a nudge edited into an old comment", async () => {
    // An owner can ask for a re-review by editing "@codex review" into an
    // existing comment; its created_at then predates the head or the
    // standing clean review and the ask would be filtered out or read as answered.
    // The ask is dated by the later of creation and edit — erring toward
    // blocking on an owner's ask, the file's stated direction.
    const fake = fakeFetch({
      statuses: { abc1234: [
        gate("2026-08-14T12:00:00Z"),
        { context: "Vercel", state: "success", created_at: "2026-08-14T11:58:00Z" },
      ] },
      checkSuites: { abc1234: [{ created_at: "2026-08-14T11:58:30Z", head_branch: "claude/topic" }] },
      issueComments: { 1: [codexSummary({ at: "2026-08-14T12:15:00Z" }), {
        user: { login: OWNER },
        created_at: "2026-08-13T09:00:00Z",
        updated_at: "2026-08-14T12:30:00Z",
        body: "@codex review",
      }] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(1);
    // The head already carries `pending`; the point is that the edited-in
    // ask keeps the clean review from flipping it to success.
    expect(out.written).toEqual([]);
  });

  it("keeps a clean review of this commit across a force-push away and back", async () => {
    // The table names the commit, and the commit is the code: returning to
    // a commit Codex already found clean in this pull request is the same
    // code it read, so the verdict stands.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      issueComments: { 1: [codexSummary({ at: "2026-08-14T11:40:00Z" })] },
      graphqlResponses: [repoPRs([prNode({
        forcePushes: { nodes: [{ createdAt: "2026-08-14T12:00:00Z" }] },
      })])],
    });
    expect((await runFull(fake)).written[0].state).toBe("success");
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

  it("revokes a clean review dated before the newest timeline floor", async () => {
    // A retarget changes the diff without changing the commit, so a clean
    // review of the commit from before it read a different diff, and a base
    // change must not leave `codex: success` standing over it.
    const fake = fakeFetch({
      statuses: { abc1234: [gate("2026-08-14T11:50:00Z")] },
      issueComments: { 1: [codexSummary({ at: "2026-08-14T11:55:00Z" })] },
      graphqlResponses: [repoPRs([prNode({
        updatedAt: "2026-08-14T12:01:00Z",
        retargets: { nodes: [{ createdAt: "2026-08-14T12:00:00Z" }] },
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

  it("keeps approving when the clean review postdates the timeline floor", async () => {
    // The other direction, so the guard above cannot be satisfied by a rule
    // that simply refuses every pull request carrying one of these events:
    // Codex re-reading AFTER the retarget is the verdict we want honored.
    const fake = fakeFetch({
      statuses: { abc1234: [gate("2026-08-14T11:50:00Z")] },
      issueComments: { 1: [codexSummary({ at: "2026-08-14T12:03:00Z" })] },
      graphqlResponses: [repoPRs([prNode({
        updatedAt: "2026-08-14T12:04:00Z",
        retargets: { nodes: [{ createdAt: "2026-08-14T12:00:00Z" }] },
      })])],
    });
    const out = await runFull(fake);
    expect(out.written[0].state).toBe("success");
  });

  it("approves a fork head the table names", async () => {
    // The table names the commit, so a fork head needs no arrival dating:
    // it is judged like any other.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      issueComments: { 1: [codexSummary()] },
      graphqlResponses: [repoPRs([prNode({ isCrossRepository: true })])],
    });
    expect((await runFull(fake)).written[0].state).toBe("success");
  });

  it("reopens the wait on a nudge tied with the clean review to the second", async () => {
    // GitHub stamps to the second; a nudge in the same second as the
    // standing verdict is an unresolved ordering, and ambiguity must not be
    // what leaves a success open for auto-merge.
    const fake = fakeFetch({
      statuses: { abc1234: [gate("2026-08-14T12:00:00Z")] },
      issueComments: { 1: [
        codexSummary(),
        { user: { login: OWNER }, created_at: AFTER, body: "@codex review" },
      ] },
      graphqlResponses: [repoPRs([prNode()])],
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

  it("hears a nudge hidden behind a future-dated commit", async () => {
    // The commit date is author-controlled; forged past the owner's
    // "@codex review" it would filter the nudge out of the walk, and on an
    // approved head that fails OPEN — a stale success left for auto-merge.
    // The walk bound is the EARLIER of the commit date and the head's first
    // server-stamped status, so the forged date only ever loses.
    const future = { nodes: [{ commit: { committedDate: "2026-08-14T13:00:00Z" } }] };
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      issueComments: { 1: [
        codexSummary(),
        { user: { login: OWNER }, created_at: "2026-08-14T12:10:00Z", body: "@codex review" },
      ] },
      graphqlResponses: [repoPRs([prNode({ commits: future })])],
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

  it("parks a re-read of a head with findings until the table says it is done", async () => {
    // Running outranks the old findings: the answer is being rewritten,
    // and the table's edit to Completed is the wake.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      prReviews: { 1: [review()] },
      issueComments: { 1: [codexSummary({ status: "running", at: "2026-08-14T12:10:00Z" })] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    const out = await runFull(fake);
    expect(out.awaiting).toBe(0);
    // PENDING, not FINDINGS — the marker already says PENDING, so no write.
    expect(out.written).toEqual([]);
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
        repoPRs([prNode({ number: 1 }), prNode({ number: 2 })]),
      ],
    });
    const out = await run(fake);
    expect(out.map((w) => w.state)).toEqual(["failure", "failure"]);
    // The set settled it, so no reaction lookup was needed.
    expect(fake.calls.filter((c) => c.path === "/graphql")).toHaveLength(1);
  });

  it("still judges PRs whose heads are distinct", async () => {
    const fake = fakeFetch({
      // bbb1234 has no marker yet, so its first gating is this sweep.
      statuses: { aaa1234: [gate()] },
      issueComments: { 1: [codexSummary({ commit: "aaa1234" })] },
      graphqlResponses: [
        repoPRs([
          prNode({ number: 1, headRefOid: "aaa1234" }),
          prNode({ number: 2, headRefOid: "bbb1234" }),
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
        issueComments: { 1: [codexSummary()] },
        graphqlResponses: [repoPRs([prNode()])],
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

  it("tells a fork head the same remedy as any other", async () => {
    // A fork head's verdict names its commit like any other, so a
    // re-review settles it and the one remedy holds.
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
      { number: 1, state: "pending", description: UNANSWERED },
    ]);
  });

  it("replaces a legacy fork marker a commit still wears", async () => {
    // Not replayed: the wording an earlier version wrote on fork heads is
    // replaced by an ordinary PENDING, which starts the head a fresh window.
    const asFork = await sweep({
      owner: OWNER, name: "r", token: "t",
      fetchImpl: fakeFetch({
        statuses: { abc1234: [gate("2026-08-14T11:00:00Z", "pending", LEGACY_FORK_MARKER)] },
        graphqlResponses: [repoPRs([prNode({ isCrossRepository: true })])],
      }).impl,
      log: () => {}, now: () => Date.parse("2026-08-14T12:31:00Z"),
    });
    expect(asFork.awaiting).toBe(1);
    expect(asFork.written).toEqual([
      { number: 1, state: "pending", description: PENDING },
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
        statuses: { abc1234: [gate("2026-08-14T11:00:00Z", "pending", LEGACY_FORK_MARKER)] },
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
    // A fresh branch suite must not rewrite an accurate FINDINGS to PENDING
    // -- reopening the gate's wording on a head Codex has actually
    // answered. Only the marker this loop wrote itself is safe to take back.
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
    expect(kept.awaiting).toBe(0);
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

  it("parks a head past the window whatever Codex's 👀 says", async () => {
    // A 👀 names no review, so it does not keep the clock: a review that is
    // genuinely running says so in the table, whose edit is the wake.
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
    expect(out.awaiting).toBe(0);
    expect(out.written).toEqual([{ number: 1, state: "pending", description: UNANSWERED }]);
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
// A generated-only push: the lanes engine has published a green on the head
// saying it carried the previous head's verdict, and the sweep inherits
// Codex's answer on that head rather than waiting for a re-read of files CI
// wrote back.

// A Codex security finding as GraphQL returns its thread: the root comment
// carries the marker, and the bot's login arrives bare, as it does on every
// GraphQL actor.
const SECURITY_BODY = [
  "<!-- codex-security-review-finding:v1 -->",
  "",
  "### 🛡️ Codex Security Review · _Automatically triggered_",
  "",
  "**P1 Badge Security: Check the input before trusting it**",
].join("\n");
const thread = ({ isResolved = false, login = CODEX_BOT, body = SECURITY_BODY } = {}) => ({
  isResolved,
  comments: { nodes: [{ author: { login }, body }] },
});
const CODE_FINDING = "**P1 Badge Handle the empty case**\n\nUseful? React with 👍 / 👎.";
// A head Codex has approved with a 👍, and these threads on its pull request.
const approvedWith = (threads, over = {}) => fakeFetch({
  statuses: { abc1234: [gate()] },
  checkSuites: { abc1234: [bornSuite()] },
  issueComments: { 1: [codexSummary()] },
  graphqlResponses: [repoPRs([prNode()])],
  reviewThreads: { 1: threads },
  ...over,
});
const threadReads = (fake) =>
  fake.calls.filter((c) => c.path === "/graphql" && c.body.query.includes("reviewThreads"));

describe("isSecurityFinding", () => {
  it("knows a finding by its marker or by its heading", () => {
    expect(isSecurityFinding(SECURITY_BODY)).toBe(true);
    // Either alone is enough, so Codex dropping one leaves the finding
    // blocking rather than silently not.
    expect(isSecurityFinding("<!-- codex-security-review-finding:v1 -->")).toBe(true);
    expect(isSecurityFinding("### 🛡️ Codex Security Review · _Requested_")).toBe(true);
  });

  it("does not take a code-review finding for one", () => {
    expect(isSecurityFinding(CODE_FINDING)).toBe(false);
    expect(isSecurityFinding(null)).toBe(false);
  });
});

describe("unresolvedSecurityFindings", () => {
  const api = (nodes) => ({
    graphql: async () => ({ repository: { pullRequest: { reviewThreads: page(nodes) } } }),
  });

  it("counts Codex's unresolved security threads and nothing else", async () => {
    const n = await unresolvedSecurityFindings(api([
      thread(),
      thread(),
      thread({ isResolved: true }),
      thread({ body: CODE_FINDING }),
      thread({ login: "someone" }),
      // A deleted root comment, and a root whose author's account is gone.
      { isResolved: false, comments: { nodes: [] } },
      { isResolved: false, comments: { nodes: [{ author: null, body: SECURITY_BODY }] } },
    ]), { owner: OWNER, name: "r", number: 1 });
    expect(n).toBe(2);
  });

  it("refuses to read a missing thread list as an empty one", async () => {
    // Zero is what approves, so a response without the connection has to
    // fail the read rather than count as nothing found.
    const empty = { graphql: async () => ({ repository: { pullRequest: null } }) };
    let threw = false;
    try {
      await unresolvedSecurityFindings(empty, { owner: OWNER, name: "r", number: 1 });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("sweep, with a Codex security finding on the pull request", () => {
  it("withholds success from a later head while the finding is unresolved", async () => {
    // The case this exists for: the security review ran on an earlier
    // commit, so nothing on this head mentions it, and the 👍 is genuine.
    const fake = approvedWith([thread()]);
    expect(await run(fake)).toEqual([
      { number: 1, state: "pending", description: SECURITY },
    ]);
  });

  it("approves once the finding's thread is resolved", async () => {
    const fake = approvedWith([thread({ isResolved: true })]);
    expect((await run(fake))[0].state).toBe("success");
  });

  it("leaves a code-review thread to the head's own verdict", async () => {
    // Code findings are judged per head, and Codex re-reads every push; only
    // the security review, which does not, needs the pull-request-wide read.
    const fake = approvedWith([thread({ body: CODE_FINDING })]);
    expect((await run(fake))[0].state).toBe("success");
  });

  it("ignores the marker on a thread someone else opened", async () => {
    const fake = approvedWith([thread({ login: "someone" })]);
    expect((await run(fake))[0].state).toBe("success");
  });

  it("reads the threads to the last page", async () => {
    const codeThreads = Array.from({ length: 100 }, () => thread({ body: CODE_FINDING }));
    const fake = approvedWith([...codeThreads, thread()]);
    expect((await run(fake))[0].description).toBe(SECURITY);
    expect(threadReads(fake).length).toBe(2);
  });

  it("reads no threads for a head that is not about to be approved", async () => {
    // The verdict is pending either way, so the read could not change it.
    const fake = fakeFetch({
      graphqlResponses: [repoPRs([prNode()])],
      reviewThreads: { 1: [thread()] },
    });
    expect(await run(fake)).toEqual([{ number: 1, state: "pending", description: PENDING }]);
    expect(threadReads(fake)).toEqual([]);
  });

  it("keeps the head on the clock, since resolving a thread wakes nothing", async () => {
    // Resolution emits no event the listener relays, so an idle loop would
    // leave the approval to the four-hourly schedule.
    const fake = approvedWith([thread()]);
    expect((await runFull(fake)).awaiting).toBe(1);
  });

  it("fails the head, rather than approving, when the thread read fails", async () => {
    const fake = approvedWith([thread()]);
    const failing = {
      ...fake,
      impl: async (url, opts = {}) => {
        if (opts.body && JSON.parse(opts.body).query?.includes("reviewThreads")) {
          return { ok: true, status: 200, json: async () => ({ errors: [{ message: "boom" }] }) };
        }
        return fake.impl(url, opts);
      },
    };
    const { written, failed } = await runFull(failing);
    expect(written.filter((w) => w.state === "success")).toEqual([]);
    expect(failed.length).toBe(1);
  });
});

describe("sweep, when a collaborator asks for a re-review", () => {
  const ask = (created_at, author_association = "COLLABORATOR") =>
    ({ user: { login: "collaborator" }, author_association, created_at, body: "@codex review" });

  it("keeps a head with findings on the clock until Codex answers the ask", async () => {
    // Codex may answer with a 👍, which no webhook announces, so settling
    // the head on its findings would leave that 👍 to the schedule.
    const withAsk = (comments) => runFull(fakeFetch({
      statuses: { abc1234: [gate("2026-08-14T12:05:10Z", "pending", FINDINGS), gate()] },
      prReviews: { 1: [review()] },
      issueComments: { 1: comments },
      graphqlResponses: [repoPRs([prNode()])],
    }));
    const asked = await withAsk([ask("2026-08-14T12:05:30Z")]);
    expect(asked.awaiting).toBe(1);
    // The ask wakes the clock but does not move the verdict.
    expect(asked.written).toEqual([]);
    // Without it, or with a passer-by's, the findings settle the head.
    expect((await withAsk([])).awaiting).toBe(0);
    expect((await withAsk([ask("2026-08-14T12:05:30Z", "NONE")])).awaiting).toBe(0);
  });

  it("does not hold an approved head", async () => {
    // Only the owner's nudge closes the gate over a standing verdict;
    // anyone else's would be a merge block for whoever can comment.
    const fake = fakeFetch({
      statuses: { abc1234: [gate()] },
      issueComments: { 1: [codexSummary(), ask("2026-08-14T12:10:00Z")] },
      graphqlResponses: [repoPRs([prNode()])],
    });
    expect((await run(fake))[0].state).toBe("success");
  });

  it("takes a parked head back onto the clock", async () => {
    // The UNANSWERED description tells whoever reads it to comment
    // `@codex review`. A collaborator doing so now gets the same restart
    // the owner's nudge does.
    const after = (comments) => sweep({
      owner: OWNER, name: "r", token: "t",
      fetchImpl: fakeFetch({
        statuses: { abc1234: [gate("2026-08-14T12:40:00Z", "pending", UNANSWERED), gate("2026-08-14T12:00:00Z")] },
        issueComments: { 1: comments },
        graphqlResponses: [repoPRs([prNode()])],
      }).impl,
      log: () => {}, now: () => Date.parse("2026-08-14T12:45:00Z"),
    });
    const asked = await after([ask("2026-08-14T12:44:00Z")]);
    expect(asked.awaiting).toBe(1);
    expect(asked.written).toEqual([{ number: 1, state: "pending", description: PENDING }]);
    // An ask the park already waited out stays accounted for.
    const old = await after([ask("2026-08-14T12:05:00Z")]);
    expect(old.awaiting).toBe(0);
    expect(old.written).toEqual([]);
  });
});

const FROM = "aaa1111";
const FROM_FULL = "aaa1111000000000000000000000000000000000";
const LANES_APP = { login: "lanes-app[bot]", type: "Bot" };
const CARRIED = `Codex reviewed ${FROM}; verdict carried across generated files`;
// The engine's own wording, with the base marker it appends.
const lanesCarry = (over = {}) => ({
  context: "lanes",
  state: "success",
  description: `Generated-only push; verdict carried forward from ${FROM}. [base 0beef12]`,
  creator: LANES_APP,
  created_at: AFTER,
  ...over,
});
// The base branch's effective rules, binding `lanes` to App 42.
const bindLanesTo = (integration_id) => [{
  type: "required_status_checks",
  parameters: { required_status_checks: [{ context: "lanes", integration_id }, { context: "codex" }] },
}];
// The named head's combined status: this action's own last word there.
// `publish` stamps every success with the pull request that earned it, and
// the carry reads that stamp back: the fixture's source verdict was earned
// by #1, the pull request every carry test carries onto.
const earnedBy = (number) => `Codex reviewed this head, no findings (#${number})`;
const fromStatus = (state = "success", created_at = BEFORE, creator = undefined, description = earnedBy(1)) => ({
  [FROM]: {
    sha: FROM_FULL,
    statuses: [{ context: CONTEXT, state, created_at, description, ...(creator ? { creator } : {}) }],
  },
});
// The named head's tenure on the branch, and this head's own arrival there
// after the approval: the two suites every carry needs.
const SOURCE_SUITE = bornSuite("2026-08-14T10:30:00Z", "claude/topic");
const HEAD_SUITE = { abc1234: [bornSuite("2026-08-14T11:30:00Z", "claude/topic")] };
// The claim posted later than AFTER, for cases whose source approval is
// stamped AFTER: a claim tied with the approval refuses on its own, and
// this head has to arrive after that approval too.
const claimedLater = {
  statuses: { abc1234: [gate(), lanesCarry({ created_at: "2026-08-14T12:10:00Z" })] },
  checkSuites: { [FROM_FULL]: [SOURCE_SUITE], abc1234: [bornSuite("2026-08-14T12:07:00Z", "claude/topic")] },
};
const carryFake = (over = {}) => fakeFetch({
  statuses: { abc1234: [gate(), lanesCarry()] },
  branchRules: bindLanesTo(42),
  apps: { "lanes-app": { id: 42, slug: "lanes-app" } },
  combined: fromStatus(),
  prCommits: { 1: [{ sha: FROM_FULL }, { sha: "abc1234" }], 2: [{ sha: FROM_FULL }, { sha: "def5678" }] },
  // The named head reached this branch before it was approved, and this
  // head after.
  checkSuites: { [FROM_FULL]: [SOURCE_SUITE], ...HEAD_SUITE },
  graphqlResponses: [repoPRs([prNode({ baseRefName: "main" })])],
  ...over,
});

// The head's standing `codex` status is PENDING, so a refused carry writes
// nothing at all: "not carried" is the absence of a success write.
// A refusal, never a failed head: the reason is logged and the head keeps
// its ordinary path.
const notCarried = async (fake) => {
  const { written, failed } = await runFull(fake);
  expect(failed).toEqual([]);
  expect(written.filter((w) => w.state === "success")).toEqual([]);
  return written;
};

describe("sweep, carrying a verdict across a generated push", () => {
  it("carries Codex's verdict onto a head the lanes App vouched for", async () => {
    const fake = carryFake();
    expect((await run(fake))[0]).toEqual({ number: 1, state: "success", description: CARRIED });
    // Read in that order: the base's rules, the App behind the claim, the
    // named head's own status — then the reviews of that head and both
    // comment streams from that status on, so nothing that landed after it
    // can ride the carry.
    const paths = fake.calls.map((c) => c.path);
    expect(paths).toContain("/repos/o/r/rules/branches/main");
    expect(paths).toContain("/apps/lanes-app");
    expect(paths).toContain(`/repos/o/r/commits/${FROM}/status`);
    expect(paths.some((p) => p.includes("/pulls/1/commits"))).toBe(true);
    expect(paths.some((p) => p.includes(`/commits/${FROM_FULL}/check-suites`))).toBe(true);
    // Only the NAMED head's suites: this head's own arrival is no longer
    // read, since the stamp on the source status says which pull request
    // earned it and a suite's birth never could.
    expect(paths.some((p) => p.includes("/commits/abc1234/check-suites"))).toBe(false);
    expect(paths.some((p) => p.includes("/pulls/1/reviews"))).toBe(true);
    // The walk's bound is the second before the status, so a tie is seen.
    const bound = encodeURIComponent("2026-08-14T10:59:59Z");
    expect(paths.some((p) => p.includes(`/issues/1/comments?since=${bound}`))).toBe(true);
    expect(paths.some((p) => p.includes(`/pulls/1/comments?since=${bound}`))).toBe(true);
  });

  it("does not carry a verdict over an unresolved security finding", async () => {
    // The carry vouches for a head; the finding is about the pull request,
    // so the generated push that carries one cannot answer the other.
    const fake = carryFake({ reviewThreads: { 1: [thread()] } });
    expect(await run(fake)).toEqual([{ number: 1, state: "pending", description: SECURITY }]);
  });

  it("reads nothing extra for a head whose lanes verdict is its own", async () => {
    // A fresh green, a docs skip, a pending: none is a claim, so none costs
    // a rules read — and the head takes the ordinary path.
    const fake = carryFake({
      statuses: { abc1234: [gate(), lanesCarry({ description: "Every required job passed. [base 0beef12]" })] },
    });
    expect(await notCarried(fake)).toEqual([]);
    expect(fake.calls.some((c) => c.path.includes("/rules/") || c.path.startsWith("/apps/") || c.path.endsWith("/status"))).toBe(false);
  });

  it("refuses a claim posted by the workflow bot", async () => {
    // Any pull request's own workflow can post a `lanes` status with that
    // token; the claim has to come from an App.
    const fake = carryFake({
      statuses: { abc1234: [gate(), lanesCarry({ creator: { login: "github-actions[bot]", type: "Bot" } })] },
    });
    await notCarried(fake);
    expect(fake.calls.some((c) => c.path.includes("/rules/"))).toBe(false);
    const human = carryFake({
      statuses: { abc1234: [gate(), lanesCarry({ creator: { login: "someone", type: "User" } })] },
    });
    await notCarried(human);
  });

  it("refuses a claim from an App other than the one the base's rules bind lanes to", async () => {
    const fake = carryFake({ apps: { "lanes-app": { id: 43 } } });
    await notCarried(fake);
    // The claim's author is settled before anything about the named head is read.
    expect(fake.calls.some((c) => c.path.endsWith("/status"))).toBe(false);
    const unknown = carryFake({ apps: {} });
    await notCarried(unknown);
  });

  it("refuses every claim where the rules bind lanes to no App", async () => {
    // The carry is opt-in per repository, by the ruleset binding the
    // required check to the App: until then any workflow with
    // `statuses: write` could post the claim, so none is trusted, and the
    // App behind the claim is never even read.
    const fake = carryFake({ branchRules: [] });
    await notCarried(fake);
    expect(fake.calls.some((c) => c.path.startsWith("/apps/"))).toBe(false);
    await notCarried(carryFake({ branchRules: bindLanesTo(undefined) }));
  });

  it("logs why a carry was refused", async () => {
    const lines = [];
    const fake = carryFake({ combined: {} });
    await sweep({ owner: OWNER, name: "r", token: "t", fetchImpl: fake.impl, log: (l) => lines.push(l), now: TEST_NOW });
    expect(lines.some((l) => l.includes(`lanes carries ${FROM}`) && l.includes("not carrying"))).toBe(true);
  });

  it("binds the carried verdict to this pull request", async () => {
    // A status belongs to the commit, which may have been another pull
    // request's head first: the verdict has to name this pull request,
    // postdate its creation and latest retarget, and sit on one of its
    // own commits.
    const opened = carryFake({
      graphqlResponses: [repoPRs([prNode({ baseRefName: "main", createdAt: AFTER })])],
    });
    await notCarried(opened);
    const tied = carryFake({
      graphqlResponses: [repoPRs([prNode({ baseRefName: "main", createdAt: BEFORE })])],
    });
    await notCarried(tied);
    const unknown = carryFake({
      graphqlResponses: [repoPRs([prNode({ baseRefName: "main", createdAt: undefined })])],
    });
    await notCarried(unknown);
    // Retargeted after the source verdict, though before the claim.
    const retargeted = carryFake({
      graphqlResponses: [repoPRs([prNode({
        baseRefName: "main",
        retargets: page([{ createdAt: "2026-08-14T11:30:00Z" }]),
      })])],
    });
    await notCarried(retargeted);
    // Not one of this pull request's commits.
    const foreign = carryFake({ prCommits: { 1: [{ sha: "abc1234" }] } });
    await notCarried(foreign);
    // Its commit, but never recorded as this branch's head before the
    // approval: no suite, a suite on another branch, one born after.
    await notCarried(carryFake({ checkSuites: {} }));
    await notCarried(carryFake({ checkSuites: { ...HEAD_SUITE, [FROM_FULL]: [bornSuite("2026-08-14T10:30:00Z", "other")] } }));
    await notCarried(carryFake({ checkSuites: { ...HEAD_SUITE, [FROM_FULL]: [bornSuite(AFTER, "claude/topic")] } }));
    await notCarried(carryFake({ checkSuites: { ...HEAD_SUITE, [FROM_FULL]: [bornSuite(BEFORE, "claude/topic")] } }));
    // A suite from an earlier tenure of the branch is not tenure: the
    // lookup is floored at the branch's last force-push, as `judge` floors
    // every birth, so the re-arrival's own suite is what has to predate
    // the approval.
    const forced = (createdAt) => ({ forcePushes: page([{ createdAt }]) });
    await notCarried(carryFake({
      graphqlResponses: [repoPRs([prNode({ baseRefName: "main", ...forced("2026-08-14T10:45:00Z") })])],
    }));
    const returned = carryFake({
      graphqlResponses: [repoPRs([prNode({ baseRefName: "main", ...forced("2026-08-14T10:45:00Z") })])],
      checkSuites: { ...HEAD_SUITE, [FROM_FULL]: [
        bornSuite("2026-08-14T10:30:00Z", "claude/topic"),
        bornSuite("2026-08-14T10:50:00Z", "claude/topic"),
      ] },
    });
    expect((await run(returned))[0].state).toBe("success");
    // And earned by THIS pull request, which the source status says of
    // itself: `publish` stamps every success with the number, and only
    // ever writes on that pull request's own head. Another pull request's
    // stamp, and an unstamped status from before this was recorded, both
    // refuse -- the second fail-closed, since nothing distinguishes it.
    await notCarried(carryFake({ combined: fromStatus("success", BEFORE, undefined, earnedBy(2)) }));
    await notCarried(carryFake({ combined: fromStatus("success", BEFORE, undefined, "Codex reviewed this head, no findings") }));
    await notCarried(carryFake({ combined: fromStatus("success", BEFORE, undefined, null) }));
    // This head's arrival is NOT read any more: a check suite is born after
    // the push it belongs to, so its birth could never prove the approval
    // came first -- the stamp does, by record (Codex round 9).
    const noHeadSuite = carryFake({ checkSuites: { [FROM_FULL]: [SOURCE_SUITE] } });
    expect((await run(noHeadSuite))[0].state).toBe("success");
    // Floored at the pull request's opening too: a suite from before it
    // opened (the branch held the named head, opened on an ancestor, and
    // fast-forwarded back -- no force-push to floor at) is not tenure.
    await notCarried(carryFake({ checkSuites: { ...HEAD_SUITE, [FROM_FULL]: [bornSuite("2026-08-14T09:30:00Z", "claude/topic")] } }));
    // A fork head has no branch-born suite and fails closed here too.
    await notCarried(carryFake({
      graphqlResponses: [repoPRs([prNode({ baseRefName: "main", headRefName: null })])],
    }));
    // On a later page of a long pull request, still its own.
    const long = carryFake({
      prCommits: { 1: [...Array.from({ length: 100 }, (_, i) => ({ sha: `c${i}` })), { sha: FROM_FULL }] },
    });
    expect((await run(long))[0].state).toBe("success");
  });

  it("holds the source status to the App the rules bind codex to", async () => {
    // A forged `codex: success` on the source, from a writer branch
    // protection would refuse, must not be republished under this action's
    // own identity.
    const both = [{
      type: "required_status_checks",
      parameters: { required_status_checks: [{ context: "lanes", integration_id: 42 }, { context: CONTEXT, integration_id: 15368 }] },
    }];
    const actions = { login: "github-actions[bot]", type: "Bot" };
    const apps = { "lanes-app": { id: 42, slug: "lanes-app" }, "github-actions": { id: 15368, slug: "github-actions" }, other: { id: 7 } };
    const genuine = carryFake({ branchRules: both, apps, combined: fromStatus("success", BEFORE, actions) });
    expect((await run(genuine))[0].state).toBe("success");
    await notCarried(carryFake({ branchRules: both, apps, combined: fromStatus("success", BEFORE, { login: "other[bot]", type: "Bot" }) }));
    await notCarried(carryFake({ branchRules: both, apps, combined: fromStatus("success", BEFORE, { login: "someone", type: "User" }) }));
    await notCarried(carryFake({ branchRules: both, apps, combined: fromStatus() }));
    // Unbound, the status is whichever writer the repository trusts for it.
    expect((await run(carryFake({ combined: fromStatus("success", BEFORE, { login: "someone", type: "User" }) })))[0].state).toBe("success");
  });

  it("refuses a source approval posted at or after the claim", async () => {
    // The claim vouches for the verdict that existed when it was posted;
    // one another pull request earned on the same commit later does not
    // ride it, and a tie is an unresolved order.
    await notCarried(carryFake({ combined: fromStatus("success", "2026-08-14T12:10:00Z") }));
    await notCarried(carryFake({ combined: fromStatus("success", AFTER) }));
  });

  it("refuses when the named head was never approved", async () => {
    await notCarried(carryFake({ combined: fromStatus("pending") }));
    await notCarried(carryFake({ combined: {} }));
    const bare = carryFake({ combined: { [FROM]: { sha: FROM_FULL, statuses: [] } } });
    await notCarried(bare);
  });

  it("refuses when Codex reviewed the named head after its status was written", async () => {
    // The status was this action's last word before the push; a finding
    // between the two must not ride the carry.
    const fake = carryFake({ prReviews: { 1: [review(FROM_FULL, `${CODEX_BOT}[bot]`, AFTER)] } });
    await notCarried(fake);
    // A review in the status's own second is an unresolved order, and a
    // tie is stale here as everywhere else.
    const tied = carryFake({
      ...claimedLater,
      combined: fromStatus("success", AFTER),
      prReviews: { 1: [review(FROM_FULL, `${CODEX_BOT}[bot]`, AFTER)] },
    });
    await notCarried(tied);
    // A review OLDER than the status is what the status already priced in.
    const priced = carryFake({
      ...claimedLater,
      combined: fromStatus("success", AFTER),
      prReviews: { 1: [review(FROM_FULL, `${CODEX_BOT}[bot]`, BEFORE)] },
    });
    expect((await run(priced))[0].state).toBe("success");
  });

  it("refuses a claim older than the pull request's latest retarget", async () => {
    // The head and its statuses stand still through a retarget while the
    // reviewed diff changes; the ordinary path floors every signal at it.
    const retargeted = carryFake({
      graphqlResponses: [repoPRs([prNode({
        baseRefName: "main",
        retargets: page([{ createdAt: "2026-08-14T12:06:00Z" }]),
      })])],
    });
    await notCarried(retargeted);
    expect(retargeted.calls.some((c) => c.path.includes("/rules/"))).toBe(false);
    // A tie is stale too.
    const tied = carryFake({
      graphqlResponses: [repoPRs([prNode({ baseRefName: "main", retargets: page([{ createdAt: AFTER }]) })])],
    });
    await notCarried(tied);
    // A claim posted after the retarget vouches for the current diff --
    // and so does the source verdict, earned after it too.
    const fresh = carryFake({
      graphqlResponses: [repoPRs([prNode({
        baseRefName: "main",
        retargets: page([{ createdAt: "2026-08-14T10:30:00Z" }]),
      })])],
    });
    expect((await run(fresh))[0].state).toBe("success");
  });

  it("refuses when Codex commented, or the owner nudged, after the named head was approved", async () => {
    // Either lands between the last sweep's success and the push, so the
    // status never saw it and the new head's own walk starts after it.
    const codexComment = { user: { login: `${CODEX_BOT}[bot]` }, body: "Found a problem.", created_at: AFTER };
    await notCarried(carryFake({ issueComments: { 1: [codexComment] } }));
    await notCarried(carryFake({ reviewThreadComments: { 1: [codexComment] } }));
    const nudge = { user: { login: OWNER }, body: "@codex review", created_at: AFTER, updated_at: AFTER };
    await notCarried(carryFake({ reviewThreadComments: { 1: [nudge] } }));
    // In the status's own second, both are ties, and a tie refuses.
    await notCarried(carryFake({ ...claimedLater, combined: fromStatus("success", AFTER), issueComments: { 1: [codexComment] } }));
    await notCarried(carryFake({ ...claimedLater, combined: fromStatus("success", AFTER), reviewThreadComments: { 1: [nudge] } }));
    // Before the status, both are what the status already priced in.
    const earlier = carryFake({
      ...claimedLater,
      combined: fromStatus("success", AFTER),
      issueComments: { 1: [{ ...codexComment, created_at: BEFORE }, { ...nudge, created_at: BEFORE, updated_at: BEFORE }] },
    });
    expect((await run(earlier))[0].state).toBe("success");
    // A clean comment naming the named head is the verdict restated.
    const clean = {
      user: { login: `${CODEX_BOT}[bot]` },
      created_at: AFTER,
      body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${FROM}\`\n\n<details>x</details>`,
    };
    expect((await run(carryFake({ issueComments: { 1: [clean] } })))[0].state).toBe("success");
  });

  it("lets a clean verdict answer a nudge or a finding the status never saw", async () => {
    // The status does not move when Codex re-reads and passes -- `publish`
    // leaves an identical success alone -- so the newest word about the
    // named head decides, as it does on the ordinary path. Without this a
    // nudge Codex has already answered costs the carry and buys a
    // redundant re-review (Codex round 8). The exchange sits between the
    // source approval and this head's own walk, so only the carry reads it.
    const APPROVED = "2026-08-14T10:50:00Z";
    const ASKED = "2026-08-14T10:55:00Z";
    const ANSWERED = "2026-08-14T10:58:00Z";
    const nudgeAt = (at) => ({ user: { login: OWNER }, body: "@codex review", created_at: at, updated_at: at });
    const cleanAt = (at) => ({
      user: { login: `${CODEX_BOT}[bot]` },
      created_at: at,
      body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${FROM}\`\n\n<details>x</details>`,
    });
    const exchange = (over) => carryFake({
      combined: fromStatus("success", APPROVED),
      checkSuites: { [FROM_FULL]: [bornSuite("2026-08-14T10:40:00Z", "claude/topic")], ...HEAD_SUITE },
      ...over,
    });
    // Nudged, then answered: the carry stands.
    expect((await run(exchange({ issueComments: { 1: [nudgeAt(ASKED), cleanAt(ANSWERED)] } })))[0].state).toBe("success");
    // Findings on the named head, answered the same way.
    expect((await run(exchange({
      prReviews: { 1: [review(FROM_FULL, `${CODEX_BOT}[bot]`, ASKED)] },
      issueComments: { 1: [cleanAt(ANSWERED)] },
    })))[0].state).toBe("success");
    // The other way round -- asked after the answer -- still refuses, and
    // so does a tie.
    await notCarried(exchange({ issueComments: { 1: [cleanAt(ASKED), nudgeAt(ANSWERED)] } }));
    await notCarried(exchange({ issueComments: { 1: [cleanAt(ANSWERED), nudgeAt(ANSWERED)] } }));
    // A clean verdict naming another head answers nothing.
    await notCarried(exchange({
      issueComments: { 1: [nudgeAt(ASKED), { ...cleanAt(ANSWERED), body: cleanAt(ANSWERED).body.replace(FROM, "bbb2222") }] },
    }));
  });

  it("holds the carry below findings Codex left on this head", async () => {
    const fake = carryFake({ prReviews: { 1: [review("abc1234")] } });
    expect((await run(fake))[0]).toEqual({ number: 1, state: "pending", description: FINDINGS });
  });

  it("holds the carry below an owner nudge and a hold", async () => {
    const nudged = carryFake({
      issueComments: { 1: [{ user: { login: OWNER }, body: "@codex review", created_at: AFTER, updated_at: AFTER }] },
    });
    expect(await notCarried(nudged)).toEqual([]);
    const held = carryFake({
      graphqlResponses: [repoPRs([prNode({ baseRefName: "main", reactions: page([hold()]) })])],
    });
    expect((await run(held))[0].state).toBe("failure");
    // Held settles without reading the claim at all.
    expect(held.calls.some((c) => c.path.includes("/rules/"))).toBe(false);
  });

  it("carries through Codex's own re-read of the generated head", async () => {
    // The 👀 is Codex re-reading images; the carry is what survives it.
    const eyes = { content: "EYES", createdAt: AFTER, user: { login: `${CODEX_BOT}[bot]` } };
    const fake = carryFake({
      graphqlResponses: [repoPRs([prNode({ baseRefName: "main", reactions: page([eyes]) })])],
    });
    expect((await run(fake))[0]).toEqual({ number: 1, state: "success", description: CARRIED });
    // Success: the head is settled, nothing left to poll for.
    expect((await runFull(carryFake())).awaiting).toBe(0);
  });

  it("fails a shared head closed whatever it inherits", async () => {
    const fake = carryFake({
      graphqlResponses: [repoPRs([
        prNode({ baseRefName: "main" }),
        prNode({ number: 2, baseRefName: "main" }),
      ])],
    });
    const written = await run(fake);
    expect(written.every((w) => w.state === "failure")).toBe(true);
    expect(fake.calls.some((c) => c.path.includes("/rules/"))).toBe(false);
  });

  it("reads the base's rules and the App once per sweep, not per head", async () => {
    // Each pull request carries from its OWN source: one commit cannot have
    // been the head of both when it was approved, and the stamp says which.
    const OTHER = "bbb2222";
    const OTHER_FULL = "bbb2222000000000000000000000000000000000";
    const fake = carryFake({
      statuses: {
        abc1234: [gate(), lanesCarry()],
        def5678: [gate(), lanesCarry({
          description: `Generated-only push; verdict carried forward from ${OTHER}. [base 0beef12]`,
        })],
      },
      combined: {
        ...fromStatus(),
        [OTHER]: {
          sha: OTHER_FULL,
          statuses: [{ context: CONTEXT, state: "success", created_at: BEFORE, description: earnedBy(2) }],
        },
      },
      prCommits: { 1: [{ sha: FROM_FULL }, { sha: "abc1234" }], 2: [{ sha: OTHER_FULL }, { sha: "def5678" }] },
      checkSuites: {
        ...HEAD_SUITE,
        def5678: [bornSuite("2026-08-14T11:30:00Z", "claude/other")],
        [FROM_FULL]: [bornSuite("2026-08-14T10:30:00Z", "claude/topic")],
        [OTHER_FULL]: [bornSuite("2026-08-14T10:30:00Z", "claude/other")],
      },
      graphqlResponses: [repoPRs([
        prNode({ baseRefName: "main" }),
        prNode({ number: 2, headRefOid: "def5678", headRefName: "claude/other", baseRefName: "main" }),
      ])],
    });
    const written = await run(fake);
    expect(written.map((w) => w.state)).toEqual(["success", "success"]);
    expect(fake.calls.filter((c) => c.path.includes("/rules/")).length).toBe(1);
    expect(fake.calls.filter((c) => c.path.startsWith("/apps/")).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The workflow holds `statuses: write`, and its safety is largely the
// *absence* of something — a checkout, a branch-selectable trigger, a second
// writer — which nothing else would notice going missing.

describe("authenticating as a GitHub App", () => {
  // The private key never has to be real: the signature is the one thing
  // this file does not compute itself, so it is injected and asserted on
  // rather than verified. What the tests are for is everything around it --
  // the claims, the exchange, and what happens when either half is missing.
  const sign = (input, key) => Buffer.from(`sig(${input.length},${key})`);
  const decode = (part) => JSON.parse(Buffer.from(part, "base64url").toString());

  it("signs a JWT the App API will accept", () => {
    const jwt = signAppJwt(1234, "KEY", 1_000_000, sign);
    const [header, payload, signature] = jwt.split(".");
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    // Backdated for clock drift: an `iat` GitHub reads as still in the
    // future is rejected outright, and a fast runner clock is not this
    // file's to fix. `exp` is GitHub's own maximum for an App JWT.
    expect(decode(payload)).toEqual({ iat: 999_940, exp: 1_000_600, iss: "1234" });
    // The issuer is a string even when the input is a number, which is what
    // the API requires.
    expect(typeof decode(payload).iss).toBe("string");
    expect(Buffer.from(signature, "base64url").toString()).toBe(`sig(${header.length + payload.length + 1},KEY)`);
    expect(signature.includes("+")).toBe(false);
    expect(signature.includes("/")).toBe(false);
  });

  const exchange = (over = {}) => {
    const calls = [];
    const responses = {
      "/repos/o/r/installation": { ok: true, status: 200, json: async () => ({ id: 99, app_slug: "codex-verdict" }) },
      "/app/installations/99/access_tokens": { ok: true, status: 201, json: async () => ({ token: "ghs_minted" }) },
      ...over,
    };
    const fetchImpl = async (url, init) => {
      const path = url.replace("https://api.github.com", "");
      calls.push({ path, method: init?.method ?? "GET", auth: init?.headers?.authorization });
      return responses[path] ?? { ok: false, status: 404 };
    };
    return { calls, fetchImpl };
  };

  it("exchanges the App credential for an installation token", async () => {
    const { calls, fetchImpl } = exchange();
    // The login travels with the token: it is what a ruleset binds the
    // required check to, and the only call that knows WHICH App the
    // configured credential is is this one.
    expect(await appToken({ appId: 1, privateKey: "KEY", repo: "o/r" }, fetchImpl, sign))
      .toEqual({ token: "ghs_minted", login: "codex-verdict[bot]" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /repos/o/r/installation",
      "POST /app/installations/99/access_tokens",
    ]);
    // Both legs carry the JWT, not a token: the installation lookup is what
    // the JWT is for, and the minting call is authenticated the same way.
    expect(calls.every((c) => c.auth.startsWith("Bearer ey"))).toBe(true);
  });

  it("names which leg of the exchange failed, and never the credential", async () => {
    const missing = exchange({ "/repos/o/r/installation": { ok: false, status: 404 } });
    await expect(appToken({ appId: 1, privateKey: "KEY", repo: "o/r" }, missing.fetchImpl, sign))
      .rejects.toThrow(/installation on o\/r \(404\)/);
    const refused = exchange({ "/app/installations/99/access_tokens": { ok: false, status: 401 } });
    await expect(appToken({ appId: 1, privateKey: "KEY", repo: "o/r" }, refused.fetchImpl, sign))
      .rejects.toThrow(/mint an installation token \(401\)/);
    // The key is never in the message: a failed exchange is the case most
    // likely to be pasted into an issue.
    const caught = await appToken({ appId: 1, privateKey: "SECRET", repo: "o/r" }, refused.fetchImpl, sign)
      .catch((err) => err.message);
    expect(caught.includes("SECRET")).toBe(false);
    // An installation that names no slug leaves the App unidentified, and
    // then neither answer about an existing status is safe: trusting it
    // blocks a bound ruleset forever, rewriting it walks the marker forward
    // every sweep. So it refuses rather than guessing, and never mints.
    for (const body of [{ id: 99 }, { id: 99, app_slug: "" }, { id: 99, app_slug: 7 }]) {
      const nameless = exchange({
        "/repos/o/r/installation": { ok: true, status: 200, json: async () => body },
      });
      await expect(appToken({ appId: 1, privateKey: "KEY", repo: "o/r" }, nameless.fetchImpl, sign))
        .rejects.toThrow(/named no app_slug/);
      expect(nameless.calls.map((c) => c.path)).toEqual(["/repos/o/r/installation"]);
    }
  });

  it("writes with the workflow's own token when no App credential is given", async () => {
    const { calls, fetchImpl } = exchange();
    expect(await resolveStatusToken({ appId: "", privateKey: "", repo: "o/r" }, fetchImpl, sign)).toBe(null);
    // Not a single call: an ordinary consumer pays nothing for the option.
    expect(calls).toEqual([]);
  });

  it("refuses half a credential rather than falling back", async () => {
    // An operator mid-migration has placed one secret and not the other.
    // Falling back would publish as `github-actions[bot]` under a ruleset
    // that may already require the App -- a gate waiting forever on a check
    // nothing reports, which is the failure this file exists to prevent.
    const { calls, fetchImpl } = exchange();
    await expect(resolveStatusToken({ appId: "1", privateKey: "", repo: "o/r" }, fetchImpl, sign))
      .rejects.toThrow(/only app-id was given/);
    await expect(resolveStatusToken({ appId: "", privateKey: "KEY", repo: "o/r" }, fetchImpl, sign))
      .rejects.toThrow(/only app-private-key was given/);
    expect(calls).toEqual([]);
  });

  it("re-mints before the token can expire in a long loop", async () => {
    // `loop-minutes` takes any number a consumer writes, and an
    // installation token lasts an hour: a loop that outlives one would keep
    // reading on the workflow's token while every status write failed, so a
    // hold arriving then would leave an earlier success standing (Codex,
    // mikelward/codex-review#42).
    let clock = 0;
    let minted = 0;
    const counting = async (url, init) => {
      if (url.endsWith("/access_tokens")) minted += 1;
      return exchange().fetchImpl(url, init);
    };
    const next = statusTokenSource(
      { appId: "1", privateKey: "KEY", repo: "o/r" }, counting, sign, () => clock,
    );
    const credential = { token: "ghs_minted", login: "codex-verdict[bot]" };
    expect(await next()).toEqual(credential);
    clock += APP_TOKEN_REFRESH_MS - 1;
    expect(await next()).toEqual(credential);
    expect(minted).toBe(1);
    clock += 1;
    expect(await next()).toEqual(credential);
    expect(minted).toBe(2);
  });

  it("costs nothing per sweep when no App credential is configured", async () => {
    const { calls, fetchImpl } = exchange();
    const next = statusTokenSource({ appId: "", privateKey: "", repo: "o/r" }, fetchImpl, sign);
    expect(await next()).toBe(null);
    expect(await next()).toBe(null);
    expect(calls).toEqual([]);
  });

  it("mints when both halves are given", async () => {
    const { fetchImpl } = exchange();
    expect(await resolveStatusToken({ appId: "1", privateKey: "KEY", repo: "o/r" }, fetchImpl, sign))
      .toEqual({ token: "ghs_minted", login: "codex-verdict[bot]" });
  });
});

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

describe("reviewState", () => {
  it("reads the machine-readable state Codex keeps beside the table", () => {
    expect(reviewState(codexTable({ commit: "abc1234" })).code_review).toEqual({
      commit_sha: "abc1234", has_any_findings: false, status: "completed",
    });
  });

  it("reads nothing where there is no state, or it does not parse", () => {
    expect(reviewState(summaryTable({ status: "Running", commit: "abc1234" }))).toBeNull();
    expect(reviewState("<!-- codex-review-state:v1 {not json} -->")).toBeNull();
    expect(reviewState(null)).toBeNull();
  });
});

describe("reviewTableRow", () => {
  const HEAD = "b9f8d3213f5895509362ccd581b990bd0d830d3b";

  it("reads a row's status and the time it carries", () => {
    expect(reviewTableRow(codexTable({ commit: "b9f8d32", at: "2026-10-20T09:30:35.230334Z" }), HEAD))
      .toEqual({ status: "completed", at: "2026-10-20T09:30:35.230334Z" });
  });

  it("tells a row about another commit from one about this head it can't read", () => {
    const other = summaryTable({ status: "Completed", commit: "b9f8d32", security: "Queued", securityCommit: "0beef12" });
    expect(reviewTableRow(other, HEAD, "Security Review")).toBeNull();
    const mine = summaryTable({ status: "Completed", commit: "b9f8d32", security: "Queued", securityCommit: "b9f8d32" });
    expect(reviewTableRow(mine, HEAD, "Security Review").status).toBeNull();
  });
});

describe("codexCodeReview", () => {
  const HEAD = "abc1234";
  const api = (comments) => ({ rest: async () => comments });
  const read = (comments, log) => codexCodeReview(api(comments), { owner: OWNER, name: "r", number: 1, head: HEAD, log });

  it("reads Codex's state for this exact commit, timed by its row", async () => {
    expect(await read([codexSummary()])).toEqual({ status: "completed", findings: false, at: AFTER });
    expect(await read([codexSummary({ findings: true })])).toEqual({ status: "completed", findings: true, at: AFTER });
  });

  it("says nothing about another commit", async () => {
    expect(await read([codexSummary({ commit: "0beef12" })])).toBeNull();
  });

  it("reads neither status where the row disagrees with the state", async () => {
    // Completed state, running row: no time, so nothing approves on it.
    const finished = codexTable().replace("**Completed**", "**Running**");
    expect(await read([{ ...codexSummary(), body: finished }]))
      .toEqual({ status: null, findings: false, at: null });
    // Running state, completed row: not "running" either, or the sweep
    // would park on a review that has finished.
    const running = codexTable({ status: "running" }).replace("**Running**", "**Completed**");
    expect(await read([{ ...codexSummary(), body: running }]))
      .toEqual({ status: null, findings: null, at: null });
  });

  it("reads a table with no state as running or not, never as clean", async () => {
    const body = summaryTable({ status: "Completed", commit: HEAD });
    expect((await read([{ user: { login: `${CODEX_BOT}[bot]` }, body }])).findings).toBeNull();
  });

  it("ignores a table that is not Codex's, and says so when its state does not parse", async () => {
    expect(await read([{ ...codexSummary(), user: { login: CODEX_BOT, type: "User" } }])).toBeNull();
    const lines = [];
    const garbled = "<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 {nope} -->";
    expect(await read([{ user: { login: `${CODEX_BOT}[bot]` }, body: garbled }], (l) => lines.push(l))).toBeNull();
    expect(lines.some((l) => l.includes("did not parse"))).toBe(true);
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

  it("accepts the real comment opening with Codex's receipt marker", () => {
    // Codex's clean comment on a sibling repo's pull request (2026-10-15),
    // verbatim but for the commit: the marker line counted as a third line,
    // and the gate published FINDINGS over a review that found none.
    const receipt = [
      "<!-- codex-review-receipt:v1 -->",
      "",
      "Codex Review: Didn't find any major issues. :rocket:",
      "",
      "**Reviewed commit:** `5f3881b6c0`",
      "",
      "<details> <summary>ℹ️ About Codex in GitHub</summary>",
      "<br/>",
      "",
      "Reviews are triggered when you open a pull request for review.",
      "</details>",
    ].join("\n");
    expect(cleanVerdict(receipt, HEAD)).toBe("head");
    expect(cleanVerdict(receipt.replace("receipt:v1", "receipt:v2"), HEAD)).toBe("head");
  });

  it("drops only the receipt marker, and only as the first line", () => {
    // The shape stays exact: the marker anywhere else, another HTML comment
    // in its place, or the marker on a findings comment still fails it.
    const marker = "<!-- codex-review-receipt:v1 -->";
    const clean = "Codex Review: Didn't find any major issues.";
    const commit = "**Reviewed commit:** `5f3881b6c0`";
    expect(cleanVerdict([clean, marker, commit].join("\n\n"), HEAD)).toBe(null);
    expect(cleanVerdict(["<!-- note -->", clean, commit].join("\n\n"), HEAD)).toBe(null);
    expect(cleanVerdict([marker, marker, clean, commit].join("\n\n"), HEAD)).toBe(null);
    expect(cleanVerdict([marker, clean, "However, I found a bug.", commit].join("\n\n"), HEAD)).toBe(null);
    expect(cleanVerdict([marker, "Codex Review: 2 findings", commit].join("\n\n"), HEAD)).toBe(null);
    expect(cleanVerdict(marker, HEAD)).toBe(null);
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

  // The clean shapes TODO.md records as refused, kept refused on the
  // maintainer's decision (2026-10-05): the remedy is one `@codex review`,
  // not a wider matcher. Pinned so a matcher change cannot quietly make that
  // entry false. Each names this head, so a refusal is about the shape.
  const TASK_TAIL = [
    "",
    "**Testing**",
    "- ✅ `node --test *.test.js`",
    "",
    " [View task →](https://chatgpt.com/s/cd_0)",
  ];

  it("refuses the task summary that counts zero findings", () => {
    const body = ["Reviewed commit `5f3881b6c0`: **0 findings**", ...TASK_TAIL].join("\n");
    expect(cleanVerdict(body, HEAD)).toBe(null);
  });

  it("refuses a review result that names the head only in its links", () => {
    // "No blocking findings" does not say there were none, and the head is
    // nowhere but inside the permalinks.
    const body = [
      "## Review Result",
      "",
      "No blocking findings.",
      "",
      `The change does what it says. [file.mjsL1-L2](https://github.com/o/r/blob/${HEAD}/file.mjs#L1-L2)`,
      ...TASK_TAIL,
    ].join("\n");
    expect(cleanVerdict(body, HEAD)).toBe(null);
  });

  it("refuses the clean headline as a heading with a task summary after it", () => {
    // It names the head and says the clean words, but as a heading, with no
    // closing stop, and with a report after it -- each alone fails the
    // two-line comment this matcher validates whole.
    const body = [
      "## Codex Review: Didn't find any major issues",
      "",
      `Reviewed commit: \`${HEAD}\``,
      "",
      "The change does what it says.",
      ...TASK_TAIL,
    ].join("\n");
    expect(cleanVerdict(body, HEAD)).toBe(null);
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
