// Tests for this repository's lane policy, .github/lanes.conf.
//
// The engine (mikelward/lanes) is tested in its own repository; what it
// cannot test is THIS repo's policy, and the policy's failure mode is the
// quiet one: a broadened rule makes classify and gate derive the same wrong
// docs verdict, so the suite skips under a green required check. So the
// rules are exercised here, both directions, with `path.matchesGlob` — the
// same standard primitive the engine matches with, so this suite cannot
// drift from the engine on glob semantics. The tiny reader below follows the
// policy format the lanes README documents (ordered rules, full-line and
// trailing comments, first match wins, no rule means code); if the engine
// ever refuses a shape this reader accepts, the gate goes red rather than
// green, which is the safe direction for a disagreement.

import { describe, it, expect } from "./vitest-shim.mjs";
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";

const text = readFileSync(new URL("./.github/lanes.conf", import.meta.url), "utf8");

const lines = text
  .split("\n")
  .map((line) => {
    const comment = line.search(/\s#/);
    return (comment === -1 ? line : line.slice(0, comment)).trim();
  })
  .filter((line) => line && !line.startsWith("#"));

const rules = [];
const directives = {};
for (const line of lines) {
  const [word, ...rest] = line.split(/\s+/);
  if (word === "docs" || word === "code") rules.push({ verdict: word, pattern: rest.join(" ") });
  else directives[word] = rest;
}

const classify = (path) => {
  for (const { verdict, pattern } of rules) {
    if (matchesGlob(path, pattern)) return verdict;
  }
  return "code";
};

describe("the lane policy", () => {
  it("parses to the intended shape, nothing wider", () => {
    // A rule this suite has not vetted is a rule nothing here exercises —
    // and the ORDER is part of the shape: the contract fixtures are code
    // only because their rules come first.
    expect(rules).toEqual([
      { verdict: "code", pattern: "README.md" },
      { verdict: "code", pattern: "AGENTS.md" },
      { verdict: "code", pattern: "CLAUDE.md" },
      { verdict: "code", pattern: "TODO.md" },
      { verdict: "code", pattern: "docs/CONSUMER.md" },
      { verdict: "docs", pattern: "**/*.md" },
    ]);
    expect(directives.prefixes).toEqual(["docs"]);
    expect(directives["dispatch-without-pr"]).toEqual(["refuse"]);
  });

  it("classifies prose as docs, at the root and nested", () => {
    // Prose no test reads. Neither file exists; what is being exercised is
    // the trailing `**/*.md` rule, which is what keeps the docs lane worth
    // having — without a case on this side, every rule above could widen to
    // code and nothing here would notice.
    for (const path of ["NOTES.md", "docs/notes/scratch.md"]) {
      expect(classify(path), path).toBe("docs");
    }
  });

  it("classifies the contract fixtures as code, not prose", () => {
    // Markdown the suite asserts against. An edit to any of these can break
    // a test, so a docs-lane skip would let that edit merge green and fail
    // the next code pull request on prose it never touched.
    //
    // README.md embeds the consumer workflow templates action.test.js pins
    // the installed workflows to. AGENTS.md carries the consumer list the
    // check-consumers sweep is derived from (CLAUDE.md is AGENTS.md by
    // symlink). TODO.md is asserted to carry the `## Decisions needing
    // review` heading the autopilot rule requires. docs/CONSUMER.md has
    // four sections pinned: the fork limitation with its `checks: write`
    // scope, the head's-`codex-review-check` limitation, the dispatch
    // trigger's reason, and the template-migration section.
    //
    // This list is deliberately hand-written and NOT exhaustive: it names
    // what the suite reads today. A test that starts reading some other
    // markdown file needs a line here and a rule in the policy, and nothing
    // enforces that — deriving the set instead was tried and abandoned, see
    // the pull request that added TODO.md and docs/CONSUMER.md.
    for (const path of [
      "README.md",
      "AGENTS.md",
      "CLAUDE.md",
      "TODO.md",
      "docs/CONSUMER.md",
    ]) {
      expect(classify(path), path).toBe("code");
    }
  });

  it("classifies everything a consumer runs as code", () => {
    for (const path of [
      "action.yml",
      "codex-review.mjs",
      "check_consumer.py",
      "templates/codex-review.yml",
      "scripts/check-consumers.sh",
      ".github/workflows/ci.yml",
      ".github/lanes.conf",
      ".gitignore",
    ]) {
      expect(classify(path), path).toBe("code");
    }
  });
});
