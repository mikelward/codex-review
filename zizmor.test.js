// Tests for the advisory zizmor scan: the workflow that runs it and the
// policy it loads.
//
// The scan's failure modes are all silent: a dropped version pin floats the
// audit set, so a verdict can change with no change in this repository; a
// dropped --offline puts the GitHub API inside the scan; a widened policy
// exempts refs nobody decided to exempt; a narrowed path filter stops
// re-running the scan on the files it audits. Every one of those leaves the
// rest of the suite green, because zizmor only runs inside its own
// workflow — so the contract is pinned here. Read with regexes like the
// other suites: this repository ships no YAML parser on purpose.
import { describe, it, expect } from "./vitest-shim.mjs";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/zizmor.yml", "utf8");
const policy = readFileSync(".github/zizmor.yml", "utf8");

// The policy minus its comments: the prose explains the exemptions partly
// by naming the shapes they must NOT take, so pattern assertions have to
// read only the lines zizmor does.
const policyRules = policy
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

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

  it("re-runs when anything it scans changes", () => {
    // Both triggers filter to the same paths, and those paths cover
    // everything the scan reads: .github/** holds the workflows and the
    // policy, and action.yml is collected by zizmor too. A filter that
    // loses one of these skips the scan exactly where it is needed.
    const filters = [...workflow.matchAll(/paths: \[(.+)\]/g)].map((m) => m[1]);
    expect(filters).toHaveLength(2);
    for (const f of filters) {
      // Compared whole, not by membership: an appended pattern — above all
      // a negation like !.github/workflows/** — must fail here, not ride
      // along beside the two expected entries.
      expect(f.split(",").map((p) => p.trim())).toEqual([
        "'.github/**'",
        "'action.yml'",
      ]);
    }
  });
});

describe("zizmor policy", () => {
  it("holds the pin-policy table exact", () => {
    // `@main` is the release for the enumerated sibling actions, official
    // actions may pin tags, and the blanket hash-pin rule has to be
    // restated because supplying policies replaces zizmor's defaults.
    // Every entry is collected quoted or not — YAML accepts both, so a
    // match that filtered by quoting style would let an unquoted key ride
    // in unseen — and the table is compared whole: an entry added,
    // dropped, or widened (say, mikelward/*) fails here, whichever shape
    // it takes. Consuming a new sibling action at @main means adding it
    // here and in the policy, deliberately.
    const entries = [
      ...policyRules.matchAll(/^ {8}"?([^":\n]+?)"?: *(\S+)$/gm),
    ].map((m) => `${m[1]}: ${m[2]}`);
    expect(entries).toEqual([
      "mikelward/codex-review: ref-pin",
      "mikelward/lanes: ref-pin",
      "actions/*: ref-pin",
      "*: hash-pin",
    ]);
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
