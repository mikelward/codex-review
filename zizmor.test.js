// Tests for the required zizmor scan: the workflow that runs it and the
// policy it loads.
//
// The scan's failure modes are all silent: a dropped version pin floats the
// audit set, so a verdict can change with no change in this repository; a
// dropped --offline puts the GitHub API inside the scan; a widened policy
// exempts refs nobody decided to exempt; a reintroduced path filter means a
// required `zizmor` creates no check run at all on a PR that doesn't touch
// the filtered paths, leaving it unmergeable forever. Every one of those
// leaves the rest of the suite green, because zizmor only runs inside its
// own workflow — so the contract is pinned here. Read with regexes like the
// other suites: this repository ships no YAML parser on purpose.
import { describe, it, expect } from "./vitest-shim.mjs";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/zizmor.yml", "utf8");
const policy = readFileSync(".github/zizmor.yml", "utf8");

// Strips YAML comments, full-line and inline both: the prose explains the
// exemptions partly by naming the shapes they must NOT take, and an entry
// written as `"foo/bar": ref-pin # rationale` must still be collected, not
// hidden from the table comparison by its trailing comment. A function
// rather than a constant so the inline branch can be proved on a fixture
// below — the committed policy has no inline-commented entries to prove it
// on.
const stripComments = (text) =>
  text
    .split("\n")
    .map((line) => line.replace(/\s+#.*$/, ""))
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

const policyRules = stripComments(policy);

// Every pin-policy entry in the text, quoted or not — YAML accepts both,
// so a match that filtered by quoting style would let an unquoted key ride
// in unseen.
const policyEntries = (text) =>
  [...text.matchAll(/^ {8}"?([^":\n]+?)"?: *(\S+)$/gm)].map(
    (m) => `${m[1]}: ${m[2]}`,
  );

describe("zizmor workflow", () => {
  it("pins the zizmor version exactly", () => {
    // An unpinned run takes whatever release is newest, and a new release
    // adds audits. Bumping the pin is a deliberate edit that re-reads the
    // findings, never a side effect.
    expect(workflow).toMatch(/pipx run --spec zizmor==\d+\.\d+\.\d+ zizmor /);
  });

  it("scans offline", () => {
    // The one scan invocation carries --offline, so the audits that need
    // the GitHub API are skipped deterministically and the only fetch at
    // run time is zizmor itself.
    const runs = [...workflow.matchAll(/pipx run [^\n]+/g)];
    expect(runs).toHaveLength(1);
    expect(runs[0][0]).toMatch(/ --offline /);
  });

  it("holds read-only permissions", () => {
    // The sole-writer rule in check_consumer.py guards statuses; this pins
    // the whole grant, so the scan can never grow a scope quietly. The
    // top-level block must also be the ONLY one: GitHub lets a job-level
    // mapping replace it wholesale, so a second block anywhere is a
    // widening no matter how it is scoped.
    expect(workflow).toMatch(/\npermissions:\n  contents: read\njobs:/);
    expect([...workflow.matchAll(/^ *permissions:/gm)]).toHaveLength(1);
  });

  it("runs on every pull request and push to main, with no paths filter", () => {
    // `zizmor` joins `lanes` and `codex` in the fleet's required set
    // (TODO.md holds the ruleset flip), and a required check must report
    // on every pull request's head: a workflow filtered out by `paths:`
    // creates NO check run at all -- unlike a skipped job, which reports
    // "skipped" and satisfies the ruleset -- so a filter here would leave
    // any PR not touching the filtered paths unmergeable behind a check
    // nothing reports. That is true of the old filter too, which covered
    // `.github/**` and `action.yml` -- the very files this scan reads --
    // and still left every other PR waiting forever. Matched as one
    // contiguous block running straight from `on:` into `permissions:`,
    // so `pull_request:` provably carries exactly one nested key: the
    // explicit types list, `edited` included -- a retarget regenerates
    // the merge ref against the new base while the head (and the green
    // check already attached to it) stays put, so the default types,
    // which lack `edited`, would let the old target's scan satisfy the
    // new one. Anything else nested there, a `paths:` filter above all,
    // breaks the match; the separate no-paths assertion keeps a filter
    // from riding on any future trigger this block match doesn't cover.
    expect(workflow).toMatch(
      /\non:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n {4}types: \[opened, synchronize, reopened, edited\]\npermissions:\n/,
    );
    expect(workflow).not.toMatch(/^\s*paths:/m);
  });
});

describe("zizmor policy", () => {
  it("holds the pin-policy table exact", () => {
    // `@main` is the release for the enumerated sibling actions, official
    // actions may pin tags, and the blanket hash-pin rule has to be
    // restated because supplying policies replaces zizmor's defaults.
    // The table is compared whole: an entry added, dropped, or widened
    // (say, mikelward/*) fails here, whichever shape it takes. Consuming a
    // new sibling action at @main means adding it here and in the policy,
    // deliberately.
    expect(policyEntries(policyRules)).toEqual([
      "mikelward/codex-review: ref-pin",
      "mikelward/lanes: ref-pin",
      "actions/*: ref-pin",
      "*: hash-pin",
    ]);
  });

  it("collects an entry hidden behind an inline comment", () => {
    // The committed policy carries no inline-commented entries, so the
    // stripping branch is proved on a fixture: were it dropped, an
    // exemption written as `"o/r": ref-pin # rationale` would vanish from
    // the table comparison instead of failing it, and the suite would
    // stay green while the table check quietly stopped seeing such lines.
    const fixture = '        "o/r": ref-pin # rationale';
    expect(policyEntries(stripComments(fixture))).toEqual(["o/r: ref-pin"]);
  });

  it("excuses the sweep's triggers for codex-review.yml alone", () => {
    // The ignore list is why a NEW workflow reaching for
    // pull_request_target is still flagged. The list items are the only
    // `- ` entries in the file; compared whole, so nothing rides in
    // beside the one excused workflow.
    const ignored = [...policy.matchAll(/^ +- (\S+)$/gm)].map((m) => m[1]);
    expect(ignored).toEqual(["codex-review.yml"]);
  });
});
