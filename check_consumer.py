#!/usr/bin/env python3
"""Check that a consuming repository's codex-review workflows are correct.

This lived as a hand-written test in each of the nine consumers -- shell,
JavaScript, Rust and Python -- and drifted the way a duplicated invariant does.
Three holes were found by review in three different copies in one afternoon:
``"permissions":`` is valid YAML that a ``permissions:`` pattern misses, a blank
line inside a mapping is not the end of it, and YAML's explicit-key form
(``? permissions``) matches nothing at all. Each fix then had to be hand-carried
into eight other files, and until it was, eight repositories had the hole. So it
is one implementation now, with one suite.

It asks two questions, and answers them by deliberately different means.

**Are the three codex-review files exactly the shipped ones?** Compared byte for
byte against ``templates/``, with no parsing whatsoever. They are identical in
every consumer, so there is nothing to interpret and no notation to approximate:
the question is not "what does this file mean" but "is this the file". That
removes the entire YAML-notation surface from the files that matter most, which
is why the reasoning that used to justify each line lives in docs/CONSUMER.md
rather than in a header each consumer could edit.

"The shipped ones" is a SET, not a single file, and that is what makes a
template change possible at all -- see ``superseded_shapes``. Each member is
still an exact match; what the set buys is that consumers can move one at a
time instead of all at the instant a template merges.

**Can any other workflow write commit statuses?** These differ per repository --
ci.yml, release.yml, dependency-update.yml -- so they cannot be pinned, and this
is the one place a workflow has to be understood rather than compared. It is
parsed with PyYAML, because eight separate review rounds established that a
pattern over YAML is not a reading of YAML: ``write-all``, a ``.yaml`` filename,
``statuses: "write"``, ``"pull_request":``, ``"permissions":``, a bare sequence
dash, a blank line inside a mapping, and the explicit-key form each got past
one. A parser has no such list to keep up to date.

The sole-writer rule matters because a commit status belongs to the SHA: a
second writer is an unordered write, and one delayed past the sweep's exit
overwrites a fresh verdict with a stale one, with nothing to report that it
happened. A ``codex-verdict-reset`` workflow did exactly that and was deleted for
it. The rule guards the ``codex`` CONTEXT, not the scope for its own sake, so
it has exactly one shape-checked excuse: a job that consists of nothing but
the lanes engine (``mikelward/lanes@main``, plus a checkout it reads from)
can only ever write the ``lanes`` context and is allowed its job-level
``statuses: write`` -- see ``lanes_publisher_only`` for the fail-closed
judgment. Every other workflow must also DECLARE a top-level permissions block, since
declaring none is not the same as granting nothing -- it inherits the
repository's default GITHUB_TOKEN permission, a repository setting no file in
the tree can read. That found real holes in two consumers on the day it was
written.

PyYAML rather than an npm package on purpose: this repository ships no
dependencies, which is what lets a consumer review an unpinned ``@main``
reference by reading the files. The runner's Python is not a dependency taken
on, it is part of the image, the way ``git`` and ``bash`` are.

Usage: python3 check_consumer.py [<repo root>]
Exits 0 when the consumer is correct, 1 with a report when it is not.
"""

import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - the message is the behavior
    # Fails CLOSED, and that is what makes taking PyYAML from the runner
    # image acceptable rather than reckless: nothing is fetched at gate time,
    # and if the image ever stops shipping it, every consumer's check goes
    # red saying exactly this instead of passing without having parsed
    # anything. See .github/workflows/check-consumer.yml.
    sys.exit(
        "error: this check needs PyYAML, and this machine has no yaml module.\n"
        "  GitHub's runner images supply it; CI installs nothing on purpose.\n"
        "  On a bare machine: python3 -m pip install --user pyyaml"
    )

HERE = Path(__file__).resolve().parent


class _StrictLoader(yaml.SafeLoader):
    """safe_load, except duplicate mapping keys are an error.

    PyYAML silently keeps the LAST duplicate key, so a workflow with two
    ``permissions:`` blocks would be judged only on the second. GitHub's own
    parser rejects such a file today, which keeps the direction safe — but
    that safety would live in GitHub's parser, not here, and this check's
    principle is to report what it cannot be sure of rather than inherit
    someone else's refusal.
    """


def _mapping_without_duplicates(loader, node, deep=False):
    # A scalar key compares by its RAW TEXT, not `construct_object`'s parsed
    # value: PyYAML implements YAML 1.1, where `on`, `On`, `yes`, and `y` all
    # resolve to the same Python `True`, while GitHub's own parser is closer
    # to 1.2 and reads each as a distinct string. Coercing them together
    # would report a workflow's genuinely different keys (`on:` alongside an
    # `env:` entry literally named `yes:`, say) as a duplicate that does not
    # exist on GitHub's side — the same version-skew guard `judge` already
    # documents for permission values, applied here too. Non-scalar keys
    # (rare in workflow YAML) fall back to the parsed value; nothing this
    # check cares about hangs on distinguishing those.
    seen = set()
    for key_node, _ in node.value:
        key = key_node.value if isinstance(key_node, yaml.ScalarNode) else loader.construct_object(key_node, deep=deep)
        if key in seen:
            raise yaml.YAMLError(f"duplicate mapping key {key!r}")
        seen.add(key)
    return yaml.SafeLoader.construct_mapping(loader, node, deep)


_StrictLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _mapping_without_duplicates
)


def parse_workflow(text):
    """The one YAML entry point: every parse failure lands in the caller's
    fail-closed "could not be parsed" report."""
    return yaml.load(text, Loader=_StrictLoader)


SWEEP = "codex-review.yml"
LISTENER = "codex-review-listener.yml"
CALLER = "codex-review-check.yml"

def is_hub(root):
    """Is this tree the hub -- this repository -- rather than a consumer of it?

    The hub provides the check, so it runs it directly from its own CI against
    its own tree, and has no caller to pin: a caller would reference the
    reusable workflow at ``@main``, which is the released version rather than
    the one under review, so a pull request changing a template or the checker
    would be validated against the previous release and never exercise its own
    change. Its other two workflow files are still pinned, since the hub is a
    consumer in every other respect.

    Identity is the directory this file is IN, not a file the tree contains.
    A marker filename is something a consumer can hold by accident -- a
    vendored copy, an unrelated local checker -- and holding it would drop the
    caller from what that consumer must have, so a missing or drifted caller
    would report success. A path cannot be held by accident: the hub is where
    the checker lives, and every consumer is somewhere else.
    """
    return Path(root).resolve() == HERE

#: The three files a consumer must have, byte for byte.
#:
#: The caller is pinned along with the other two for a reason worth stating:
#: without it a consumer could delete or neuter the file that runs this check
#: and nothing would object, since the thing that would object is what was
#: deleted. Pinning it means that whenever the check does run it verifies its
#: own invocation -- and a consumer that removes it has no green
#: ``codex-review-check`` for its ruleset to require.
TEMPLATES = (SWEEP, LISTENER, CALLER)

#: The permission levels a scope may legitimately be set to.
LEVELS = ("read", "write", "none")


def template(name, root=HERE):
    """The shipped bytes of one consumer file."""
    return (root / "templates" / name).read_text()


#: Where shapes that are no longer current, but are still accepted, live.
#:
#: One subdirectory per shape, named for what changed, holding a COMPLETE copy
#: of all three files as they were shipped together. Nothing globs
#: ``templates/`` -- every reader names a file -- so nesting this inside it
#: keeps "what shape may a consumer have" answerable from one directory.
SUPERSEDED = "superseded"

#: What a shape's label may be called.
#:
#: A label is not just a directory name: it is quoted into the ``notice:`` line
#: a consumer reads, and the hub's own sweep reads it back out of that line to
#: decide which migrations are still under way. A backtick in a label truncates
#: that read, so the sweep sees a different label than the one it offered,
#: finds no consumer on it, and calls a live migration finished -- telling a
#: maintainer to delete a shape people are still using. A leading `-` is read
#: by the tools downstream as an option rather than a name. None of that is
#: worth carrying: labels are authored here, by hand, a few times ever, so the
#: rule is a plain name and anything else is an authoring error reported by
#: name.
LABEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\Z")


def superseded_shapes(root=HERE):
    """Older still-accepted shapes, keyed by label; each a complete file set.

    This is the whole migration mechanism, and it exists because the byte-for-
    byte pin has no other way through. A consumer's files are compared against
    ``templates/`` at ``@main``, so changing a template makes every consumer
    mismatch the instant it merges -- while the hub's own CI checks real
    consumer trees against the revision under review, so the change is red
    before it can merge and the consumers cannot be fixed until it has. That is
    a deadlock, and it gets worse with every repository added.

    Accepting a set of shapes rather than one breaks it without weakening the
    comparison: each shape is still an exact match against files in this
    repository. A template change adds the outgoing shape here (nothing goes
    red), consumers migrate one at a time, and deleting the directory is what
    ends the migration -- and what makes the pin single-shaped again.

    A shape is a WHOLE SET, and matched as one. Storing only the file a
    migration changed, and falling back to the current template for the rest,
    would accept the cartesian product of per-file versions: a consumer could
    hold an old file from one label beside current versions of the others, a
    combination this repository never shipped. That is not hypothetical for
    these three -- the sweep names the listener in its ``workflow_run`` trigger,
    so they are two ends of one relay, and a migration touching that pair has a
    mixed state that is broken rather than merely old. Keeping each label
    complete costs two extra small files and removes the question.

    Returning a mapping rather than a bare list is deliberate: a consumer on an
    old shape is REPORTED by label, never silently passed. A migration nobody
    can see is how "accepted for now" becomes permanent.
    """
    directory = root / "templates" / SUPERSEDED
    if not directory.is_dir():
        return {}
    shapes = {}
    for shape in sorted(directory.iterdir()):
        if not shape.is_dir():
            continue
        shapes[shape.name] = {
            name: (shape / name).read_text()
            for name in TEMPLATES
            if (shape / name).is_file()
        }
    return shapes


def is_workflow(name):
    """Both extensions GitHub accepts.

    Filtering to ``.yml`` alone would let a ``.yaml`` file grant
    ``statuses: write`` while the sole-writer check still passed -- the
    invariant bypassed by a filename, with the check reporting green.
    """
    return name.endswith((".yml", ".yaml"))


def first_difference(actual, expected):
    """The 1-based line where two texts first differ, or None."""
    a, b = actual.split("\n"), expected.split("\n")
    for i in range(max(len(a), len(b))):
        if (a[i] if i < len(a) else None) != (b[i] if i < len(b) else None):
            return i + 1
    return None


def permission_values(doc):
    """Every permissions value in a parsed workflow, as ``(where, value, job)``.

    Per-job values are deliberately included -- without them a job-level grant
    could hide under a top-level block that disclaims it. ``job`` is the job's
    own parsed mapping for a job-level value, so a caller can judge the grant
    against what the job actually runs (see ``lanes_publisher_only``), and
    ``None`` for the top-level block, which governs every job at once and is
    never excusable that way.
    """
    found = []
    if not isinstance(doc, dict):
        return found
    if "permissions" in doc:
        found.append(("top level", doc["permissions"], None))
    jobs = doc.get("jobs")
    if isinstance(jobs, dict):
        for name, job in jobs.items():
            if isinstance(job, dict) and "permissions" in job:
                found.append((f"job `{name}`", job["permissions"], job))
    return found


#: The docs-lane engine, the one other identity trusted to write a status --
#: tracked ``@main`` exactly as consumers track this repository, so excusing
#: it adds nobody new to the trust list. Only this ref: a branch or SHA of the
#: same action is not the released engine.
LANES_ACTION = "mikelward/lanes@main"


#: The only keys an excused job may carry. A whitelist rather than a list of
#: forbidden ones, because the forbidden list is GitHub's to grow: `env`
#: injects into the action's own process (`NODE_OPTIONS: --require` loads
#: repository code inside the job that holds the grant), `container`/
#: `services` supply an execution environment, `defaults` rewrites how steps
#: run -- and the next such key ships without notice here. Every key outside
#: this set collapses the excuse, whatever it means.
PUBLISHER_JOB_KEYS = frozenset(
    ("name", "runs-on", "timeout-minutes", "needs", "if", "environment", "permissions", "steps")
)

#: The GitHub-hosted runner labels an excused job may name. A self-hosted
#: runner (a bare custom label, or the literal `self-hosted`) is a machine
#: whatever else already runs there can read the job's environment from --
#: including a `statuses: write` token every allowlisted step and input
#: still leaves reachable. Enumerated exactly, not by prefix: a self-hosted
#: runner group is free to label itself `ubuntu-anything`, and a prefix
#: match would accept it as if it were GitHub's own image. Kept to the
#: standard three OSes' `-latest` and dated aliases in current use; add to
#: this set deliberately; a version this file has never heard of is
#: refused, not guessed at.
PUBLISHER_RUNNERS = frozenset(
    (
        "ubuntu-latest",
        "ubuntu-24.04",
        "ubuntu-22.04",
        "windows-latest",
        "windows-2025",
        "windows-2022",
        "macos-latest",
        "macos-15",
        "macos-14",
        "macos-13",
    )
)

# A residual gap this whitelist does NOT close, flagged by review and left
# open rather than papered over: a self-hosted runner can register under
# ANY label, including the exact string "ubuntu-latest" -- GitHub does not
# reserve these strings for its own hosted fleet, it only auto-attaches
# them to the runners it provisions. Whether a given label in a workflow
# FILE resolves to GitHub's own machine or to a same-named self-hosted one
# is an account-configuration fact this check cannot see: it parses text,
# it makes no API call to list registered runners (the no-dependencies,
# file-only design every consumer trusts this check FOR), and nothing in
# the YAML distinguishes the two cases. Adopting the lanes publisher
# pattern therefore carries an unstated prerequisite this check cannot
# verify or enforce: the repository (and any organization providing its
# runners) must hold no self-hosted runner labeled with a string in this
# set. That is an administrative fact about the account, not a property
# of the workflow file, and closing it for real would mean this check
# calling the runners API with a token scoped to read them -- a different
# trust model than "read the files, answer from what they say" this
# checker has held since it replaced nine hand-written copies. Left open
# rather than half-closed with a check that cannot actually verify what it
# would be asserting.


#: Same reasoning, per step: `env` is the known injection channel, and
#: anything else unrecognized is refused rather than interpreted.
PUBLISHER_STEP_KEYS = frozenset(("name", "id", "uses", "with", "if"))

#: The only inputs an excused checkout step may pass. `github-server-url`
#: is the known exfiltration channel -- checkout authenticates its fetch
#: with its default `github.token` input, so pointing it at another host
#: hands that server the job's ambient token, `statuses: write` included,
#: before `persist-credentials: false` ever applies -- and `token`,
#: `ssh-key`, and the rest are refused unrecognized on the same whitelist
#: principle as everywhere else. The publisher pattern needs exactly a ref
#: (the synthetic merge) and credential non-persistence.
PUBLISHER_CHECKOUT_INPUTS = frozenset(("ref", "persist-credentials"))


def lanes_publisher_only(job, workflow=None):
    """True when a job's grant could only ever write the ``lanes`` context.

    The fleet's trusted-verdicts design (mikelward/lanes TODO.md, "Trusted
    verdicts need an explicit publisher") posts the required ``lanes`` verdict
    as an App-authenticated commit status, and the two jobs that do it -- a
    consumer's ``init`` and ``finalize`` -- must hold ``statuses: write``.
    That coexists with the sole-writer rule only because of what those jobs
    are made of: the lanes engine hard-codes its status context to ``lanes``,
    so a job that executes nothing else has no way to touch ``codex``.

    Judged fail-closed from the job's own shape, by whitelist. The job and
    each of its steps may carry only the keys in ``PUBLISHER_JOB_KEYS`` /
    ``PUBLISHER_STEP_KEYS`` -- which is what keeps ``run:`` steps,
    ``container:``/``services:`` images, and above all ``env:`` out: an
    environment value like ``NODE_OPTIONS: --require ./payload.js`` makes
    the action's own Node process load repository-controlled code inside
    the job that holds the grant. A workflow-level ``env:`` reaches every
    job the same way, so its presence anywhere in the file (pass the parsed
    workflow as ``workflow``) disqualifies too. Each step's ``uses:`` must
    be either the engine itself at exactly ``@main`` or ``actions/checkout``
    (the finalizer reads ``.github/lanes.conf`` from a checkout; the
    checkout action fetches files and executes none of them), and at least
    one step must be the engine, or the grant excuses a job that publishes
    nothing -- and a checkout step's inputs are whitelisted too
    (``PUBLISHER_CHECKOUT_INPUTS``): ``github-server-url`` would hand the
    job's ambient token, this grant included, to whatever host it names.
    ``runs-on`` must also name one of ``PUBLISHER_RUNNERS`` exactly: a
    self-hosted runner is a machine whatever else runs there can read the
    grant's token from, whatever the job's own steps declare. Anything
    unrecognized is False, which reports the job rather than excusing it.
    """
    if workflow is not None and (not isinstance(workflow, dict) or "env" in workflow):
        return False
    if not isinstance(job, dict) or not set(job) <= PUBLISHER_JOB_KEYS:
        return False
    if job.get("runs-on") not in PUBLISHER_RUNNERS:
        return False
    steps = job.get("steps")
    if not isinstance(steps, list) or not steps:
        return False
    ran_engine = False
    for step in steps:
        if not isinstance(step, dict) or not set(step) <= PUBLISHER_STEP_KEYS:
            return False
        uses = step.get("uses")
        if uses == LANES_ACTION:
            ran_engine = True
        elif isinstance(uses, str) and uses.startswith("actions/checkout@"):
            inputs = step.get("with", {})
            if not isinstance(inputs, dict) or not set(inputs) <= PUBLISHER_CHECKOUT_INPUTS:
                return False
        else:
            return False
    return ran_engine


def judge(value):
    """What a permissions value grants: ``"write"``, ``"safe"``, or a complaint.

    Reads what the value GRANTS rather than searching it for forbidden
    spellings. ``write-all`` is the blanket form and grants every scope
    including this one; otherwise it is a mapping, and only an explicit
    ``statuses`` entry above ``read`` counts.

    Anything else -- a boolean, a number, a nested structure -- is REPORTED
    rather than interpreted. That is the guard against YAML version skew:
    PyYAML implements YAML 1.1, where an unquoted ``no`` is the boolean False
    and an unquoted ``on`` is True, while GitHub's own parser is closer to 1.2.
    None of the keys or values read here is ambiguous between the two, and this
    is what keeps it that way: if a version quirk ever turns one of them into
    something unexpected, the result is a red check rather than a wrong answer.
    """
    if isinstance(value, str):
        if value.strip() == "write-all":
            return "write"
        if value.strip() in ("read-all", "{}"):
            return "safe"
        return f"unrecognized permissions value {value!r}"
    if value == {} or value is None:
        return "safe"
    if not isinstance(value, dict):
        return f"unrecognized permissions value {value!r}"
    for scope, level in value.items():
        if not isinstance(scope, str) or not isinstance(level, str):
            return f"unrecognized permissions entry {scope!r}: {level!r}"
        if level not in LEVELS:
            return f"unrecognized permission level {level!r} for {scope!r}"
        if scope == "statuses" and level == "write":
            return "write"
    return "safe"


def check_consumer(root=".", templates_root=None, notices=None):
    """Check one consumer repository. Returns a list of problems, empty if correct.

    ``notices`` is an optional list to append non-fatal reports to -- today,
    that a file matches a superseded shape rather than the current template.
    They are kept out of the return value because they must not decide the exit
    status: a consumer mid-migration is correct, just not yet moved. They are
    an out-parameter rather than a second return value so that every existing
    caller keeps working; pass a list when you intend to show them.
    """
    root = Path(root)
    workflows = root / ".github" / "workflows"
    problems = []

    if not workflows.is_dir():
        return [f"{workflows} does not exist — a consumer needs all three codex-review files"]

    present = sorted(p.name for p in workflows.iterdir() if is_workflow(p.name))
    hub = is_hub(root)
    required = [n for n in TEMPLATES if not (hub and n == CALLER)]

    # 1. The files, byte for byte. No parsing: the question is whether these
    # are the shipped files, not what they mean.
    templates = templates_root or HERE
    for name in required:
        if name not in present:
            problems.append(
                f"{name} is missing — nothing in this repository runs this check"
                if name == CALLER
                else f"{name} is missing — the relay needs both ends"
            )

    if all(name in present for name in required):
        actual = {name: (workflows / name).read_text() for name in required}
        current = {name: template(name, templates) for name in required}
        shapes = superseded_shapes(templates)

        # A shape recorded without every file is an authoring mistake here, not
        # a consumer's fault, and it must not read as "no shape matched" — that
        # would fail a consumer for a defect in the mechanism. Fail loudly
        # naming the label instead.
        for label, files in shapes.items():
            if not LABEL.match(label):
                problems.append(
                    f"the superseded shape `{label}` has an unusable name — a label is "
                    "quoted into a notice and read back out of it by tooling, so it must "
                    "start with a letter or digit and hold only letters, digits, `.`, `_` "
                    "and `-`"
                )
            absent = [name for name in TEMPLATES if name not in files]
            if absent:
                problems.append(
                    f"the superseded shape `{label}` is incomplete — it is missing "
                    f"{', '.join(absent)}. A shape is matched whole, so it must hold "
                    "all three files as they were shipped together"
                )

        if actual != current:
            # Matched as a SET, against one label. Per-file matching would
            # accept the cartesian product of versions: an old file from one
            # label beside current versions of the rest is a combination this
            # repository never shipped, and for the sweep and listener -- two
            # ends of one relay -- a mixed pair is broken rather than merely old.
            shape = next(
                (
                    label
                    for label, files in shapes.items()
                    if all(name in files and files[name] == actual[name] for name in required)
                ),
                None,
            )
            if shape is not None:
                if notices is not None:
                    notices.append(
                        f"matches the superseded shape `{shape}` rather than the current "
                        "templates — migrate by copying templates/ from "
                        "mikelward/codex-review; the shape is accepted only until the "
                        "last consumer has moved"
                    )
            else:
                for name in required:
                    if actual[name] == current[name]:
                        continue
                    line = first_difference(actual[name], current[name])
                    problems.append(
                        f"{name} differs from the shipped template at line {line} — copy "
                        "templates/ from mikelward/codex-review; the reasoning is in "
                        "docs/CONSUMER.md"
                    )

    # 2. Every other workflow, parsed. The listener and the caller are among
    # these and are pinned above, so this is never vacuous even in a repository
    # whose only workflows are the three.
    for name in present:
        if name == SWEEP:
            continue
        try:
            doc = parse_workflow((workflows / name).read_text())
        except yaml.YAMLError as error:
            # Fail closed: a question that could not be asked is not a question
            # answered "no".
            problems.append(f"{name} could not be parsed, so it cannot be checked — {error}")
            continue

        values = permission_values(doc)
        if not any(where == "top level" for where, _, _ in values):
            problems.append(
                f"{name} declares no top-level permissions block, so its jobs "
                "inherit the repository's default GITHUB_TOKEN permission — a "
                "setting no file in the repo can read, and one that may be "
                "read/write"
            )

        for where, value, job in values:
            verdict = judge(value)
            if verdict == "write":
                # The one excuse: a job that is nothing but the lanes engine
                # (plus a checkout it reads from) can only ever write the
                # `lanes` context, never `codex` -- see lanes_publisher_only.
                if job is not None and lanes_publisher_only(job, doc):
                    continue
                problems.append(
                    f"{name} can write commit statuses ({where}), and only {SWEEP} "
                    "may — a second writer is an unordered write, and one delayed "
                    "past the sweep's exit overwrites a fresh verdict with a stale "
                    "one. The sole excuse is a job whose every step is "
                    f"`{LANES_ACTION}` or an actions/checkout it reads from, "
                    "which this is not"
                )
            elif verdict != "safe":
                problems.append(f"{name} ({where}): {verdict}")

    return problems


def main(argv):
    notices = []
    problems = check_consumer(argv[1] if len(argv) > 1 else ".", notices=notices)
    # Printed whether or not there are problems, and before them: a consumer
    # left on an old shape is the thing a migration has to be able to see.
    for notice in notices:
        print(f"notice: {notice}")
    for problem in problems:
        print(f"error: {problem}", file=sys.stderr)
    if problems:
        print(f"\n{len(problems)} problem(s) — see docs/CONSUMER.md", file=sys.stderr)
        return 1
    print("codex-review consumer setup is correct")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
