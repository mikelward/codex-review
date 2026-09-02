// Behavioral tests for scripts/check-consumers.sh -- specifically its
// finished-migration guard, the one check that decides when a superseded
// template shape has to go.
//
// It is tested by RUNNING it, not by reading it. The guard's whole job is to
// notice something silent, so a suite that matched the script's source text
// would stay green if the script kept those strings and stopped setting
// `failed`, or associated a consumer's notice with the wrong label -- which is
// exactly the false pass this repository's suites are most at risk of. So each
// case builds a synthetic hub (this revision's checker, templates and script),
// gives it real consumer trees on chosen shapes, runs the script, and asserts
// the exit status and which labels it named.
//
// No network: the script's optional argument points it at sibling checkouts
// instead of cloning. It does shell out to python3 for the checker, which the
// same CI job already requires.
import { describe, it, expect } from "./vitest-shim.mjs";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEMPLATES = [
  "codex-review.yml",
  "codex-review-listener.yml",
  "codex-review-check.yml",
];

// The consumer names the script iterates, read from the script rather than
// retyped: a synthetic tree under a name it does not know is never visited,
// and the case would pass having checked nothing.
const CONSUMERS = readFileSync("scripts/check-consumers.sh", "utf8")
  .match(/^CONSUMERS="([^"]+)"/m)?.[1]
  ?.split(/\s+/);

/**
 * A hub holding this revision's checker, templates and sweep, plus whatever
 * superseded shapes a case asks for.
 *
 * A shape is the current templates with one comment line appended, which is
 * enough to make it a distinct byte-for-byte shape while staying a valid
 * workflow -- the checker parses these files, so a shape has to be real YAML
 * rather than arbitrary bytes.
 *
 * The three template files are copied by name, NOT `templates/` recursively.
 * A recursive copy would import whatever real `templates/superseded/<label>/`
 * happens to exist -- and during a real migration exactly one does, offered to
 * every fixture while no fixture consumer is on it, so the guard would call it
 * finished and turn the green cases red on the migration commit itself. That
 * is the deadlock this mechanism exists to remove, arriving through the test
 * fixtures. The shapes a case gets are the shapes it asked for and nothing
 * else.
 */
function hub(root, labels) {
  const dir = join(root, "hub");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "templates"), { recursive: true });
  cpSync("check_consumer.py", join(dir, "check_consumer.py"));
  cpSync("scripts/check-consumers.sh", join(dir, "scripts/check-consumers.sh"));
  for (const name of TEMPLATES) {
    cpSync(`templates/${name}`, join(dir, "templates", name));
  }
  for (const label of labels) {
    const shape = join(dir, "templates", "superseded", label);
    mkdirSync(shape, { recursive: true });
    for (const name of TEMPLATES) {
      cpSync(join(dir, "templates", name), join(shape, name));
      appendFileSync(join(shape, name), `# shape ${label}\n`);
    }
  }
  return dir;
}

/**
 * Consumer trees, one per entry of `on`: "current" for the live templates, a
 * label for that superseded shape, or "unadopted" for a checkout that has no
 * caller yet. Named after real consumers in the script's own order, since it
 * only visits names it knows.
 */
function siblings(root, dir, on) {
  const sibs = join(root, "sibs");
  mkdirSync(sibs, { recursive: true });
  on.forEach((want, i) => {
    const repo = join(sibs, CONSUMERS[i]);
    if (want === "unadopted") {
      mkdirSync(repo, { recursive: true });
      return;
    }
    const from =
      want === "current"
        ? join(dir, "templates")
        : join(dir, "templates", "superseded", want);
    const workflows = join(repo, ".github", "workflows");
    mkdirSync(workflows, { recursive: true });
    for (const name of TEMPLATES) {
      cpSync(join(from, name), join(workflows, name));
    }
  });
  return sibs;
}

/** Build a hub and consumers, run the sweep over them, return status+output. */
function sweep({ shapes = [], consumers = [] }) {
  const root = mkdtempSync(join(tmpdir(), "check-consumers-"));
  try {
    const dir = hub(root, shapes);
    const sibs = siblings(root, dir, consumers);
    const run = spawnSync("sh", [join(dir, "scripts", "check-consumers.sh"), sibs], {
      encoding: "utf8",
    });
    return { status: run.status, out: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("the finished-migration guard", () => {
  it("visits the consumer names the script actually iterates", () => {
    // Every case below depends on this: a name the script does not iterate is
    // a tree it never reads, and the assertion passes vacuously.
    expect(CONSUMERS?.length).toBe(21);
    const { status, out } = sweep({ consumers: ["current", "current"] });
    expect(out).toMatch(/read 2 consumer\(s\), checked 2/);
    expect(status).toBe(0);
  });

  it("passes while a migration is under way", () => {
    // The moment a migration opens, every consumer is still on the outgoing
    // shape. Going red here is the deadlock templates/superseded/ exists to
    // remove, so this direction matters more than the failing one.
    const { status, out } = sweep({
      shapes: ["old-a"],
      consumers: ["old-a", "old-a"],
    });
    expect(status).toBe(0);
    expect(out).not.toMatch(/still offered/);
  });

  it("passes half way through, with one consumer moved", () => {
    const { status, out } = sweep({
      shapes: ["old-a"],
      consumers: ["current", "old-a"],
    });
    expect(status).toBe(0);
    expect(out).toMatch(/superseded shape `old-a`/);
  });

  it("fails once the last consumer has left the shape", () => {
    const { status, out } = sweep({
      shapes: ["old-a"],
      consumers: ["current", "current"],
    });
    expect(status).toBe(1);
    expect(out).toMatch(/still offered:\n {8}old-a\n/);
  });

  it("judges each shape on its own consumers, not on a shared tally", () => {
    // Two migrations overlap; one is finished and the other has only just
    // started. A single counter reports "somebody is still on some old shape"
    // and keeps the finished one alive behind the active one indefinitely.
    const { status, out } = sweep({
      shapes: ["old-a", "old-b"],
      consumers: ["current", "old-b"],
    });
    expect(status).toBe(1);
    expect(out).toMatch(/still offered:\n {8}old-a\n {6}Those migrations/);
  });

  it("names every finished shape when several end together", () => {
    const { status, out } = sweep({
      shapes: ["old-a", "old-b"],
      consumers: ["current", "current"],
    });
    expect(status).toBe(1);
    expect(out).toMatch(/still offered:\n {8}old-a\n {8}old-b\n/);
  });

  it("gives a fixture only the shapes it asked for", () => {
    // The isolation the comment on hub() explains, asserted rather than left
    // to a reader. It cannot fail today -- templates/ holds exactly the three
    // files -- but it fails the moment anything else lives there, which is
    // precisely when a recursive copy would start leaking into every case.
    const root = mkdtempSync(join(tmpdir(), "check-consumers-"));
    try {
      const dir = hub(root, ["old-a"]);
      expect(readdirSync(join(dir, "templates")).sort()).toEqual(
        [...TEMPLATES, "superseded"].sort(),
      );
      expect(readdirSync(join(dir, "templates", "superseded"))).toEqual(["old-a"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("matches a dash-prefixed label as data, not as grep options", () => {
    // Two things have to hold at once here. The checker refuses `-legacy` as a
    // label, so the run is red for that reason -- and the guard must NOT also
    // report the shape as finished, because a consumer is on it. It would if
    // the label reached grep as options rather than as a pattern, and the
    // advice it printed would be to delete a live migration.
    const { status, out } = sweep({
      shapes: ["-legacy"],
      consumers: ["current", "-legacy"],
    });
    expect(status).toBe(1);
    expect(out).toMatch(/`-legacy` has an unusable name/);
    expect(out).not.toMatch(/still offered/);
  });

  it("sees a dot-prefixed label, which a shell glob would skip", () => {
    // The checker enumerates shapes with Path.iterdir(), which includes
    // dot-prefixed directories; `*/` does not. A shape the checker offers but
    // this guard never enumerates would stay accepted forever, silently --
    // the exact failure the guard exists to catch. It is refused as a label
    // too, so both channels report it; the guard's is the one asserted here.
    const { status, out } = sweep({
      shapes: [".legacy"],
      consumers: ["current", "current"],
    });
    expect(status).toBe(1);
    expect(out).toMatch(/still offered:\n {8}\.legacy\n/);
  });

  it("does not call a migration finished when nothing was checked", () => {
    // No consumer adopted the caller, so no consumer could match the shape.
    // Reading that as "the migration is over" would delete a shape every
    // consumer might still be on.
    const { status, out } = sweep({
      shapes: ["old-a"],
      consumers: ["unadopted", "unadopted"],
    });
    expect(status).toBe(0);
    expect(out).not.toMatch(/still offered/);
  });
});
