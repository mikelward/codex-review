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
  writeFileSync,
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

// The consumers the script names but cannot clone anonymously, read from the
// script for the same reason: a fixture under a name it does not iterate is
// never visited, and the case would pass having tested nothing.
const PRIVATE_CONSUMERS = readFileSync("scripts/check-consumers.sh", "utf8")
  .match(/^PRIVATE_CONSUMERS="([^"]+)"/m)?.[1]
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
function siblings(root, dir, on, rest, privateOn) {
  const sibs = join(root, "sibs");
  mkdirSync(sibs, { recursive: true });

  const place = (name, want) => {
    const repo = join(sibs, name);
    if (want === "absent") return;
    if (want === "unadopted") {
      mkdirSync(repo, { recursive: true });
      return;
    }
    // A shape, optionally with the checker made to crash over this tree:
    // "old-a!crash" is old-a plus an unrelated workflow holding bytes that are
    // not UTF-8, which is a real reachable failure -- the checker reads every
    // workflow, so `read_text()` raises UnicodeDecodeError before any verdict.
    const [shape, crash] = want.split("!");
    const from =
      shape === "current"
        ? join(dir, "templates")
        : join(dir, "templates", "superseded", shape);
    const workflows = join(repo, ".github", "workflows");
    mkdirSync(workflows, { recursive: true });
    for (const file of TEMPLATES) {
      cpSync(join(from, file), join(workflows, file));
    }
    if (crash === "crash") {
      writeFileSync(join(workflows, "unrelated.yml"), Buffer.from([0xff, 0xfe]));
    }
  };

  // EVERY consumer gets a tree, not just the ones a case names: the guard
  // holds a migration open when any consumer went unread, so leaving the
  // unnamed ones out would put every case into that branch, where it reports
  // a notice rather than failing -- and the cases about a migration ending
  // would assert nothing about the verdict they exist for. A case names the
  // consumers it cares about positionally; `rest` and `privateOn` say what
  // the others are on, and "absent" is how a case asks for the unread branch
  // deliberately.
  CONSUMERS.forEach((name, i) => place(name, i < on.length ? on[i] : rest));
  for (const name of PRIVATE_CONSUMERS) place(name, privateOn);
  return sibs;
}

/** Build a hub and consumers, run the sweep over them, return status+output. */
function sweep({
  shapes = [],
  consumers = [],
  rest = "current",
  privateOn = "current",
}) {
  const root = mkdtempSync(join(tmpdir(), "check-consumers-"));
  try {
    const dir = hub(root, shapes);
    const sibs = siblings(root, dir, consumers, rest, privateOn);
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
    // Every consumer from both lists gets a tree, so a case that names two
    // still reads the whole fleet.
    expect(out).toMatch(/read 22 consumer\(s\), checked 22/);
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
    // the exact failure the guard exists to catch.
    //
    // The label is also refused as a NAME, which makes every consumer's
    // checker run exit non-zero, so none of them counts as read and the
    // verdict is the notice rather than the failure. That is the guard being
    // consistent, not evasive -- a run that reached no verdict about any
    // consumer has established nothing about who is still on this shape -- and
    // the property this case exists for survives either way: the label is
    // enumerated and named. Asserted in the notice's indented list, which is
    // the guard's own channel, not the checker's complaint about the name.
    const { status, out } = sweep({
      shapes: [".legacy"],
      consumers: ["current", "current"],
    });
    expect(status).toBe(1);
    expect(out).toMatch(/could not read every consumer:\n {12}\.legacy\n/);
  });

  it("does not call a migration finished when nothing was checked", () => {
    // No consumer adopted the caller, so no consumer could match the shape.
    // Reading that as "the migration is over" would delete a shape every
    // consumer might still be on.
    const { status, out } = sweep({
      shapes: ["old-a"],
      consumers: ["unadopted", "unadopted"],
      // Every other consumer too: the case is "nothing was checked", and
      // leaving any of them adopted would check one and make it a different
      // case.
      rest: "unadopted",
      privateOn: "unadopted",
    });
    expect(status).toBe(0);
    expect(out).not.toMatch(/still offered/);
  });
});

/**
 * Run the sweep in its CLONING mode -- no sibling argument -- against a fake
 * `git` that serves a prepared tree for the names in `clonable` and fails for
 * every other. It is the only way to reach the clone-failure branch without
 * the network, and that branch is worth reaching: it decides whether an
 * unreachable repository is a reported skip or a red job, and either mistake
 * is silent. Downgrading a public consumer to a skip hides one that has
 * genuinely gone away; promoting a private one to a failure turns this job
 * red forever, whatever the consumers actually look like.
 *
 * PATH is prepended rather than replaced, since the script still needs the
 * real sed, grep, mktemp and python3.
 */
function sweepCloning({ shapes = [], clonable = [] }) {
  const root = mkdtempSync(join(tmpdir(), "check-consumers-"));
  try {
    const dir = hub(root, shapes);

    // One checkout on the current templates per name the fake git will serve.
    const served = join(root, "served");
    mkdirSync(served, { recursive: true });
    for (const name of clonable) {
      const workflows = join(served, name, ".github", "workflows");
      mkdirSync(workflows, { recursive: true });
      for (const file of TEMPLATES) {
        cpSync(join(dir, "templates", file), join(workflows, file));
      }
    }

    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "git"),
      [
        "#!/bin/sh",
        // Loud rather than silent on anything but the one call this stands in
        // for: a script that started running some other git command would
        // otherwise get a success it never earned.
        'test "$1" = clone || { echo "fake git: unexpected: $*" >&2; exit 1; }',
        "# git clone --quiet --depth 1 <url> <dest>",
        'name=${5##*/}',
        'case " $SERVED " in',
        '  *" $name "*) cp -R "$SERVED_DIR/$name" "$6"; exit 0 ;;',
        "esac",
        'echo "remote: Repository not found." >&2',
        "exit 128",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const run = spawnSync("sh", [join(dir, "scripts", "check-consumers.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SERVED: clonable.join(" "),
        SERVED_DIR: served,
      },
    });
    return { status: run.status, out: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("the private-consumer path", () => {
  it("names a private consumer the script actually iterates", () => {
    // Same vacuity guard as the public list above: every case here places a
    // fixture under these names, and a name the script does not visit makes
    // the assertions pass having read nothing.
    expect(PRIVATE_CONSUMERS?.length).toBe(1);
    const { status, out } = sweep({ consumers: ["current"] });
    expect(out).toMatch(new RegExp(`^== ${PRIVATE_CONSUMERS[0]}$`, "m"));
    expect(out).toMatch(/read 22 consumer\(s\), checked 22/);
    expect(status).toBe(0);
  });

  it("holds a migration open when the private consumer went unread", () => {
    // The end of a fleet-wide migration IS this shape: simmo goes last by
    // policy, so every public consumer is on the current templates while it
    // is still on the outgoing one -- and the cloning run cannot read it.
    // Calling that finished would delete the shape simmo is still on and turn
    // its own consumer check red, which is the breakage the guard exists to
    // prevent, arriving through the guard itself.
    const { status, out } = sweep({
      shapes: ["old-a"],
      consumers: ["current", "current"],
      privateOn: "absent",
    });
    expect(status).toBe(0);
    // Loud, not silent: the labels are still named, with what to run next.
    expect(out).toMatch(/notice: no CHECKED consumer is on these superseded/);
    expect(out).toMatch(/old-a/);
    expect(out).toMatch(new RegExp(`unread:.*\\b${PRIVATE_CONSUMERS[0]}\\b`));
    expect(out).not.toMatch(/FAIL: no checked consumer/);
  });

  it("holds a migration open when a PUBLIC consumer went unread", () => {
    // The question is being unread, not being private. A local run pointed at
    // a directory missing one sibling reads nothing about which shape that
    // sibling is on -- and this mode is the only one that can end a migration,
    // so treating its blind spot as "gone" is the same mistake with a
    // different name. `not adopted` is the other way a public consumer goes
    // unread; both reach this branch through the same list.
    const missing = CONSUMERS[1];
    const { status, out } = sweep({
      shapes: ["old-a"],
      consumers: ["current", "absent"],
    });
    expect(status).toBe(0);
    expect(out).toMatch(/notice: no CHECKED consumer is on these superseded/);
    expect(out).toMatch(new RegExp(`unread:.*\\b${missing}\\b`));
    expect(out).not.toMatch(/FAIL: no checked consumer/);
  });

  it("holds a migration open when the checker could not reach a verdict", () => {
    // Invoking the checker is not reading the consumer. A crash produces no
    // notice, so its live shape looks abandoned -- and counting the name as
    // read anyway would have had the guard call the migration over and name
    // the very shape that consumer is still on. The run is red either way;
    // what this case pins is that it is not also wrong.
    const crashed = CONSUMERS[1];
    const { status, out } = sweep({
      shapes: ["old-a"],
      consumers: ["current", "old-a!crash"],
    });
    expect(status).toBe(1);
    expect(out).toMatch(/notice: no CHECKED consumer is on these superseded/);
    expect(out).toMatch(new RegExp(`unread:.*\\b${crashed}\\b`));
    expect(out).not.toMatch(/FAIL: no checked consumer/);
  });

  it("still fails once every consumer is read and off the shape", () => {
    // The other direction, and the one the notice must not have swallowed: a
    // run that read every consumer has the information to fail on, and a
    // finished migration is exactly what it must refuse to leave offered.
    const { status, out } = sweep({
      shapes: ["old-a"],
      consumers: ["current", "current"],
      privateOn: "current",
    });
    expect(status).toBe(1);
    expect(out).toMatch(/still offered:\n {8}old-a\n/);
    expect(out).not.toMatch(/notice: no CHECKED consumer/);
  });

  it("keeps a migration open while the private consumer is the one still on it", () => {
    // Read, and still on the shape: an ordinary in-flight migration, which
    // must stay quiet whichever consumer is the laggard.
    const { status, out } = sweep({
      shapes: ["old-a"],
      consumers: ["current", "current"],
      privateOn: "old-a",
    });
    expect(status).toBe(0);
    expect(out).toMatch(/superseded shape `old-a`/);
    expect(out).not.toMatch(/still offered/);
    expect(out).not.toMatch(/notice: no CHECKED consumer/);
  });

  it("reports an unclonable private consumer as a skip, not a failure", () => {
    // The whole point: this repository's CI clones anonymously, so a private
    // consumer is unreachable there however correctly it is set up. Reading
    // that as a failure would leave the hub red on every run forever.
    const { status, out } = sweepCloning({ clonable: CONSUMERS });
    expect(status).toBe(0);
    expect(out).toMatch(
      new RegExp(`skipped:.*\\b${PRIVATE_CONSUMERS[0]}\\(private, unreachable\\)`),
    );
    expect(out).not.toMatch(
      new RegExp(`FAIL: could not clone ${PRIVATE_CONSUMERS[0]}`),
    );
    expect(out).toMatch(
      new RegExp(`read ${CONSUMERS.length} consumer\\(s\\), checked ${CONSUMERS.length}`),
    );
  });

  it("still fails when a PUBLIC consumer cannot be cloned", () => {
    // The other direction, and the one the skip above must not have widened:
    // a rename, a revoked clone, a repository that has gone away is exactly
    // what the clone-failure branch is for, and it stays a red job.
    const gone = CONSUMERS[0];
    const { status, out } = sweepCloning({
      clonable: CONSUMERS.filter((name) => name !== gone),
    });
    expect(status).toBe(1);
    expect(out).toMatch(new RegExp(`FAIL: could not clone ${gone}`));
  });

  it("checks a private consumer whose clone unexpectedly succeeds", () => {
    // Degrading in the useful direction: if one is ever opened up, or this job
    // is ever given a credential, it is checked like any other rather than
    // staying permanently skipped on the strength of its name.
    const { status, out } = sweepCloning({
      clonable: [...CONSUMERS, ...PRIVATE_CONSUMERS],
    });
    expect(status).toBe(0);
    expect(out).toMatch(new RegExp(`^== ${PRIVATE_CONSUMERS[0]}$`, "m"));
    expect(out).not.toMatch(/skipped:/);
    expect(out).toMatch(/read 22 consumer\(s\), checked 22/);
  });
});
