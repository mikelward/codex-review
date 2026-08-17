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
// no dependencies, which is what lets an unpinned reference be reviewed by reading
// the files it runs. A parser would be the first thing to break that.
import { describe, it, expect } from "./vitest-shim.mjs";
import { readFileSync, existsSync } from "node:fs";

// templates/ is the single copy of each consumer file; check_consumer.py
// compares a consumer's against it byte for byte. Read directly rather than
// imported, the checker being Python.
const TEMPLATES = [
  "codex-review.yml",
  "codex-review-listener.yml",
  "codex-review-check.yml",
];
const template = (name) => readFileSync(`templates/${name}`, "utf8");

const manifest = readFileSync("action.yml", "utf8");
const script = readFileSync("codex-review.mjs", "utf8");
const readme = readFileSync("README.md", "utf8");

/**
 * What consumers are told to write in their workflow.
 *
 * This repository publishes no package and has no installer, so the README's
 * usage block *is* the installation contract -- and it is the one thing here
 * that is copied into other repositories by hand. A drift back to `@v1`, or to
 * any ref that does not exist, produces "unable to resolve action" in a
 * consumer rather than anything red here.
 */
const CONSUMER_REF = "mikelward/codex-review@main";

/**
 * Every ref the README names, qualified (`mikelward/codex-review@main`) or
 * bare in prose (`` `@main` ``).
 *
 * Both forms, because the prose uses the bare one and a drift there is just as
 * broken as a drift in the template -- a reader who follows a sentence rather
 * than the code block ends up somewhere that does not resolve. The bare
 * pattern requires the closing backtick immediately after the ref, which is
 * what keeps `` `@codex review` `` -- a mention, not a ref -- out of the
 * results.
 */
const refsIn = (text) => [
  ...[...text.matchAll(/codex-review@([\w.\/-]+)/g)].map((m) => m[1]),
  ...[...text.matchAll(/`@([\w.\/-]+)`/g)].map((m) => m[1]),
];

/** Known input for the matcher, including the mention it must ignore. */
const REF_FORMS = [
  "      - uses: mikelward/codex-review@main",
  "consumers track `@main`, and whatever it points at",
  "a drift back to `@v1` breaks somebody else's repo",
  "nothing since the push means it never picked it up -- comment `@codex review`, once",
].join("\n");

/**
 * Lines that import anything: a static or side-effect `import` opening a line,
 * or a dynamic `import(` anywhere on one.
 *
 * `import.meta` is deliberately not one — it is a property, not an import, and
 * this script uses it.
 */
const importLines = (source) =>
  source
    .split("\n")
    .filter((line) => /^\s*import\b(?!\s*\.)/.test(line) || /\bimport\s*\(/.test(line));

/**
 * A sample carrying each form, so the matcher is exercised before it is
 * trusted.
 *
 * The usual guard — "it found at least one" — is the wrong one here: this
 * script imports nothing at all, which is the strongest form of the property
 * and would fail such a check. What can still go wrong is the matcher quietly
 * matching nothing, making an empty result mean "none found" rather than "none
 * present". Checking it against known input separates those two.
 */
const IMPORT_FORMS = [
  'import a from "pkg";',
  'import "side-effect";',
  'const m = await import("dynamic");',
  'import { b } from "node:fs";',
].join("\n");

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

  it("is installed on this repository, verbatim from the template", () => {
    // The self-install's whole claim is that what runs HERE is the README's
    // consumer template; this is the assertion behind the claim, so drift in
    // the installed triggers, permissions, or action reference goes red
    // instead of quietly diverging from what consumers are told to copy.
    // Each file carries a short leading comment saying what it is and
    // pointing at docs/CONSUMER.md, so each must END with its block.
    const blocks = [...readme.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);
    expect(blocks).toHaveLength(3);
    TEMPLATES.forEach((name, i) => {
      expect(blocks[i], name).toBe(template(name));
    });
    // Installed here, byte for byte, exactly as a consumer must have them —
    // this repository is a consumer too, and check_consumer.py holds it to the
    // same comparison. Except the caller: the hub runs the check directly from
    // its own CI against its own tree, because a caller would reference the
    // reusable workflow at `@main` and so validate a pull request against the
    // previous release rather than against itself.
    for (const name of TEMPLATES.filter((n) => n !== "codex-review-check.yml")) {
      expect(readFileSync(`.github/workflows/${name}`, "utf8"), name).toBe(template(name));
    }
    expect(existsSync(".github/workflows/codex-review-check.yml")).toBe(false);
  });

  it("is installed the way the README says", () => {
    // The README is the only installation instruction there is, so a `uses:`
    // line in it that names a ref nobody publishes is a broken install with
    // nothing to report it. Asserted as the exact string rather than a pattern:
    // `@v1` and `@main` both look like refs, and only one of them exists.
    const uses = [...readme.matchAll(/^\s*-\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
    expect(uses).toEqual([CONSUMER_REF]);
  });

  it("templates what the checker compares against, not a second copy of it", () => {
    // The README template and the checker's expected files used to be the
    // same thing said twice, and nine consumers said it again. templates/ is
    // now the one copy: the README embeds it, this repository installs it,
    // and check_consumer.py compares consumers to it. Asserted rather than
    // assumed, because a README that drifts is an installation instruction
    // that silently stops matching what the check requires.
    const blocks = [...readme.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);
    expect(blocks).toHaveLength(TEMPLATES.length);
    TEMPLATES.forEach((name, i) => {
      expect(blocks[i], name).toBe(template(name));
    });
  });

  it("documents the verdict-read protocol, every source by name", () => {
    // The protocol paragraph exists because two state reports in one session
    // were each assembled from a single surface, and both were wrong. Each
    // source it requires is pinned by name, so a later edit cannot quietly
    // drop one while the paragraph itself survives — which is exactly the
    // silent regression a prose contract invites.
    const section = readme.match(/\*\*Reading the verdict is a protocol[\s\S]*?\n\n## /)?.[0];
    expect(typeof section).toBe("string");
    expect(section).toMatch(/reactions/);
    expect(section).toMatch(/\breviews\b/);
    expect(section).toMatch(/review\s+comments/);
    expect(section).toMatch(/issue\s+comments/);
    expect(section).toMatch(/commit\s+status/);
    // The trap the paragraph names: the status is not a check run, and a
    // reader who only lists check runs never sees it.
    expect(section).toMatch(/separate\s+API\s+surface\s+from\s+check\s+runs/);
  });

  it("documents the fork limitation with the remedy and the trap", () => {
    // Recorded rather than fixed, by decision: no fork pull request has been
    // observed against these repositories, so this is a note for whoever
    // meets one first. That makes it exactly the kind of prose that rots —
    // the section survives while the part that makes it actionable is
    // trimmed — so the load-bearing claims are pinned individually.
    const doc = readFileSync("docs/CONSUMER.md", "utf8");
    const section = doc.match(/## Known limitation: fork pull requests[\s\S]*?\n## /)?.[0];
    expect(typeof section).toBe("string");
    // Why it happens: the head-associated check comes from `push`, which a
    // fork does not perform here.
    expect(section).toMatch(/`push`/);
    expect(section).toMatch(/pull_request_target/);
    // The remedy, including the scope that keeps the sole-writer rule intact.
    expect(section).toMatch(/head\.sha/);
    expect(section).toMatch(/`checks: write`/);
    expect(section).toMatch(/not `statuses: write`/);
    // The half that makes the remedy actually work: a reusable workflow's
    // permissions block can only narrow what the caller passes, so granting
    // the scope in the caller alone is silently stripped by
    // check-consumer.yml's own `contents: read` — and the required check
    // then never reports, which is the failure this section is about.
    expect(section).toMatch(/[Bb]oth ends need the scope/);
    expect(section).toMatch(/narrow/);
    expect(section).toMatch(/check-consumer\.yml/);
    // And the instruction NOT to loosen the permission scan while
    // implementing it: `judge` already reads `checks: write` as safe, so an
    // implementer "making room" for it would only weaken the check that
    // keeps the sole statuses writer sole.
    expect(section).toMatch(/lets the caller through unchanged/);
    // The other direction, which is what makes the remedy safe rather than a
    // new hole: once a self-published context is required, `checks: write`
    // becomes a forging capability, so the scan must reserve it the way it
    // already reserves `statuses: write`.
    expect(section).toMatch(/stricter/);
    expect(section).toMatch(/reserve `checks: write`/);
    // And the push-run fallback: `github.event.pull_request` is absent on a
    // push, so publishing against head.sha alone leaves ordinary runs red.
    expect(section).toMatch(/head\.sha \|\| github\.sha/);
    expect(section).toMatch(/loosening the\s+permission scan|loosen the\s+permission scan/);
    // And that the remedy is only half the gate: the `codex` status blocks a
    // fork head separately and on purpose, because a fork's check suites
    // carry no head_branch and so never date the head's arrival. Without
    // this, an implementer does the whole `checks: write` migration and the
    // fork pull request is still unmergeable, by a floor they were never
    // told about.
    expect(section).toMatch(/head_branch/);
    expect(section).toMatch(/undatable/);
    expect(section).toMatch(/admin override/);
    // And the trap: the obvious fix reopens the hole the check exists for.
    expect(section).toMatch(/Do not fix it with a plain `pull_request` trigger/);
  });

  it("sweeps every sibling AGENTS.md names, with neither list hard-coded twice", () => {
    // `check-consumers.sh` stopped being a sample of three and now names every
    // SIBLING, which moves its failure mode: an omitted or misspelled
    // repository is never visited, so the run reports success having skipped
    // it silently. That is the false pass this suite exists for.
    //
    // It is not a registry of everyone using the action -- this one is public
    // and unpinned, so an outside adopter never appears here and is served by
    // running the check in their own CI. What this asserts is only that the
    // siblings AGENTS.md claims responsibility for are the ones actually swept.
    //
    // Derived from AGENTS.md rather than pinned to a second copy of the nine
    // names, so drift in EITHER file is caught and neither can be the one that
    // quietly becomes wrong.
    const agents = readFileSync("AGENTS.md", "utf8");
    const sweep = readFileSync("scripts/check-consumers.sh", "utf8");

    const named = agents
      .match(/Nine sibling repositories consume this:([\s\S]*?)\. A change/)?.[1]
      ?.match(/`([a-z-]+)`/g)
      ?.map((m) => m.slice(1, -1));
    const listed = sweep.match(/^CONSUMERS="([^"]+)"$/m)?.[1]?.split(" ");

    // Both regexes before either comparison: a set difference against an empty
    // set is empty, so a reindented AGENTS.md bullet or a requoted CONSUMERS
    // line would turn the assertion below green while checking nothing.
    expect(named?.length).toBe(9);
    expect(listed?.length).toBe(9);
    expect([...named].sort()).toEqual([...listed].sort());
  });

  it("makes the consumer check dispatchable, and is not mid-migration", () => {
    // `workflow_dispatch` is here for one reason: a pull request created by
    // GITHUB_TOKEN triggers neither `push` nor `pull_request_target` --
    // GitHub's loop-prevention rule -- so a repository whose dependency
    // updates are opened by a bot would have no run of this check on that
    // head at all, and requiring it would block those merges forever.
    // Dispatch is the documented exception: a dispatch made with
    // GITHUB_TOKEN does create a run.
    const caller = template("codex-review-check.yml");
    expect(caller).toMatch(/^ {2}workflow_dispatch:$/m);
    // Safe here in a way it is not on the sweep, which omits it deliberately:
    // dispatch runs the workflow file FROM THE GIVEN REF, and the sweep holds
    // `statuses: write`. This caller holds `contents: read` and nothing else,
    // and its definition is already the branch's own by way of `push`, so
    // dispatch adds no capability a branch did not have.
    expect(caller).toMatch(/permissions:\n {2}contents: read\n/);
    expect(caller).not.toMatch(/statuses:/);

    // And the reason, written where a consumer meets it. A trigger nobody can
    // explain is one a later tidy-up removes, and removing this one blocks
    // every bot-authored pull request the day the check is required. This is
    // published behavior rather than anything about migrations, so it is
    // asserted here whatever the pin's state.
    const doc = readFileSync("docs/CONSUMER.md", "utf8");
    expect(doc).toMatch(/GITHUB_TOKEN` triggers no `on: pull_request`/);
    expect(doc).toMatch(/gh workflow run codex-review-check\.yml/);
    expect(doc).toMatch(/actions: write/);
    // Including the asymmetry with the sweep, which must not take it.
    expect(doc).toMatch(/the sweep deliberately does \*\*not\*\* take this trigger/);

    // The state of the pin itself is NOT asserted here, and the reason is
    // worth writing down because the obvious assertion is wrong.
    //
    // A finished migration left in place is a real failure mode -- silent,
    // costing nothing visible, quietly leaving the pin accepting two shapes
    // forever. But "templates/superseded must not exist" cannot be the guard:
    // a migration STARTS by adding that directory in the same commit that
    // edits the template, so a static absence check goes red on the opening
    // commit, which cannot merge, so consumers can never move -- exactly the
    // deadlock templates/superseded/ exists to remove.
    //
    // Only one thing can tell a finished migration from an active one: which
    // consumers still match the outgoing shape. scripts/check-consumers.sh
    // knows that and nothing here does, so the check lives there -- and is
    // tested there too, in check-consumers.test.js, by running the script over
    // synthetic hubs rather than by matching its source text. A string match
    // from this side would stay green if the script kept the strings and
    // stopped setting `failed`, which is the false pass this suite is most at
    // risk of.
  });

  it("documents the template-migration mechanism a consumer will meet", () => {
    // A consumer's first contact with this is a `notice:` line on a check
    // that is otherwise green. Undocumented, it reads as either a failure to
    // panic about or noise to ignore -- and the second is how a migration
    // stops finishing. Pinned because it is prose whose whole value is being
    // there on the day it is needed.
    const doc = readFileSync("docs/CONSUMER.md", "utf8");
    // Ends at the next `##` heading OR at end of file -- this section is
    // currently the last one, so anchoring only on a following heading would
    // find nothing and make every assertion below vacuous.
    const section = doc.match(/### When a template changes[\s\S]*?(?=\n## |$)/)?.[0];
    expect(typeof section).toBe("string");
    // What the reader sees, and that it does not mean they are broken.
    expect(section).toMatch(/notice:/);
    expect(section).toMatch(/green/);
    // Where the outgoing shape lives, and what to do about it.
    expect(section).toMatch(/templates\/superseded/);
    // The three bounds that keep "accepted for now" from becoming permanent
    // or from widening into a hole. The middle one is the sharp one: a shape
    // is matched whole, so an old file beside current ones is refused.
    expect(section).toMatch(/not a relaxation/);
    expect(section).toMatch(/all three files as\s+they were shipped together/);
    expect(section).toMatch(/deleted once the last consumer\s+has moved/);
  });

  it("documents that the head's check comes from the PR's own push", () => {
    // The sharper of the two limitations, because it applies to the
    // same-repository pull requests these repositories actually take: the
    // run that lands on the head is the `push` one, whose definition is the
    // pull request's. Without this written down, a consumer requires the
    // context believing it proves something it cannot.
    const doc = readFileSync("docs/CONSUMER.md", "utf8");
    const section = doc.match(/## Known limitation: the head's `codex-review-check`[\s\S]*?\n## /)?.[0];
    expect(typeof section).toBe("string");
    // The mechanism, and that it was observed rather than reasoned out.
    expect(section).toMatch(/`push`/);
    expect(section).toMatch(/event: push/);
    // BOTH branch-defined routes. `workflow_dispatch` was added later and is
    // the only head-associated run a bot-authored pull request gets, so a
    // section naming only `push` sends a reader checking provenance to the
    // wrong place -- and reads as though dispatch were a third, safer route.
    expect(section).toMatch(/workflow_dispatch/);
    expect(section).toMatch(/no weaker\s+than `push` and no stronger/);
    // The remedy is a ruleset setting naming a workflow, not a context.
    expect(section).toMatch(/Require workflows to pass before merging/);
    expect(section).toMatch(/check-consumer\.yml@main/);
    // ...and that it is organization-only, so it is not available to these
    // repositories today. Without this the section reads as an actionable fix
    // nobody can action.
    expect(section).toMatch(/organization/);
    expect(section).toMatch(/personal account/);
    // The remedy that IS available: move the comparison inside the sweep,
    // whose definition a branch cannot supply.
    expect(section).toMatch(/inside the sweep/);
    // And the bound on what is actually at risk: the verdict gate is not,
    // because the sweep's definition is never the pull request's.
    expect(section).toMatch(/accident/);
    expect(section).toMatch(/pull_request_target/);
  });

  it("documents the expected consumer ruleset, all three rules and both holds", () => {
    // Consumers configure branch protection from this section alone, so a
    // rule dropped from it is a consumer left unprotected with nothing red
    // anywhere. All three rules, both reliable holds, the per-pull-request
    // auto-merge opt-in (the repository setting only PERMITS auto-merge; a PR
    // that never opts in sits open forever looking approved), and the honest
    // best-effort framing of reaction holds.
    const section = readme.match(/## The ruleset this expects\n[\s\S]*?\n## /)?.[0];
    expect(typeof section).toBe("string");
    expect(section).toMatch(/Require the `codex` status check/);
    expect(section).toMatch(/Require\s+conversation\s+resolution/);
    expect(section).toMatch(/Allow\s+auto-merge/);
    expect(section).toMatch(/each\s+pull\s+request/);
    expect(section).toMatch(/review\s+thread/);
    expect(section).toMatch(/draft/);
    expect(section).toMatch(/best\s+effort/);
  });

  it("names one ref throughout, template and prose alike", () => {
    // The prose around the template mentions refs too, and a reader who
    // follows those rather than the code block has to land in the same place.
    //
    // Every occurrence collected and compared as a set, rather than asserting
    // the absence of `@v1`: absence is unbounded, so a negative check only
    // ever rejects the spellings someone thought of. This one rejects
    // anything that is not the ref consumers are meant to use.
    // Prove the matcher on known input first: it must find the qualified form
    // AND the bare prose form, and must not mistake `@codex review` for a ref.
    // Without this the test passed while seeing only the template line, so its
    // name promised more than it checked.
    expect([...new Set(refsIn(REF_FORMS))].sort()).toEqual(["main", "v1"]);

    const refs = refsIn(readme);
    expect(refs.length > 1).toBe(true);
    expect([...new Set(refs)]).toEqual(["main"]);
  });

  it("ships no dependencies to bundle", () => {
    // The whole reason an unpinned reference is reviewable here: no
    // package.json, no lockfile, no build output. The moment one appears, what
    // runs on the runner stops being what a reader reads.
    expect(existsSync("package.json")).toBe(false);
    expect(existsSync("node_modules")).toBe(false);
    // Every import checked by its specifier, rather than asserting the absence
    // of a bare one: a negative pattern would have to anticipate every way an
    // import can be written -- `import x, {y} from`, a side-effect
    // `import "pkg"`, a dynamic `import()` -- and would go green on the first
    // form it did not know.
    //
    // Not "no external imports" but "no imports": the sweep reaches for
    // nothing at all, which is what makes reviewing it a matter of reading one
    // file. Collected and compared to empty rather than asserted absent, and
    // the matcher checked against IMPORT_FORMS first so an empty list means
    // none are present rather than none were found.
    expect(importLines(IMPORT_FORMS)).toHaveLength(4);
    expect(importLines(script)).toEqual([]);
  });
});

describe("the autopilot decision record", () => {
  it("is a contract in AGENTS.md, not just a file that happens to exist", () => {
    // TODO.md's heading is where an unasked question goes to be seen. If the
    // rule requiring it lives only in the habit of whoever wrote the file,
    // the next agent keeps autopilot's speed while quietly spending the
    // owner's judgment — which is the one thing autopilot trades away.
    const agents = readFileSync("AGENTS.md", "utf8");
    const section = agents.match(/## Autopilot[\s\S]*?\n## /)?.[0];
    expect(typeof section).toBe("string");
    expect(section).toContain("TODO.md");
    expect(section).toMatch(/Decisions\s+needing\s+review/);
    // The three things that make an entry reviewable rather than a note.
    expect(section).toMatch(/what was decided/);
    expect(section).toMatch(/alternative/);
    expect(section).toMatch(/undoing it would cost/);
  });

  it("keeps the heading the rule names", () => {
    // Asserted against the file itself, so renaming the heading breaks here
    // rather than silently orphaning every entry under it.
    const todo = readFileSync("TODO.md", "utf8");
    expect(todo).toMatch(/^## Decisions needing review$/m);
  });
});
