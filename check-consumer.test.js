// Tests for check-consumer.mjs.
//
// This suite is the only thing between a change here and every consumer's
// merge gate, and its failure mode is a FALSE PASS: a checker that stops
// noticing a hole reports the same "correct" it reports when there is none.
// So every case asserts BOTH directions — the correct consumer passes, and
// the specific defect is caught — and the defect cases assert on the reported
// message rather than merely on "some problem", since a check that fails for
// the wrong reason is a check that will pass when that reason goes away.
//
// The notation cases are not hypothetical. Each is a form that got past a
// hand-written copy of this check in a consumer repository, found by review:
// `write-all`, a `.yaml` filename, `statuses: "write"`, `"permissions":`, and
// a blank line inside a mapping. They are the regression suite for the reason
// this file exists.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkConsumer,
  CALLER_DIRECTIVES,
  directives,
  permissionBlocks,
  grantsStatusWrite,
  SWEEP_DIRECTIVES,
  LISTENER_DIRECTIVES,
} from "./check-consumer.mjs";

/** A consumer repository on disk, with whatever workflows a case needs. */
const consumer = (workflows) => {
  const root = mkdtempSync(join(tmpdir(), "consumer-"));
  const dir = join(root, ".github", "workflows");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(workflows)) {
    writeFileSync(join(dir, name), text);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

const SWEEP_TEXT = `${SWEEP_DIRECTIVES.join("\n")}\n`;
const LISTENER_TEXT = `${LISTENER_DIRECTIVES.join("\n")}\n`;
const CALLER_TEXT = `${CALLER_DIRECTIVES.join("\n")}\n`;

/** A third workflow, correct: declares its own block, grants no write. */
const CI_TEXT = `name: CI
on:
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: 'true'
`;

/** Runs the checker over a consumer and cleans up. */
const check = (workflows) => {
  const { root, cleanup } = consumer(workflows);
  try {
    return checkConsumer(root);
  } finally {
    cleanup();
  }
};

const correct = () => ({
  "codex-review.yml": SWEEP_TEXT,
  "codex-review-listener.yml": LISTENER_TEXT,
  "codex-review-check.yml": CALLER_TEXT,
  "ci.yml": CI_TEXT,
});

/** Asserts a problem was reported, and that it is the expected one. */
const assertProblem = (problems, pattern) => {
  assert.ok(
    problems.some((p) => pattern.test(p)),
    `expected a problem matching ${pattern}, got:\n${problems.join("\n") || "(none)"}`,
  );
};

describe("a correct consumer", () => {
  test("passes with no problems at all", () => {
    // The other direction of every case below. If this ever goes red the
    // suite stops being able to tell a defect from the baseline.
    assert.deepEqual(check(correct()), []);
  });

  test("passes when comments and blank lines surround the directives", () => {
    // Consumers carry a header above each stanza, and it has to be free to
    // discuss the very phrases this checker looks for — `statuses: write`
    // appears in the shipped header several times.
    const commented = `# A header that says statuses: write and workflow_dispatch\n\n${SWEEP_DIRECTIVES.join(
      "\n\n# an interleaved note\n",
    )}\n`;
    assert.deepEqual(
      check({ ...correct(), "codex-review.yml": commented }),
      [],
    );
  });
});

describe("the workflow pins", () => {
  test("catch a changed directive, naming the line", () => {
    const broken = SWEEP_TEXT.replace("timeout-minutes: 65", "timeout-minutes: 360");
    const problems = check({ ...correct(), "codex-review.yml": broken });
    assertProblem(problems, /codex-review\.yml line \d+/);
    assertProblem(problems, /timeout-minutes: 65/);
  });

  test("catch a dropped trigger", () => {
    const broken = SWEEP_TEXT.replace(
      "    types: [opened, reopened, ready_for_review, synchronize, edited, closed]\n",
      "",
    );
    assertProblem(check({ ...correct(), "codex-review.yml": broken }), /line \d+/);
  });

  test("catch a re-quoted value that means the same thing", () => {
    // `statuses: "write"` is the same grant to YAML and a different string to
    // a pattern. The pin does not care what it means — only that it changed.
    const broken = SWEEP_TEXT.replace("  statuses: write", '  statuses: "write"');
    assertProblem(check({ ...correct(), "codex-review.yml": broken }), /statuses: write/);
  });

  test("catch a missing listener, both ends being needed for the relay", () => {
    const { "codex-review-listener.yml": _, ...without } = correct();
    assertProblem(check(without), /codex-review-listener\.yml is missing/);
  });

  test("catch a listener that has been given permissions", () => {
    const broken = LISTENER_TEXT.replace(
      "permissions: {}",
      "permissions:\n  statuses: write",
    );
    const problems = check({ ...correct(), "codex-review-listener.yml": broken });
    assertProblem(problems, /codex-review-listener\.yml line \d+/);
    // And it is caught as a status writer too, not only as a changed line.
    assertProblem(problems, /can write commit statuses/);
  });
});

describe("the sole-writer check", () => {
  test("catches a second workflow granting the scope outright", () => {
    const bad = CI_TEXT.replace("  contents: read", "  statuses: write");
    assertProblem(check({ ...correct(), "ci.yml": bad }), /ci\.yml can write commit statuses/);
  });

  test("catches the blanket grant, which never spells the scope", () => {
    // `write-all` grants `statuses: write` without the string appearing.
    const bad = CI_TEXT.replace("permissions:\n  contents: read", "permissions: write-all");
    assertProblem(check({ ...correct(), "ci.yml": bad }), /ci\.yml can write commit statuses/);
  });

  test("catches a quoted key, which YAML reads as the same key", () => {
    // `"permissions":` — a pattern anchored on the bare spelling misses the
    // block entirely, and then the allowlist compares only the blocks it
    // found and passes. Found by review against a consumer's own copy.
    const bad = CI_TEXT.replace(
      "  test:\n    runs-on: ubuntu-latest",
      '  test:\n    "permissions": write-all\n    runs-on: ubuntu-latest',
    );
    assertProblem(check({ ...correct(), "ci.yml": bad }), /ci\.yml can write commit statuses/);
  });

  test("catches a quoted value", () => {
    const bad = CI_TEXT.replace('  contents: read', '  statuses: "write"');
    assertProblem(check({ ...correct(), "ci.yml": bad }), /can write commit statuses/);
  });

  test("catches a flow mapping on the opener line", () => {
    const bad = CI_TEXT.replace(
      "permissions:\n  contents: read",
      "permissions: {contents: read, statuses: write}",
    );
    assertProblem(check({ ...correct(), "ci.yml": bad }), /can write commit statuses/);
  });

  test("catches a grant separated from its key by a blank line", () => {
    // YAML does not end a mapping at a blank line, and neither may the block
    // extractor: reading the blank as the end leaves the extracted block
    // equal to its approved value while the grant below it goes unseen.
    // Found by review against a consumer's own copy.
    const bad = CI_TEXT.replace(
      "permissions:\n  contents: read",
      "permissions:\n  contents: read\n\n  statuses: write",
    );
    assertProblem(check({ ...correct(), "ci.yml": bad }), /can write commit statuses/);
  });

  test("refuses a notation it cannot read, rather than skipping it", () => {
    // YAML's explicit-key form: `? permissions` on its own line, `: write-all`
    // beneath it, the same mapping as `permissions: write-all` and matching no
    // `permissions:` pattern at all. Found by review against a consumer's own
    // copy, and the reason this check fails closed instead of growing another
    // branch: the answer to the next notation is a red check and a human.
    const bad = CI_TEXT.replace(
      "  test:\n    runs-on: ubuntu-latest",
      "  test:\n    ? permissions\n    : write-all\n    runs-on: ubuntu-latest",
    );
    assertProblem(
      check({ ...correct(), "ci.yml": bad }),
      /ci\.yml names permissions in a notation this check does not read/,
    );
  });

  test("does not cry wolf over the plain block it does read", () => {
    // The other direction of the case above: fail-closed is only tolerable if
    // the canonical form never trips it, or every consumer goes permanently
    // red and the check gets switched off.
    assert.deepEqual(check(correct()), []);
  });

  test("catches a job-level grant hiding under a disclaiming top-level block", () => {
    const bad = CI_TEXT.replace(
      "  test:\n    runs-on: ubuntu-latest",
      "  test:\n    permissions:\n      statuses: write\n    runs-on: ubuntu-latest",
    );
    assertProblem(check({ ...correct(), "ci.yml": bad }), /can write commit statuses/);
  });

  test("catches it in a .yaml file, the extension being no exemption", () => {
    const bad = CI_TEXT.replace("  contents: read", "  statuses: write");
    assertProblem(
      check({ ...correct(), "other.yaml": bad }),
      /other\.yaml can write commit statuses/,
    );
  });

  test("allows writes that are not the status", () => {
    // A release workflow needs `contents: write`, and saying so is not a
    // finding — only the `codex` status is reserved.
    const release = CI_TEXT.replace("  contents: read", "  contents: write");
    assert.deepEqual(check({ ...correct(), "release.yml": release }), []);
  });

  test("allows an explicit read grant on the status", () => {
    const reader = CI_TEXT.replace("  contents: read", "  statuses: read");
    assert.deepEqual(check({ ...correct(), "ci.yml": reader }), []);
  });
});

describe("the declared-block requirement", () => {
  test("catches a workflow that declares nothing", () => {
    // Declaring none inherits the repository's default GITHUB_TOKEN
    // permission — a repository setting no file in the tree can read, and one
    // that may be read/write. Two consumers had exactly this.
    const bad = CI_TEXT.replace("permissions:\n  contents: read\n", "");
    assertProblem(
      check({ ...correct(), "ci.yml": bad }),
      /ci\.yml declares no top-level permissions block/,
    );
  });

  test("catches a job-level block standing in for a top-level one", () => {
    // A job-level block covers its own job; every other job in the file still
    // takes the repository default.
    const bad = CI_TEXT.replace(
      "permissions:\n  contents: read\n",
      "",
    ).replace(
      "  test:\n    runs-on: ubuntu-latest",
      "  test:\n    permissions:\n      contents: read\n    runs-on: ubuntu-latest",
    );
    assertProblem(
      check({ ...correct(), "ci.yml": bad }),
      /declares no top-level permissions block/,
    );
  });
});

describe("guards on the guards", () => {
  test("a consumer with no CI of its own is valid", () => {
    // `root` and `web` are exactly this. The sole-writer loop is still not
    // vacuous, because the listener and the caller are in it -- and the pins
    // have already established that all three files exist, which is what stops
    // an empty directory from passing by having nothing to check.
    const { "ci.yml": _ci, ...noCi } = correct();
    assert.deepEqual(check(noCi), []);
  });

  test("a consumer that does not run this check at all is reported", () => {
    // The one a deleted check cannot catch about itself -- but its absence
    // also means no green `codex-review-check` for the ruleset to require.
    const { "codex-review-check.yml": _caller, ...unwired } = correct();
    assertProblem(check(unwired), /codex-review-check\.yml is missing/);
  });

  test("a missing workflows directory is reported", () => {
    const root = mkdtempSync(join(tmpdir(), "consumer-"));
    try {
      assertProblem(checkConsumer(root), /does not exist/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the extractors", () => {
  test("directives drop comments and blanks but keep every setting", () => {
    const lines = directives("# note\n\nname: x\n  # indented note\n  a: b\n\n  c: d\n");
    assert.deepEqual(lines, ["name: x", "  a: b", "  c: d"]);
  });

  test("permissionBlocks finds every block, at any depth", () => {
    const lines = directives(
      "permissions:\n  contents: read\njobs:\n  a:\n    permissions:\n      statuses: write\n    runs-on: x\n",
    );
    const blocks = permissionBlocks(lines);
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[0], ["permissions:", "  contents: read"]);
    assert.deepEqual(blocks[1], ["    permissions:", "      statuses: write"]);
  });

  test("grantsStatusWrite reads the grant rather than searching for a spelling", () => {
    assert.equal(grantsStatusWrite(["permissions:", "  contents: read"]), false);
    assert.equal(grantsStatusWrite(["permissions:", "  statuses: write"]), true);
    assert.equal(grantsStatusWrite(["permissions: write-all"]), true);
    assert.equal(grantsStatusWrite(["permissions: {statuses: write}"]), true);
    assert.equal(grantsStatusWrite(["permissions:", "  statuses: read"]), false);
    assert.equal(grantsStatusWrite(["permissions: read-all"]), false);
  });
});
