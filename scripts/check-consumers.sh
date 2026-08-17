#!/bin/sh
# Runs THIS revision's check_consumer.py against every consuming repository.
#
# The point is what it validates and when. `templates/` and `check_consumer.py`
# are what nine repositories are held to, and consumers track `@main`, so a
# merge here reaches every one of their merge gates with no release step in
# between -- this suite is the only thing in front of that. Without this job a
# template change is tested only against this repository's own copy, and the
# first time it meets a real consumer is after it can no longer be stopped.
#
# It deliberately clones and checks the consumers rather than trusting them to
# check themselves: a consumer runs the check at `@main`, which is the released
# checker against its own tree, and that answers a different question from
# "does the change under review still accept the nine repositories as they are
# today".
#
# The list is every consumer THIS REPOSITORY KNOWS OF, which is not the same as
# every consumer and must not be mistaken for it. This action is public and
# unpinned, so anyone can adopt it without appearing here, and nothing in this
# job could notice a repository it does not name. A list claiming completeness
# would be wrong the first time someone did, and wrong silently.
#
# What it IS, is the set of trees this job checks, and it grew from a sample of
# three for two reasons. AGENTS.md requires a templates/ change to have every
# sibling's workflows checked, and a sample cannot answer that. And the notices
# turn the run into a migration's progress bar: with every known consumer
# named, one run says which are still on the outgoing shape, where a sample
# would say "some of them are fine" and leave the rest tracked by hand.
#
# It goes stale in the safe direction: a repository named here but not yet
# converted is a printed skip, not a failure. The one silent case is a
# repository this job never hears about -- which is why adding a sibling here
# belongs in the same change that gives it the workflows, and why an outside
# adopter is served by running the check in their own CI rather than by being
# added to this list. The clone below assumes the sibling owner, so this list
# is for the siblings; it is not a registry.
#
# A repository that has not adopted the check yet is SKIPPED, with its name
# printed. Adoption is one repository at a time by design (see AGENTS.md), so
# coverage here grows as they convert instead of this job being red until the
# last one lands. The skip is reported rather than silent, because a skip that
# nobody sees is indistinguishable from a pass.
#
# Usage:
#   scripts/check-consumers.sh              # clone each consumer, check it
#   scripts/check-consumers.sh ../          # check sibling checkouts instead

set -eu

# The sibling repositories named in AGENTS.md, in adoption order. Bare names:
# the clone below supplies the owner, so this list cannot express an outside
# adopter -- deliberately, since it is the siblings this repository is
# responsible for checking, not a registry of everyone using the action.
CONSUMERS="scripts vcs conf unixtools root mesh web gedmap lanes"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SIBLINGS="${1:-}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

failed=0
reachable=0
checked=0
skipped=""

for name in $CONSUMERS; do
    if test -n "$SIBLINGS"; then
        repo="$SIBLINGS/$name"
        test -d "$repo" || { skipped="$skipped $name(absent)"; continue; }
    else
        repo="$WORK/$name"
        # Shallow, single branch: this needs the default branch's tree and
        # nothing of its history.
        if ! git clone --quiet --depth 1 "https://github.com/mikelward/$name" "$repo" 2>"$WORK/err"; then
            echo "FAIL: could not clone $name"
            sed 's/^/    /' "$WORK/err"
            failed=1
            continue
        fi
    fi

    reachable=$((reachable + 1))

    # Adoption is the CALLER's presence, not any codex-review file. A
    # repository on the pre-consolidation setup has the sweep and the listener
    # in their old form, so testing for those reads as adopted and then fails
    # the pin against templates it was never converted to -- this job going red
    # over work that has not been done yet, rather than over a change under
    # review. codex-review-check.yml exists only after conversion.
    if ! test -f "$repo/.github/workflows/codex-review-check.yml"; then
        skipped="$skipped $name(not adopted)"
        continue
    fi

    checked=$((checked + 1))
    echo "== $name"
    if ! python3 "$HERE/check_consumer.py" "$repo"; then
        failed=1
    fi
done

echo
test -z "$skipped" || echo "skipped:$skipped"

# A run that could not READ a single consumer is not a run that found nothing:
# a rename, a revoked clone, a moved workflow directory would all leave this
# job reporting success having seen nothing at all. That is the vacuity worth
# failing on, and it is not the same as every consumer being legitimately
# un-adopted -- which is the state during the whole rollout, since adoption is
# one repository at a time and the first one cannot merge until this repository
# provides the workflow it calls. Conflating the two made this job impossible
# to get green before the first consumer converted, and impossible to trust
# after. So: reaching a tree and finding no caller is a reported skip; reaching
# no tree at all is the failure.
if test "$reachable" -eq 0; then
    echo "FAIL: no consumer tree could be read; this job verified nothing"
    exit 1
fi

echo "read $reachable consumer(s), checked $checked"
exit $failed
