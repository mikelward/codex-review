#!/usr/bin/env python3
"""Tests for check_consumer.py.

This suite is the only thing between a change here and every consumer's merge
gate, and its failure mode is a FALSE PASS: a checker that stops noticing a hole
reports the same "correct" it reports when there is none. So every case asserts
BOTH directions -- the correct consumer passes, and the specific defect is
caught -- and the defect cases assert on the reported message rather than on
"some problem", since a check that fails for the wrong reason is one that will
pass when that reason goes away.

The notation cases are not hypothetical. Each is a form that got past a
hand-written copy of this check in a consumer repository, found by review:
``write-all``, a ``.yaml`` filename, ``statuses: "write"``, ``"permissions":``,
a blank line inside a mapping, and YAML's explicit-key form. They are the
regression suite for the reason this file exists, and the parser is what makes
them all one case rather than eight patches.

Run with: python3 -m unittest check_consumer_test
"""

import tempfile
import unittest
from pathlib import Path

import yaml

import check_consumer
from check_consumer import CALLER, LISTENER, SWEEP, check_consumer as check, judge

#: A third workflow, correct: declares its own block, grants no write.
CI = """name: CI
on:
  pull_request:
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: 'true'
"""


class ConsumerCase(unittest.TestCase):
    """A temporary consumer repository, with whatever workflows a case needs."""

    def consumer(self, **overrides):
        root = Path(tempfile.mkdtemp())
        workflows = root / ".github" / "workflows"
        workflows.mkdir(parents=True)
        files = {
            SWEEP: check_consumer.template(SWEEP),
            LISTENER: check_consumer.template(LISTENER),
            CALLER: check_consumer.template(CALLER),
            "ci.yml": CI,
        }
        for name, text in overrides.items():
            key = name.replace("_", "-").replace("-yml", ".yml").replace("-yaml", ".yaml")
            if text is None:
                files.pop(key, None)
            else:
                files[key] = text
        for name, text in files.items():
            (workflows / name).write_text(text)
        return root

    def check(self, **overrides):
        return check(self.consumer(**overrides))

    def assertProblem(self, problems, needle):
        joined = "\n".join(problems) or "(none)"
        self.assertTrue(
            any(needle in p for p in problems),
            f"expected a problem containing {needle!r}, got:\n{joined}",
        )


class CorrectConsumer(ConsumerCase):
    def test_passes_with_no_problems(self):
        # The other direction of every case below. If this goes red the suite
        # stops being able to tell a defect from the baseline.
        self.assertEqual(self.check(), [])

    def test_a_consumer_with_no_ci_of_its_own_is_valid(self):
        # `root` and `web` are exactly this. The scan is still not vacuous,
        # because the listener and the caller are in it.
        self.assertEqual(self.check(ci_yml=None), [])


class ThePins(ConsumerCase):
    def test_catch_a_changed_directive_naming_the_line(self):
        broken = check_consumer.template(SWEEP).replace(
            "timeout-minutes: 65", "timeout-minutes: 360"
        )
        self.assertProblem(self.check(**{"codex-review.yml": broken}), "differs from the shipped template at line")

    def test_catch_a_requoted_value_that_means_the_same_thing(self):
        # `statuses: "write"` is the same grant to YAML and a different file on
        # disk. The pin does not care what it means, only that it changed.
        broken = check_consumer.template(SWEEP).replace(
            "  statuses: write", '  statuses: "write"'
        )
        self.assertProblem(self.check(**{"codex-review.yml": broken}), "differs from the shipped template")

    def test_catch_a_comment_edited_into_the_file(self):
        # Byte-for-byte means byte-for-byte: the reasoning lives in
        # docs/CONSUMER.md precisely so nobody needs to edit these files.
        broken = "# a local note\n" + check_consumer.template(LISTENER)
        self.assertProblem(self.check(**{"codex-review-listener.yml": broken}), "differs from the shipped template")

    def test_catch_a_missing_listener(self):
        self.assertProblem(self.check(**{"codex-review-listener.yml": None}), "the relay needs both ends")

    def test_catch_a_consumer_that_does_not_run_this_check(self):
        # The one a deleted check cannot catch about itself -- but its absence
        # also means no green `codex-review-check` for the ruleset to require.
        self.assertProblem(self.check(**{"codex-review-check.yml": None}), "nothing in this repository runs this check")


class TheSoleWriterScan(ConsumerCase):
    def test_catches_the_scope_granted_outright(self):
        bad = CI.replace("  contents: read", "  statuses: write")
        self.assertProblem(self.check(ci_yml=bad), "ci.yml can write commit statuses")

    def test_catches_the_blanket_grant_which_never_spells_the_scope(self):
        bad = CI.replace("permissions:\n  contents: read", "permissions: write-all")
        self.assertProblem(self.check(ci_yml=bad), "ci.yml can write commit statuses")

    def test_refuses_duplicate_mapping_keys_rather_than_judging_the_last(self):
        # PyYAML's default keeps the LAST duplicate key, so a file carrying
        # two permissions blocks — statuses: write first, benign second —
        # would be judged only on the second. GitHub rejects such a file
        # today, but that safety belongs to this check, not to GitHub's
        # parser staying strict.
        bad = CI.replace(
            "permissions:\n  contents: read",
            "permissions:\n  statuses: write\npermissions:\n  contents: read",
        )
        self.assertProblem(self.check(ci_yml=bad), "could not be parsed")
        self.assertProblem(self.check(ci_yml=bad), "duplicate mapping key")

    def test_does_not_confuse_distinct_yaml_1_2_keys_coerced_alike_under_1_1(self):
        # PyYAML implements YAML 1.1, where `on`, `On`, `yes`, and `y` all
        # resolve to the Python boolean True — but GitHub's own parser is
        # closer to 1.2 and reads each as a distinct string. A workflow with
        # a top-level `on:` and an unrelated `yes:` key elsewhere is valid
        # and unambiguous on GitHub's side; the duplicate-key guard must not
        # report it as a collision that does not exist there.
        good = CI.replace(
            "on:\n  pull_request:",
            "on:\n  pull_request:\nyes: recorded so the parser sees the key, unused otherwise",
        )
        self.assertEqual(self.check(ci_yml=good), [])

    def test_catches_a_quoted_key(self):
        # `"permissions":` — the same key to YAML, invisible to a pattern
        # anchored on the bare spelling. Found by review against a consumer.
        bad = CI.replace(
            "  test:\n    runs-on: ubuntu-latest",
            '  test:\n    "permissions": write-all\n    runs-on: ubuntu-latest',
        )
        self.assertProblem(self.check(ci_yml=bad), "can write commit statuses")

    def test_catches_a_quoted_value(self):
        bad = CI.replace("  contents: read", '  statuses: "write"')
        self.assertProblem(self.check(ci_yml=bad), "can write commit statuses")

    def test_catches_a_flow_mapping(self):
        bad = CI.replace(
            "permissions:\n  contents: read",
            "permissions: {contents: read, statuses: write}",
        )
        self.assertProblem(self.check(ci_yml=bad), "can write commit statuses")

    def test_catches_a_grant_after_a_blank_line(self):
        # YAML does not end a mapping at a blank line. Found by review against
        # a consumer's copy, whose extractor did.
        bad = CI.replace(
            "permissions:\n  contents: read",
            "permissions:\n  contents: read\n\n  statuses: write",
        )
        self.assertProblem(self.check(ci_yml=bad), "can write commit statuses")

    def test_catches_the_explicit_key_form(self):
        # `? permissions` on its own line with `: write-all` beneath it — the
        # same mapping, matching no `permissions:` pattern anywhere. The eighth
        # notation, and the one that settled the argument for a real parser.
        bad = CI.replace(
            "  test:\n    runs-on: ubuntu-latest",
            "  test:\n    ? permissions\n    : write-all\n    runs-on: ubuntu-latest",
        )
        self.assertProblem(self.check(ci_yml=bad), "can write commit statuses")

    def test_catches_a_job_level_grant_under_a_disclaiming_top_level_block(self):
        bad = CI.replace(
            "  test:\n    runs-on: ubuntu-latest",
            "  test:\n    permissions:\n      statuses: write\n    runs-on: ubuntu-latest",
        )
        self.assertProblem(self.check(ci_yml=bad), "can write commit statuses")

    def test_catches_it_in_a_yaml_file_the_extension_being_no_exemption(self):
        bad = CI.replace("  contents: read", "  statuses: write")
        self.assertProblem(self.check(other_yaml=bad), "other.yaml can write commit statuses")

    def test_allows_writes_that_are_not_the_status(self):
        # A release workflow needs `contents: write`, and saying so is not a
        # finding — only the `codex` status is reserved.
        release = CI.replace("  contents: read", "  contents: write")
        self.assertEqual(self.check(release_yml=release), [])

    def test_allows_an_explicit_read_grant_on_the_status(self):
        self.assertEqual(self.check(ci_yml=CI.replace("  contents: read", "  statuses: read")), [])


#: A trusted-verdicts consumer (mikelward/lanes TODO.md): init and finalize
#: hold `statuses: write` and consist of nothing but the lanes engine plus,
#: on the finalizer, the checkout it reads the policy from.
LANES_CI = """name: CI
on:
  pull_request_target:
permissions: {}
jobs:
  init:
    runs-on: ubuntu-latest
    environment: lanes
    permissions:
      statuses: write
    steps:
      - uses: mikelward/lanes@main
        with:
          mode: init
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - run: 'true'
  finalize:
    runs-on: ubuntu-latest
    environment: lanes
    permissions:
      statuses: write
      pull-requests: read
      contents: read
    steps:
      - uses: actions/checkout@v5
        with:
          ref: refs/pull/1/merge
          persist-credentials: false
      - uses: mikelward/lanes@main
        with:
          mode: gate
"""


class TheLanesPublisherExcuse(ConsumerCase):
    """The one shape allowed to hold ``statuses: write`` besides the sweep.

    Every case below that tightens the shape exists because the excuse is
    judged from the job's own steps: the moment anything that is not the
    engine (or a checkout it reads from) can execute inside the granted job,
    the grant is reachable by code that could write ``codex``, and the
    excuse must collapse back to a finding.
    """

    def test_allows_the_init_and_finalize_pair(self):
        self.assertEqual(self.check(ci_yml=LANES_CI), [])

    def test_a_run_step_beside_the_engine_collapses_the_excuse(self):
        bad = LANES_CI.replace(
            "      - uses: mikelward/lanes@main\n        with:\n          mode: init",
            "      - uses: mikelward/lanes@main\n        with:\n          mode: init\n      - run: 'true'",
        )
        self.assertProblem(self.check(ci_yml=bad), "can write commit statuses (job `init`)")

    def test_an_action_other_than_the_engine_collapses_it(self):
        bad = LANES_CI.replace("mode: init", "mode: init\n      - uses: actions/github-script@v7")
        self.assertProblem(self.check(ci_yml=bad), "can write commit statuses (job `init`)")

    def test_the_engine_at_any_ref_but_main_collapses_it(self):
        # A branch or SHA of the same repository is not the released engine;
        # only `@main` is what the fleet reviews and tracks.
        bad = LANES_CI.replace("mikelward/lanes@main", "mikelward/lanes@feature")
        self.assertProblem(self.check(ci_yml=bad), "can write commit statuses")

    def test_a_container_collapses_it(self):
        # The steps would execute inside an image this shape check cannot
        # vouch for.
        bad = LANES_CI.replace(
            "  init:\n    runs-on: ubuntu-latest",
            "  init:\n    runs-on: ubuntu-latest\n    container: example/image:1",
        )
        self.assertProblem(self.check(ci_yml=bad), "can write commit statuses (job `init`)")

    def test_a_checkout_only_job_is_not_a_publisher(self):
        # Nothing in it publishes, so nothing in it needs the grant — an
        # excused-but-idle grant would be a free capability waiting for a
        # later edit to use.
        bad = LANES_CI.replace(
            "      - uses: actions/checkout@v5\n        with:\n          ref: refs/pull/1/merge\n          persist-credentials: false\n      - uses: mikelward/lanes@main\n        with:\n          mode: gate",
            "      - uses: actions/checkout@v5\n        with:\n          ref: refs/pull/1/merge\n          persist-credentials: false",
        )
        self.assertProblem(self.check(ci_yml=bad), "can write commit statuses (job `finalize`)")

    def test_a_step_level_env_collapses_it(self):
        # `NODE_OPTIONS: --require ./payload.js` makes the action's own Node
        # process load repository-controlled code inside the granted job.
        bad = LANES_CI.replace(
            "        with:\n          mode: gate",
            "        with:\n          mode: gate\n        env:\n          NODE_OPTIONS: --require ./payload.js",
        )
        self.assertProblem(self.check(ci_yml=bad), "can write commit statuses (job `finalize`)")

    def test_a_job_level_env_collapses_it(self):
        bad = LANES_CI.replace(
            "  init:\n    runs-on: ubuntu-latest",
            "  init:\n    runs-on: ubuntu-latest\n    env:\n      NODE_OPTIONS: --require ./payload.js",
        )
        self.assertProblem(self.check(ci_yml=bad), "can write commit statuses (job `init`)")

    def test_a_workflow_level_env_collapses_it_for_every_job(self):
        # A top-level env: reaches every job's processes the same way a
        # job-level one does.
        bad = LANES_CI.replace(
            "permissions: {}",
            "permissions: {}\nenv:\n  NODE_OPTIONS: --require ./payload.js",
        )
        self.assertProblem(self.check(ci_yml=bad), "can write commit statuses (job `init`)")

    def test_an_unrecognized_job_key_collapses_it(self):
        # The whitelist is the guard, not a forbidden-key list: whatever a
        # new execution-affecting key means, it is refused unrecognized.
        bad = LANES_CI.replace(
            "  init:\n    runs-on: ubuntu-latest",
            "  init:\n    runs-on: ubuntu-latest\n    defaults:\n      run:\n        shell: bash",
        )
        self.assertProblem(self.check(ci_yml=bad), "can write commit statuses (job `init`)")

    def test_an_unrecognized_step_key_collapses_it(self):
        bad = LANES_CI.replace(
            "        with:\n          mode: init",
            "        with:\n          mode: init\n        continue-on-error: true",
        )
        self.assertProblem(self.check(ci_yml=bad), "can write commit statuses (job `init`)")

    def test_a_checkout_pointed_at_another_server_collapses_it(self):
        # checkout authenticates its fetch with its default `github.token`
        # input, so `github-server-url` hands the job's ambient token --
        # this grant included -- to whatever host it names.
        bad = LANES_CI.replace(
            "          ref: refs/pull/1/merge",
            "          ref: refs/pull/1/merge\n          github-server-url: https://example.com",
        )
        self.assertProblem(self.check(ci_yml=bad), "can write commit statuses (job `finalize`)")

    def test_a_checkout_with_any_unrecognized_input_collapses_it(self):
        bad = LANES_CI.replace(
            "          ref: refs/pull/1/merge",
            "          ref: refs/pull/1/merge\n          token: not-the-default",
        )
        self.assertProblem(self.check(ci_yml=bad), "can write commit statuses (job `finalize`)")

    def test_a_self_hosted_runner_collapses_it(self):
        # A self-hosted runner is a machine whatever else already runs
        # there can read the job's token from -- every allowlisted step and
        # input still leaves that reachable.
        bad = LANES_CI.replace(
            "  init:\n    runs-on: ubuntu-latest",
            "  init:\n    runs-on: self-hosted",
        )
        self.assertProblem(self.check(ci_yml=bad), "can write commit statuses (job `init`)")

    def test_a_custom_runner_label_collapses_it_even_when_ubuntu_named(self):
        # A self-hosted runner GROUP can label itself anything, including
        # something that looks like GitHub's own image -- enumerated exactly
        # rather than by prefix so that naming trick does not pass.
        bad = LANES_CI.replace(
            "  init:\n    runs-on: ubuntu-latest",
            "  init:\n    runs-on: ubuntu-latest-custom",
        )
        self.assertProblem(self.check(ci_yml=bad), "can write commit statuses (job `init`)")

    def test_a_top_level_grant_is_never_excused(self):
        # It governs every job in the file at once, the non-publishers
        # included.
        bad = LANES_CI.replace("permissions: {}", "permissions:\n  statuses: write")
        self.assertProblem(self.check(ci_yml=bad), "can write commit statuses (top level)")


class TheDeclaredBlockRequirement(ConsumerCase):
    def test_catches_a_workflow_that_declares_nothing(self):
        # Declaring none inherits the repository's default GITHUB_TOKEN
        # permission — a setting no file in the tree can read. Two consumers
        # had exactly this.
        bad = CI.replace("permissions:\n  contents: read\n", "")
        self.assertProblem(self.check(ci_yml=bad), "declares no top-level permissions block")

    def test_catches_a_job_level_block_standing_in_for_a_top_level_one(self):
        # A job-level block covers its own job; every other job in the file
        # still takes the repository default.
        bad = CI.replace("permissions:\n  contents: read\n", "").replace(
            "  test:\n    runs-on: ubuntu-latest",
            "  test:\n    permissions:\n      contents: read\n    runs-on: ubuntu-latest",
        )
        self.assertProblem(self.check(ci_yml=bad), "declares no top-level permissions block")


class TheJudgment(unittest.TestCase):
    """`judge` reads what a value grants, and refuses what it does not recognize."""

    def test_reads_the_grant(self):
        self.assertEqual(judge({"contents": "read"}), "safe")
        self.assertEqual(judge({"statuses": "write"}), "write")
        self.assertEqual(judge("write-all"), "write")
        self.assertEqual(judge("read-all"), "safe")
        self.assertEqual(judge({}), "safe")
        self.assertEqual(judge({"statuses": "read"}), "safe")

    def test_refuses_what_it_does_not_recognize(self):
        # The guard against YAML version skew. PyYAML implements YAML 1.1,
        # where an unquoted `no` is False and `on` is True, while GitHub's
        # parser is closer to 1.2. None of the keys or values read here is
        # ambiguous between them — and if a quirk ever makes one so, this turns
        # it into a red check rather than a wrong answer.
        self.assertIn("unrecognized", judge({"statuses": False}))
        self.assertIn("unrecognized", judge({"statuses": "maybe"}))
        self.assertIn("unrecognized", judge(True))
        self.assertIn("unrecognized", judge(7))
        self.assertIn("unrecognized", judge({"contents": {"nested": "read"}}))

    def test_a_refusal_is_reported_not_silently_passed(self):
        # The whole point of the refusal: it has to reach the operator.
        case = ConsumerCase()
        case.setUp() if hasattr(case, "setUp") else None
        bad = CI.replace("  contents: read", "  statuses: yes")
        root = ConsumerCase.consumer(case, ci_yml=bad)
        problems = check(root)
        self.assertTrue(any("unrecognized" in p for p in problems), problems)


class TheTemplatesThemselves(unittest.TestCase):
    """Independent assertions on what the shipped templates SAY.

    The pins and the README-agreement check are both consistency checks: edit
    the template and the thing compared against it together, and they stay
    green whatever the template now says. So an unsafe trigger could be added,
    or a delivery trigger dropped, with nothing objecting -- the invariants
    those files exist to hold would be enforced by nobody.

    These are the invariants themselves, asserted against the template
    directly, so they hold no matter what any other copy is changed to. They
    are the one place in this suite where the *content* is judged rather than
    compared, and the reasoning for each is in docs/CONSUMER.md.
    """

    def setUp(self):
        self.sweep = yaml.safe_load(check_consumer.template(SWEEP))
        # PyYAML reads a bare `on` as the boolean True (YAML 1.1); the
        # template uses the bare form, as GitHub's own docs do.
        self.triggers = self.sweep[True]

    def test_starts_on_no_event_that_lets_a_branch_supply_its_own_sweep(self):
        # `workflow_dispatch` takes a ref and GitHub runs the workflow file
        # FROM that ref, so a branch could ship its own steps and keep the
        # `statuses: write` token. A bare `pull_request` has the same hole via
        # the merge ref, and `pull_request_review` is merge-ref too -- which is
        # why it lives on the unprivileged listener and is relayed.
        for unsafe in ("workflow_dispatch", "pull_request", "pull_request_review"):
            self.assertNotIn(unsafe, self.triggers)

    def test_starts_on_every_event_a_verdict_can_arrive_through(self):
        # Dropping any of these is a delivery form no consumer hears, and the
        # gate then waits on the hourly backstop instead of the minute clock.
        for needed in (
            "schedule",
            "pull_request_target",
            "issue_comment",
            "pull_request_review_comment",
            "workflow_run",
        ):
            self.assertIn(needed, self.triggers)

    def test_keeps_the_pull_request_types_that_each_earn_their_place(self):
        # `edited` is the retarget, which changes the reviewed diff while the
        # head SHA and its verdict stand still; `reopened` reuses a SHA that
        # may carry an earlier success; `closed` clears a shared-head failure.
        types = set(self.triggers["pull_request_target"]["types"])
        self.assertEqual(
            types,
            {"opened", "reopened", "ready_for_review", "synchronize", "edited", "closed"},
        )

    def test_grants_exactly_the_scope_the_sweep_needs(self):
        # Exact, so widening it is a deliberate edit here rather than
        # something a reader skims past. `statuses: write` is the whole reason
        # the file is security-critical; the three reads are what the sweep
        # needs to find the heads and date them.
        self.assertEqual(
            self.sweep["permissions"],
            {
                "contents": "read",
                "pull-requests": "read",
                "checks": "read",
                "statuses": "write",
            },
        )

    def test_runs_the_shared_action_as_its_only_step_and_checks_nothing_out(self):
        # One step, and it is the action. Counted rather than asserted absent:
        # a checkout would put the consumer's code in the same job as the write
        # token, and "no checkout" is a denylist of one where "one step" is the
        # property actually wanted.
        steps = self.sweep["jobs"]["sweep"]["steps"]
        self.assertEqual(len(steps), 1)
        self.assertEqual(steps[0]["uses"], "mikelward/codex-review@main")

    def test_keeps_the_loop_envelope(self):
        # A canceled loop is a gate that stopped sweeping mid-review, and
        # without a timeout a wedged API call holds the runner -- and the
        # queued successor behind it -- to the 6-hour default.
        self.assertIs(self.sweep["concurrency"]["cancel-in-progress"], False)
        self.assertGreater(self.sweep["jobs"]["sweep"]["timeout-minutes"], 55)

    def test_the_listener_holds_nothing_and_relays_by_name(self):
        # The relay is a name match, so the two ends are asserted together:
        # renaming one alone severs it in silence, and a verdict submitted as a
        # review with no inline comments then goes unheard.
        listener = yaml.safe_load(check_consumer.template(LISTENER))
        self.assertEqual(listener["permissions"], {})
        self.assertIn("pull_request_review", listener[True])
        self.assertEqual(
            self.triggers["workflow_run"]["workflows"], [listener["name"]]
        )

    def test_the_caller_grants_nothing_and_names_the_shared_check(self):
        caller = yaml.safe_load(check_consumer.template(CALLER))
        self.assertEqual(caller["permissions"], {"contents": "read"})
        self.assertEqual(
            caller["jobs"]["codex-review-check"]["uses"],
            "mikelward/codex-review/.github/workflows/check-consumer.yml@main",
        )

    def test_the_caller_loads_its_definition_from_the_default_branch(self):
        # A bare `pull_request` would load the JOB DEFINITION from the PR's
        # merge ref, so a PR editing this file could replace the call to
        # check-consumer.yml with one that always succeeds -- the same hole
        # `pull_request_target` closes for the sweep, here on the file whose
        # whole purpose is to reject exactly that kind of edit.
        caller = yaml.safe_load(check_consumer.template(CALLER))
        self.assertIn("pull_request_target", caller[True])
        self.assertNotIn("pull_request", caller[True])


class TheHubExemption(ConsumerCase):
    """Only this tree is exempt from having a caller, and only by being it."""

    def test_the_hub_needs_no_caller_and_is_otherwise_a_consumer(self):
        # The real repository, checked by the real rule -- the same call
        # ci.yml makes. It installs the sweep and the listener and no caller,
        # so this passing IS the exemption, and the pins still apply to it.
        here = Path(check_consumer.__file__).resolve().parent
        self.assertEqual(check(here), [])
        self.assertTrue(check_consumer.is_hub(here))

    def test_a_consumer_holding_the_checker_by_name_is_not_the_hub(self):
        # A vendored copy, or an unrelated local checker, must not buy the
        # exemption: if it did, that consumer's caller could be missing or
        # drifted and this would report success.
        root = self.consumer(**{"codex-review-check.yml": None})
        (root / "check_consumer.py").write_text("# not the hub\n")
        self.assertFalse(check_consumer.is_hub(root))
        self.assertProblem(check(root), "nothing in this repository runs this check")


class TheNoDependencyInvariant(unittest.TestCase):
    """Nothing this repository runs may fetch a package at gate time.

    PyYAML comes from the runner image. Installing it was tried and reverted:
    it put PyPI on the critical path of nine merge gates, and an unpinned
    install takes whatever release is newest, so a parser regression could
    move a verdict with no change in any repository. A comment saying so is
    not enforcement -- this is.
    """

    def workflows(self):
        here = Path(check_consumer.__file__).resolve().parent
        found = sorted((here / ".github" / "workflows").glob("*.y*ml"))
        # Without this the scan is a set difference against an empty set,
        # which is the false pass this suite exists to refuse.
        self.assertTrue(found, "no workflows found to scan")
        return found

    def test_no_workflow_installs_a_package(self):
        # Reads the `run:` scripts a job actually executes, not the file text.
        # The comments deliberately discuss `pip install` -- explaining why it
        # is absent is the point of them -- so a grep over the source would
        # fail on its own rationale.
        scanned = 0
        for path in self.workflows():
            doc = yaml.safe_load(path.read_text())
            for job in (doc.get("jobs") or {}).values():
                for step in (job.get("steps") or []) if isinstance(job, dict) else []:
                    run = step.get("run") if isinstance(step, dict) else None
                    if not run:
                        continue
                    scanned += 1
                    for forbidden in ("pip install", "npm install", "npm ci", "pipx install"):
                        self.assertNotIn(
                            forbidden,
                            run,
                            f"{path.name} runs {forbidden!r}; PyYAML comes from "
                            "the runner image and nothing may be fetched at gate time",
                        )
        self.assertTrue(scanned, "no run steps found to scan")

    def test_the_checker_fails_closed_when_the_parser_is_absent(self):
        # The whole risk this invariant accepts is the image dropping PyYAML,
        # and it is only acceptable because that is loud. `sys.exit(str)`
        # exits non-zero, so the gate goes red rather than reporting a pass
        # it never made.
        source = (Path(check_consumer.__file__).resolve()).read_text()
        self.assertIn("except ImportError", source)
        self.assertIn("sys.exit(", source)


class SupersededShapes(ConsumerCase):
    """The migration mechanism: a template change consumers can follow late.

    Without it a template edit is a deadlock -- every consumer mismatches the
    moment it merges, and the hub's own CI checks real consumer trees against
    the revision under review, so the edit is red before it can merge and the
    consumers cannot be fixed until it has. Each case below asserts both
    directions, because the failure mode here is a set that quietly accepts
    anything.
    """

    def templates(self, current, superseded=None):
        """A templates root: the current three, plus optional older shapes.

        ``superseded`` maps a label to a mapping of filename to bytes, which is
        the on-disk layout the checker reads.
        """
        root = Path(tempfile.mkdtemp())
        directory = root / "templates"
        directory.mkdir()
        for name, text in current.items():
            (directory / name).write_text(text)
        for label, files in (superseded or {}).items():
            shape = directory / check_consumer.SUPERSEDED / label
            shape.mkdir(parents=True)
            for name, text in files.items():
                (shape / name).write_text(text)
        return root

    def setUp(self):
        self.old_caller = check_consumer.template(CALLER)
        # A VALID rewrite: the current template already carries
        # workflow_dispatch, and inserting a duplicate key would now be a
        # parse refusal rather than a shape change.
        self.new_caller = self.old_caller.replace("on:\n", "on:\n  merge_group:\n")
        self.sweep = check_consumer.template(SWEEP)
        self.listener = check_consumer.template(LISTENER)
        # A rewrite that changed nothing would make every case below vacuous.
        self.assertNotEqual(self.new_caller, self.old_caller)
        self.current = {SWEEP: self.sweep, LISTENER: self.listener, CALLER: self.new_caller}
        # A complete shape: all three files as they were shipped together.
        self.shipped = {SWEEP: self.sweep, LISTENER: self.listener, CALLER: self.old_caller}

    def test_a_consumer_on_the_current_templates_passes_silently(self):
        root = self.templates(self.current, {"push-only": self.shipped})
        notices = []
        problems = check(self.consumer(**{"codex-review-check.yml": self.new_caller}), root, notices)
        self.assertEqual(problems, [])
        self.assertEqual(notices, [])

    def test_a_consumer_on_a_superseded_shape_passes_and_is_reported(self):
        # The point of the whole mechanism: accepted, so the template change
        # can land; reported, so the migration it starts cannot be forgotten.
        root = self.templates(self.current, {"push-only": self.shipped})
        notices = []
        problems = check(self.consumer(**{"codex-review-check.yml": self.old_caller}), root, notices)
        self.assertEqual(problems, [])
        self.assertEqual(len(notices), 1)
        self.assertIn("push-only", notices[0])

    def test_the_same_shape_fails_once_it_is_no_longer_offered(self):
        # Deleting the directory is what ENDS a migration, so this is the
        # assertion that the pin goes back to one shape rather than silently
        # keeping every shape it ever accepted.
        root = self.templates(self.current)
        notices = []
        problems = check(self.consumer(**{"codex-review-check.yml": self.old_caller}), root, notices)
        self.assertProblem(problems, "differs from the shipped template")
        self.assertEqual(notices, [])

    def test_a_shape_nobody_shipped_is_still_a_problem(self):
        # The set is exact matches against files in this repository, not a
        # relaxation. A locally edited file matches neither and fails.
        root = self.templates(self.current, {"push-only": self.shipped})
        local = self.old_caller.replace("contents: read", "contents: write")
        self.assertProblem(
            check(self.consumer(**{"codex-review-check.yml": local}), root),
            "differs from the shipped template",
        )

    def test_a_mix_of_two_shipped_generations_is_refused(self):
        # The cartesian-product hole, and the reason a shape is matched whole.
        # Both files below were shipped -- just never together. The sweep names
        # the listener in its `workflow_run` trigger, so a mixed pair is broken
        # rather than merely old, and per-file matching would pass it.
        old_listener = self.listener.replace("name: codex-review-listener", "name: codex-review-relay")
        self.assertNotEqual(old_listener, self.listener)
        shipped_then = dict(self.shipped, **{LISTENER: old_listener})
        root = self.templates(self.current, {"old-relay": shipped_then})
        # Old caller from `old-relay`, current listener: each half is a file
        # this repository shipped, the combination is not.
        problems = check(
            self.consumer(
                **{"codex-review-check.yml": self.old_caller, "codex-review-listener.yml": self.listener}
            ),
            root,
        )
        self.assertProblem(problems, "differs from the shipped template")

    def test_that_same_generation_passes_when_taken_whole(self):
        # The other direction of the case above: the identical label accepts a
        # consumer that holds all of it, or the refusal above would just be the
        # mechanism failing to work at all.
        old_listener = self.listener.replace("name: codex-review-listener", "name: codex-review-relay")
        shipped_then = dict(self.shipped, **{LISTENER: old_listener})
        root = self.templates(self.current, {"old-relay": shipped_then})
        notices = []
        problems = check(
            self.consumer(
                **{"codex-review-check.yml": self.old_caller, "codex-review-listener.yml": old_listener}
            ),
            root,
            notices,
        )
        self.assertEqual(problems, [])
        self.assertIn("old-relay", notices[0])

    def test_an_incomplete_shape_is_an_authoring_error_here(self):
        # Recording only the file a migration changed is the mistake that
        # reopens the hole above, so it fails naming the label -- and it fails
        # even for a consumer that is otherwise current, because the defect is
        # in this repository rather than in the consumer.
        root = self.templates(self.current, {"push-only": {CALLER: self.old_caller}})
        problems = check(self.consumer(**{"codex-review-check.yml": self.new_caller}), root)
        self.assertProblem(problems, "`push-only` is incomplete")
        self.assertProblem(problems, "matched whole")

    def test_a_label_that_would_break_the_notice_channel_is_an_authoring_error(self):
        # A label is quoted into the `notice:` line, and the hub's sweep reads
        # it back out of that line to decide which migrations are still under
        # way. A backtick truncates that read, so the sweep looks for a label
        # nobody is on and calls a live migration finished -- which tells a
        # maintainer to delete a shape people are still using. Reported by name
        # rather than accepted, since labels are authored here by hand.
        root = self.templates(self.current, {"push`only": self.shipped})
        problems = check(self.consumer(**{"codex-review-check.yml": self.new_caller}), root)
        self.assertProblem(problems, "`push`only` has an unusable name")

    def test_a_dash_or_dot_prefixed_label_is_refused_the_same_way(self):
        # Both are names the tooling downstream reads as something other than a
        # name: a leading `-` is an option, and a leading `.` is skipped by the
        # shell globs that used to enumerate these.
        for label in ("-legacy", ".legacy"):
            with self.subTest(label=label):
                root = self.templates(self.current, {label: self.shipped})
                problems = check(
                    self.consumer(**{"codex-review-check.yml": self.new_caller}), root
                )
                self.assertProblem(problems, f"`{label}` has an unusable name")

    def test_an_ordinary_label_is_not_refused(self):
        # The other direction: the rule must accept the names actually used, or
        # it fails every migration instead of the malformed ones.
        for label in ("push-only", "push_only", "v1.2", "shape2"):
            with self.subTest(label=label):
                root = self.templates(self.current, {label: self.shipped})
                problems = check(
                    self.consumer(**{"codex-review-check.yml": self.old_caller}), root
                )
                self.assertEqual(problems, [])

    def test_notices_are_optional_so_every_existing_caller_keeps_working(self):
        # `check_consumer` is called without a notices list in this suite, in
        # scripts/check-consumers.sh's checker, and by consumers. A shape on
        # its way out must not make those calls fail.
        root = self.templates(self.current, {"push-only": self.shipped})
        self.assertEqual(check(self.consumer(**{"codex-review-check.yml": self.old_caller}), root), [])

    def test_no_superseded_directory_is_the_ordinary_case(self):
        # Nothing requires the directory to exist, which is what keeps the
        # repository single-shaped between migrations rather than carrying an
        # empty migration around forever.
        root = self.templates(self.current)
        self.assertEqual(check_consumer.superseded_shapes(root), {})

    def test_every_offered_shape_is_found_and_labeled(self):
        # Two at once, because a migration can overlap another. A lookup that
        # returned only the first would accept one shape and reject the other
        # with nothing to say why.
        older = dict(self.shipped, **{SWEEP: self.sweep.replace("cron: '23 * * * *'", "cron: '7 * * * *'")})
        self.assertNotEqual(older[SWEEP], self.sweep)
        root = self.templates(self.current, {"push-only": self.shipped, "old-cron": older})
        self.assertEqual(
            check_consumer.superseded_shapes(root), {"old-cron": older, "push-only": self.shipped}
        )


class MissingDirectory(unittest.TestCase):
    def test_is_reported(self):
        with tempfile.TemporaryDirectory() as empty:
            self.assertTrue(any("does not exist" in p for p in check(empty)))


if __name__ == "__main__":
    unittest.main()
