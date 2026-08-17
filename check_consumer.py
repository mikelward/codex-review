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
it. Every other workflow must also DECLARE a top-level permissions block, since
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

import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - the message is the behavior
    sys.exit(
        "error: this check needs PyYAML.\n"
        "  python3 -m pip install --user pyyaml\n"
        "GitHub's runner images ship it; a bare machine may not."
    )

HERE = Path(__file__).resolve().parent

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
    """Every permissions value in a parsed workflow, as ``(where, value)``.

    Per-job values are deliberately included -- without them a job-level grant
    could hide under a top-level block that disclaims it.
    """
    found = []
    if not isinstance(doc, dict):
        return found
    if "permissions" in doc:
        found.append(("top level", doc["permissions"]))
    jobs = doc.get("jobs")
    if isinstance(jobs, dict):
        for name, job in jobs.items():
            if isinstance(job, dict) and "permissions" in job:
                found.append((f"job `{name}`", job["permissions"]))
    return found


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


def check_consumer(root=".", templates_root=None):
    """Check one consumer repository. Returns a list of problems, empty if correct."""
    root = Path(root)
    workflows = root / ".github" / "workflows"
    problems = []

    if not workflows.is_dir():
        return [f"{workflows} does not exist — a consumer needs all three codex-review files"]

    present = sorted(p.name for p in workflows.iterdir() if is_workflow(p.name))
    hub = is_hub(root)
    required = [n for n in TEMPLATES if not (hub and n == CALLER)]

    # 1. The files, byte for byte. No parsing: the question is whether this is
    # the shipped file, not what it means.
    for name in required:
        if name not in present:
            problems.append(
                f"{name} is missing — nothing in this repository runs this check"
                if name == CALLER
                else f"{name} is missing — the relay needs both ends"
            )
            continue
        actual = (workflows / name).read_text()
        expected = template(name, templates_root or HERE)
        if actual == expected:
            continue
        line = first_difference(actual, expected)
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
            doc = yaml.safe_load((workflows / name).read_text())
        except yaml.YAMLError as error:
            # Fail closed: a question that could not be asked is not a question
            # answered "no".
            problems.append(f"{name} could not be parsed, so it cannot be checked — {error}")
            continue

        values = permission_values(doc)
        if not any(where == "top level" for where, _ in values):
            problems.append(
                f"{name} declares no top-level permissions block, so its jobs "
                "inherit the repository's default GITHUB_TOKEN permission — a "
                "setting no file in the repo can read, and one that may be "
                "read/write"
            )

        for where, value in values:
            verdict = judge(value)
            if verdict == "write":
                problems.append(
                    f"{name} can write commit statuses ({where}), and only {SWEEP} "
                    "may — a second writer is an unordered write, and one delayed "
                    "past the sweep's exit overwrites a fresh verdict with a stale one"
                )
            elif verdict != "safe":
                problems.append(f"{name} ({where}): {verdict}")

    return problems


def main(argv):
    problems = check_consumer(argv[1] if len(argv) > 1 else ".")
    for problem in problems:
        print(f"error: {problem}", file=sys.stderr)
    if problems:
        print(f"\n{len(problems)} problem(s) — see docs/CONSUMER.md", file=sys.stderr)
        return 1
    print("codex-review consumer setup is correct")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
