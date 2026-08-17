#!/usr/bin/env node
// Checks that a consuming repository's codex-review workflows still say what
// they have to say.
//
// This lived as a hand-written test in each of the nine consumers -- shell,
// JavaScript, Rust and Python -- and drifted exactly the way a duplicated
// invariant does. Two review findings arrived days apart against two of the
// copies: `"permissions":` is valid YAML that a `permissions:` pattern misses,
// and a blank line inside a mapping is not the end of it. Each fix then had to
// be hand-carried into eight other files in four languages, which is the
// manual invariant with no enforcement that centralizing the sweep already
// removed once. So it is one implementation now, with one suite.
//
// WHAT IS CHECKED, and why each one is here rather than left to a reader:
//
//   1. The sweep and the listener are pinned LINE FOR LINE, comments and
//      blank lines excluded. Every other form of check extracts something,
//      and a regex over YAML is an approximation of YAML: across the sibling
//      repositories `write-all`, a `.yaml` filename, `statuses: "write"`,
//      `"pull_request":`, `"permissions":`, a bare sequence dash and a blank
//      line inside a mapping each sailed past one. Patching the seventh
//      notation buys the eighth. A pin has nothing to approximate: any edit
//      in any notation fails, and has to be re-approved by editing the
//      expected list HERE, once, for every consumer.
//
//   2. The check FAILS CLOSED on any permissions notation it cannot read
//      canonically. This is the only terminating answer to the
//      notation game: every round of review found another valid YAML spelling
//      of one mapping -- most recently the explicit-key form, `? permissions`
//      on its own line with `: write-all` under it -- and patching the
//      recognizer for each buys the next one, while an author or an honest
//      refactor needs only one that has not been patched yet. So anything
//      naming `permissions` that is not the plain `permissions:` block this
//      repository's own consumers use is REPORTED rather than parsed: the
//      answer to notation N+1 is a red check and a human, not a silent pass.
//      The cost is a consumer using an exotic-but-valid spelling has to
//      rewrite it plainly, which is a trade worth making for the one
//      invariant here whose breach is otherwise silent.
//
//   3. No other workflow in the consumer may write commit statuses. The
//      sweep's correctness leans on being the sole writer of `codex`: a
//      commit status belongs to the SHA, so a second writer is an unordered
//      write, and one delayed past the sweep's exit overwrites a fresh
//      verdict with a stale one, with nothing to report that it happened.
//
//   4. Every other workflow must DECLARE a top-level permissions block.
//      Declaring none is not the same as granting nothing: it inherits the
//      repository's default GITHUB_TOKEN permission, which is a repository
//      setting no file in the tree can read and which may be read/write.
//      This found real holes in two consumers on the day it was written.
//
// Usage: node check-consumer.mjs [<repo root>]
// Exits 0 when the consumer is correct, 1 with a report when it is not.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/** The sweep, as every consumer must have it. */
export const SWEEP = "codex-review.yml";
/** The unprivileged relay, likewise. */
export const LISTENER = "codex-review-listener.yml";
/** The eight-line file that calls this check. */
export const CALLER = "codex-review-check.yml";

/**
 * The sweep's directives, in order.
 *
 * These are identical in every consumer, which is what makes pinning them
 * here rather than nine times the whole point of this file. The reasoning for
 * each line is in docs/CONSUMER.md, not in nine copies of a comment block.
 */
export const SWEEP_DIRECTIVES = [
  "name: codex-review",
  "on:",
  "  schedule:",
  "    - cron: '23 * * * *'",
  "  pull_request_target:",
  "    types: [opened, reopened, ready_for_review, synchronize, edited, closed]",
  "  issue_comment:",
  "    types: [created, edited]",
  "  pull_request_review_comment:",
  "    types: [created, edited]",
  "  workflow_run:",
  "    workflows: [codex-review-listener]",
  "    types: [completed]",
  "permissions:",
  "  contents: read",
  "  pull-requests: read",
  "  checks: read",
  "  statuses: write",
  "concurrency:",
  "  group: codex-review",
  "  cancel-in-progress: false",
  "jobs:",
  "  sweep:",
  "    runs-on: ubuntu-latest",
  "    timeout-minutes: 65",
  "    steps:",
  "      - uses: mikelward/codex-review@main",
];

/** The listener's directives, in order. */
export const LISTENER_DIRECTIVES = [
  "name: codex-review-listener",
  "on:",
  "  pull_request_review:",
  "    types: [submitted, edited, dismissed]",
  "permissions: {}",
  "jobs:",
  "  heard:",
  "    runs-on: ubuntu-latest",
  "    timeout-minutes: 5",
  "    steps:",
  "      - run: 'true'",
];

/**
 * The caller's directives, in order.
 *
 * Pinned like the other two, and for a reason worth stating: without it a
 * consumer could delete or neuter the file that runs this check and nothing
 * would object, since the thing that would object is what was deleted. Pinning
 * it means that whenever the check does run, it verifies its own invocation --
 * and a consumer that removes it has no green `codex-review-check` for its
 * ruleset to require.
 */
export const CALLER_DIRECTIVES = [
  "name: codex-review-check",
  "on:",
  "  push:",
  "  pull_request:",
  "permissions:",
  "  contents: read",
  "jobs:",
  "  check:",
  "    uses: mikelward/codex-review/.github/workflows/check-consumer.yml@main",
];

/**
 * Both extensions GitHub accepts for a workflow.
 *
 * Filtering to `.yml` alone would let a `.yaml` file grant `statuses: write`
 * while the sole-writer check still passed -- the invariant bypassed by a
 * filename, with the check reporting green.
 */
export const isWorkflow = (file) => /\.ya?ml$/.test(file);

/**
 * A workflow's directive lines: comments and blank lines dropped, trailing
 * whitespace trimmed.
 *
 * These files carry more prose than YAML, and every phrase this checker looks
 * for is also something a header has to be able to *discuss*. Reading only
 * the directives keeps the prose free to say anything -- and dropping blanks
 * here is what stops a blank line inside a mapping from being read as the end
 * of it, which YAML does not do either.
 */
export const directives = (text) =>
  text
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => !/^\s*#/.test(line) && line.trim() !== "");

/** How deep a line is indented, or -1 when it is blank. */
const indentOf = (line) => {
  const i = line.search(/\S/);
  return i === -1 ? -1 : i;
};

/**
 * Matches a mapping key, quoted or not.
 *
 * `"permissions":` and `'on':` are valid YAML naming the same keys as their
 * bare forms, and a pattern anchored on the bare spelling misses them. For
 * `on` the quoted form is not even exotic: YAML 1.1 reads a bare `on` as the
 * boolean true, so quoting it is something a careful author does on purpose.
 */
const keyPattern = (key) =>
  new RegExp(`^(\\s*)["']?${key}["']?\\s*:(.*)$`);

/**
 * Every `permissions:` block in a workflow, top-level or per-job, as trimmed
 * lines.
 *
 * Per-job blocks are deliberately included: without them a job-level grant
 * could hide under a top-level block that disclaims it. A block runs to the
 * next line indented no deeper than its own key -- blanks having already been
 * dropped -- so a one-line flow mapping (`permissions: {statuses: write}`)
 * comes back as itself and is judged, rather than parsing to nothing.
 */
export const permissionBlocks = (lines) => {
  const blocks = [];
  const pattern = keyPattern("permissions");
  lines.forEach((line, i) => {
    const opener = pattern.exec(line);
    if (!opener) return;
    const depth = opener[1].length;
    const block = [line];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (indentOf(lines[j]) <= depth) break;
      block.push(lines[j]);
    }
    blocks.push(block);
  });
  return blocks;
};

/**
 * Whether a permissions block can write commit statuses.
 *
 * Judged by reading what the block GRANTS rather than by searching it for
 * forbidden spellings, because absence is unbounded and a denylist has to
 * know every notation in advance while an author needs only one. Three ways
 * to grant it, and all three are read here: the blanket `write-all`, a
 * `statuses:` entry whose value is anything but `read`/`none`, and the same
 * entry inside a flow mapping on the opener line.
 */
export const grantsStatusWrite = (block) => {
  const text = block.join("\n");
  // `write-all` is the whole permissions value; it grants every scope.
  if (/:\s*["']?write-all["']?\s*$/m.test(text)) return true;
  // Entries, whether block style (one per line) or flow style (`{a: b, c: d}`).
  const flow = /\{([^}]*)\}/.exec(text);
  const entries = flow
    ? flow[1].split(",")
    : block.slice(1);
  return entries.some((entry) => {
    const m = /^\s*["']?([A-Za-z-]+)["']?\s*:\s*["']?([A-Za-z-]*)["']?\s*$/.exec(entry);
    if (!m) return false;
    return m[1] === "statuses" && m[2] !== "read" && m[2] !== "none";
  });
};

/** Whether a block is a top-level one (its key at column 0). */
export const isTopLevel = (block) => indentOf(block[0]) === 0;

/**
 * Every line that names `permissions` in any way at all.
 *
 * Paired with `permissionBlocks` below to fail closed: a site this finds and
 * that finds is canonical and gets read; a site only this one finds is a
 * notation the reader does not handle, and is reported rather than ignored.
 * YAML's explicit-key form is the example that forced this -- `? permissions`
 * alone on a line, with `: write-all` beneath it, is the same mapping and
 * matches no `permissions:` pattern anywhere.
 */
export const permissionSites = (lines) =>
  lines.filter((line) => /\bpermissions\b/.test(line));

/**
 * The permissions sites a canonical block opener accounts for.
 *
 * A site inside a block's body counts as accounted for too -- an entry could
 * legitimately be named `permissions` in some other mapping -- so only lines
 * outside every block are unexplained.
 */
const accountedFor = (lines, blocks) => {
  const inBlock = new Set();
  for (const block of blocks) for (const line of block) inBlock.add(line);
  return (line) => inBlock.has(line);
};

/**
 * Checks one consumer repository. Returns a list of problems, empty when it
 * is correct.
 */
export function checkConsumer(root = ".") {
  const dir = join(root, ".github", "workflows");
  const problems = [];
  const say = (message) => problems.push(message);

  if (!existsSync(dir)) {
    say(`${dir} does not exist — a consumer needs both codex-review workflows`);
    return problems;
  }

  const files = readdirSync(dir).filter(isWorkflow);
  const read = (name) => directives(readFileSync(join(dir, name), "utf8"));

  // The pins. A diff is reported line by line so a failure names what moved,
  // rather than only saying the file is wrong.
  for (const [name, expected] of [
    [SWEEP, SWEEP_DIRECTIVES],
    [LISTENER, LISTENER_DIRECTIVES],
    [CALLER, CALLER_DIRECTIVES],
  ]) {
    if (!files.includes(name)) {
      say(
        name === CALLER
          ? `${name} is missing — nothing in this repository runs this check`
          : `${name} is missing — the relay needs both ends`,
      );
      continue;
    }
    const actual = read(name);
    const width = Math.max(actual.length, expected.length);
    for (let i = 0; i < width; i += 1) {
      if (actual[i] !== expected[i]) {
        say(
          `${name} line ${i + 1} is not what the shared shape pins\n` +
            `  expected: ${expected[i] ?? "(nothing — the file is longer)"}\n` +
            `  actual:   ${actual[i] ?? "(nothing — the file is shorter)"}`,
        );
      }
    }
  }

  // The listener is always among these, so the loop below is never vacuous --
  // and the pins above have already established that it exists. A consumer
  // whose only workflows are the pair is legitimate: two of them are.
  const others = files.filter((f) => f !== SWEEP);

  for (const file of others) {
    const lines = read(file);
    const blocks = permissionBlocks(lines);

    // Fail closed before reading anything: a notation the reader does not
    // handle must not be silently skipped, because skipping is what a
    // permitted file looks like.
    const explained = accountedFor(lines, blocks);
    for (const site of permissionSites(lines)) {
      if (explained(site)) continue;
      say(
        `${file} names permissions in a notation this check does not read ` +
          `(${site.trim()}) — rewrite it as a plain \`permissions:\` block, or ` +
          "it cannot be verified not to grant `statuses: write`",
      );
    }

    if (!blocks.some(isTopLevel)) {
      say(
        `${file} declares no top-level permissions block, so its jobs inherit ` +
          "the repository's default GITHUB_TOKEN permission — a setting no " +
          "file in the repo can read, and one that may be read/write",
      );
    }

    for (const block of blocks) {
      if (grantsStatusWrite(block)) {
        say(
          `${file} can write commit statuses (${block[0].trim()}), and only ` +
            `${SWEEP} may — a second writer is an unordered write, and one ` +
            "delayed past the sweep's exit overwrites a fresh verdict with a stale one",
        );
      }
    }
  }

  return problems;
}

// Run as a script rather than imported by the suite.
if (process.argv[1] && process.argv[1].endsWith("check-consumer.mjs")) {
  const problems = checkConsumer(process.argv[2] ?? ".");
  for (const problem of problems) console.error(`error: ${problem}`);
  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s) — see docs/CONSUMER.md`);
    process.exit(1);
  }
  console.log("codex-review consumer setup is correct");
}
