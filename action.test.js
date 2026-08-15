// Tests for `action.yml`, the manifest that is this repository's public
// surface.
//
// Its failure mode is silence in both directions. An input the script reads
// but the manifest never declares gets no default, so a consumer who omits it
// falls through to the script's own fallback instead of the documented one --
// and nothing errors, the sweep just runs on different numbers than the
// manifest advertises. A `main:` naming a file that isn't here fails only when
// a consumer's workflow fires, which for a scheduled sweep can be an hour
// after the mistake was pushed and in somebody else's repository.
//
// Read with regexes rather than a YAML parser on purpose: this repository ships
// no dependencies, which is what lets a floating `@v1` be reviewed by reading
// the files it runs. A parser would be the first thing to break that.
import { describe, it, expect } from "./vitest-shim.mjs";
import { readFileSync, existsSync } from "node:fs";

const manifest = readFileSync("action.yml", "utf8");
const script = readFileSync("codex-review.mjs", "utf8");

/** The `inputs:` block, so a match can't come from a description's prose. */
const inputsBlock = manifest.slice(manifest.indexOf("\ninputs:"));

/** Input names declared in the manifest -- two-space keys under `inputs:`. */
const declared = [...inputsBlock.matchAll(/^ {2}([a-z][a-z-]*):$/gm)].map((m) => m[1]);

/** Input names the script actually asks for. */
const consumed = [...script.matchAll(/\binput\("([a-z-]+)"/g)].map((m) => m[1]);

describe("action.yml", () => {
  it("found something to compare at all", () => {
    // Both cross-checks below are set differences, and a set difference
    // against an empty set is empty -- so a regex that stops matching (a
    // reindented manifest, a renamed helper) turns both of them green while
    // checking nothing. This is the case that makes the rest mean something.
    expect(declared.length).toBe(4);
    expect(consumed.length > 0).toBe(true);
  });

  it("runs the file it names", () => {
    const main = manifest.match(/^\s*main:\s*'(.+)'$/m)?.[1];
    expect(main).toBe("codex-review.mjs");
    expect(existsSync(main)).toBe(true);
  });

  it("runs on a Node the runner still supports", () => {
    // A retired runtime is a deprecation warning until the day it is a hard
    // failure, and this action's failure is a wedged merge gate.
    expect(manifest).toMatch(/using:\s*'node24'/);
  });

  it("declares every input the script reads", () => {
    // The silent half: an undeclared input has no default, so the manifest's
    // documented value and the script's fallback drift apart with nothing to
    // report it.
    const missing = consumed.filter((name) => !declared.includes(name));
    expect(missing).toEqual([]);
  });

  it("reads every input it declares", () => {
    // The other direction is only documentation rot, but it is the kind a
    // reader trusts: an input nobody consumes reads as a knob that works.
    const unused = declared.filter((name) => !consumed.includes(name));
    expect(unused).toEqual([]);
  });

  it("defaults the token and repository to the calling workflow's own", () => {
    // Both are what makes the ordinary caller a `uses:` line with no `with:`
    // at all. The token especially: a consumer that had to name one would be
    // choosing between a PAT and reading the docs, and the workflow's own
    // token is already exactly the right scope.
    expect(manifest).toMatch(/default:\s*\$\{\{\s*github\.token\s*\}\}/);
    expect(manifest).toMatch(/default:\s*\$\{\{\s*github\.repository\s*\}\}/);
  });

  it("keeps the loop shorter than an hour and the interval a real poll", () => {
    // The pair is load-bearing: the loop has to outlast the gap between
    // scheduled fires for the chain to hand over without a gap, and the
    // interval has to keep a full-length run inside the token's hourly rate
    // budget.
    const minutes = Number(inputsBlock.match(/loop-minutes:[\s\S]*?default:\s*'(\d+)'/)?.[1]);
    const seconds = Number(inputsBlock.match(/interval-seconds:[\s\S]*?default:\s*'(\d+)'/)?.[1]);
    expect(minutes > 0 && minutes < 60).toBe(true);
    expect(seconds >= 30).toBe(true);
    // Sweeps per run, against GITHUB_TOKEN's 1,000 requests an hour.
    expect((minutes * 60) / seconds).toBeLessThan(120);
  });

  it("ships no dependencies to bundle", () => {
    // The whole reason a floating tag is reviewable here: no package.json, no
    // lockfile, no build output. The moment one appears, what runs on the
    // runner stops being what a reader reads.
    expect(existsSync("package.json")).toBe(false);
    expect(existsSync("node_modules")).toBe(false);
    expect(script).not.toMatch(/^import .* from "(?!node:)[^.]/m);
  });
});
