#!/usr/bin/env sh
# Checks that a delivery report carries the facts of the task loop before it
# leaves the executor: the facts the acceptance of an epic leaf checks
# (.skillshare/skills/proj/proj-run-epic/references/acceptance.md), named in
# step 11 of docs/development/agent-execution-loop.md. A missing fact is
# caught here, by the executor, not later by the acceptance of the
# orchestrator.
#
# Usage: sh tools/delivery/check-facts.sh <ID> [REPORT]
#
#   ID       the task, PER-N
#   REPORT   the report file; .work/<ID>/report.md by default
#
# It reads text, not the tracker: the gate line it looks for is the one the
# report copies from the Linear comment of step 10. What each fact means is
# defined by the loop; here only its trace in the report is looked for:
#
#   recon         .work/<ID>/recon.md exists and is not empty
#   pull request  a GitHub pull request link
#   gate          `EXIT=<code>` of the gate, or «гейт не оценил изменение»
#   review        the three axes by name: стандарт…, спецификац…, корректност…
#   external      «Внешнее ревью: <итог>» or «внешнее ревью не шло» with why
#   checkpoint    the output of `just gate-observe plan` («вопрос plan@»)
#   manual gate   the output of `gate-observe decided` or `ask`, or the line
#                 «решений гейта не было»
#
# Output: one line per fact, `ok` or `missing`, then a verdict.
# Exit code: 0 every fact is there, 1 a fact is missing, 2 usage.
#
# DELIVERY_ROOT overrides the repository root; only the fixture test sets it.

set -eu

[ $# -ge 1 ] && [ $# -le 2 ] || { echo "usage: sh tools/delivery/check-facts.sh <ID> [REPORT]" >&2; exit 2; }
id=$1
case $id in
    PER-[0-9]*) ;;
    *) echo "check-facts: '$id' is not a task id like PER-123" >&2; exit 2 ;;
esac

root=${DELIVERY_ROOT:-$(git rev-parse --show-toplevel)}
report=${2:-$root/.work/$id/report.md}
[ -f "$report" ] || { echo "check-facts: no report at $report — write the step 11 report there first" >&2; exit 2; }

missing=0
fact() {
    name=$1 detail=$2
    shift 2
    if "$@"; then
        printf 'ok\t%s\n' "$name"
    else
        printf 'missing\t%s\t%s\n' "$name" "$detail"
        missing=1
    fi
}

# Case is spelled out in the patterns: -i does not fold Cyrillic in every
# locale the check may run in.
has() {
    grep -Eq -- "$1" "$report"
}

recon_written() {
    [ -s "$root/.work/$id/recon.md" ]
}

fact recon ".work/$id/recon.md is absent or empty" recon_written
fact "pull request" "no github.com/…/pull/N link" has 'github\.com/[^ ]+/pull/[0-9]+'
fact gate "neither EXIT=<code> of the gate nor «гейт не оценил изменение»" has 'EXIT=[0-9]+|[Гг]ейт не оценил изменение'
fact "review: standards" "the standards axis is not named" has '[Сс]тандарт'
fact "review: specification" "the specification axis is not named" has '[Сс]пецификац'
fact "review: correctness" "the correctness axis is not named" has '[Кк]орректност'
# A heading alone is not a fact: the line names a result after a colon, or
# says the review did not run.
fact "external review" "neither its result after «Внешнее ревью:» nor «внешнее ревью не шло» with the reason" has '[Вв]нешн[а-я]* ревью( не шло|: *[^ ])'
fact checkpoint "no output of just gate-observe plan" has 'вопрос plan@'
fact "manual gate" "no gate-observe decided or ask output and no «решений гейта не было»" has 'вопрос (decided|ask)@|[Рр]ешений гейта не было'

if [ "$missing" -ne 0 ]; then
    echo "check-facts: $id is not ready to deliver — add the missing facts to the report"
    exit 1
fi
echo "check-facts: $id carries every fact of the loop"
