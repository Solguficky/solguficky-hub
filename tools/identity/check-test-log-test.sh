#!/usr/bin/env sh
# Fixture cases for tools/identity/check-test-log.py.
#
# A green integration run shows one happy path and needs PostgreSQL; it cannot
# show that the check fails where it must. So each case is a hand-made
# `go test -json` log, and a failure must name what is wrong.

set -eu

root=$(git rev-parse --show-toplevel)
check="$root/tools/identity/check-test-log.py"
python=${PYTHON:-python3}
failed=0
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

pkg=github.com/Solguficky/solguficky-hub/apps/identity/internal/server

# ev ACTION TEST [OUTPUT] - one test2json event; an empty TEST is package level
ev() {
    if [ -n "$2" ]; then test_field=",\"Test\":\"$2\""; else test_field=""; fi
    if [ -n "${3:-}" ]; then output_field=",\"Output\":\"$3\""; else output_field=""; fi
    printf '{"Time":"2026-09-30T10:00:00Z","Action":"%s","Package":"%s"%s%s}\n' \
        "$1" "$pkg" "$test_field" "$output_field"
}

# passing NAME... - a run, output and pass event per top-level test
passing() {
    for name in "$@"; do
        ev run "$name"
        ev output "$name" "=== RUN   $name\\n"
        ev output "$name" "--- PASS: $name (0.00s)\\n"
        ev pass "$name"
    done
}

run_check() {
    "$python" "$check" "$1" "$2" 2>&1
}

assert_fails() {
    name=$1
    needle=$2
    log=$3
    threshold=$4
    output=$(run_check "$log" "$threshold") && status=0 || status=$?
    if [ "$status" -eq 0 ]; then
        echo "expected $name to fail, it passed: $output" >&2
        failed=1
    elif ! printf '%s\n' "$output" | grep -Fq -- "$needle"; then
        echo "expected $name to name $needle: $output" >&2
        failed=1
    else
        echo "ok: $name"
    fi
}

assert_passes() {
    name=$1
    needle=$2
    log=$3
    threshold=$4
    output=$(run_check "$log" "$threshold") && status=0 || status=$?
    if [ "$status" -ne 0 ]; then
        echo "expected $name to pass: $output" >&2
        failed=1
    elif ! printf '%s\n' "$output" | grep -Fq -- "$needle"; then
        echo "expected $name to print $needle: $output" >&2
        failed=1
    else
        echo "ok: $name"
    fi
}

log="$scratch/green"
{ passing TestA TestB TestC; ev output "" "ok  \\t$pkg\\t0.1s\\n"; ev pass ""; } > "$log"
assert_passes "suite at the threshold" "выполнено тестов верхнего уровня: 3, порог 3" "$log" 3
assert_passes "suite above the threshold" "порог 2" "$log" 2
assert_fails "lost file: fewer tests than the threshold" "IDENTITY_TEST_THRESHOLD в justfile" "$log" 4

log="$scratch/subtests"
{
    ev run TestTable
    ev run TestTable/first
    ev pass TestTable/first
    ev run TestTable/second
    ev pass TestTable/second
    ev pass TestTable
} > "$log"
assert_passes "subtests do not count" "верхнего уровня: 1," "$log" 1
assert_fails "subtests do not make up a lost test" "меньше порога 2" "$log" 2

log="$scratch/skip"
{ passing TestA; ev run TestB; ev output TestB "    b_test.go:9: not today\\n"; ev skip TestB; } > "$log"
assert_fails "skipped top-level test" "пропущено тестов: 1" "$log" 1

log="$scratch/subskip"
{ ev run TestT; ev run TestT/row; ev skip TestT/row; ev pass TestT; } > "$log"
assert_fails "skipped subtest" "пропущено тестов: 1" "$log" 1

log="$scratch/fail"
{ passing TestA; ev run TestB; ev output TestB "    b_test.go:12: boom\\n"; ev fail TestB; } > "$log"
assert_passes "failed test ran; the verdict belongs to go test" "b_test.go:12: boom" "$log" 2

# Parallel tests interleave their events; the verdicts still pair by name, and
# a failed test's last line without a newline does not swallow the next one
log="$scratch/parallel"
{
    ev run TestA; ev run TestB; ev pause TestA; ev pause TestB
    ev cont TestA; ev cont TestB
    ev output TestB "partial line without a newline"
    ev pass TestA; ev fail TestB
} > "$log"
assert_passes "parallel tests are counted by name" "верхнего уровня: 2," "$log" 2
output=$(run_check "$log" 2) || true
if printf '%s\n' "$output" | grep -qx "partial line without a newline"; then
    echo "ok: output without a newline ends its own line"
else
    echo "expected the partial line on a line of its own: $output" >&2
    failed=1
fi

# Go 1.24+ reports a build failure as events: build-output lines, then a
# package-level output frame with the verdict
log="$scratch/build"
{
    printf '{"ImportPath":"%s","Action":"build-output","Output":"internal/server/x.go:3:1: syntax error\\n"}\n' "$pkg"
    ev output "" "FAIL\\t$pkg [setup failed]\\n"
    ev fail ""
    passing TestA
} > "$log"
assert_fails "build failure is shown and the lost tests fail the run" "syntax error" "$log" 5
assert_fails "package verdict of a failed build is shown" "[setup failed]" "$log" 5

log="$scratch/raw"
{ echo "go: downloading example.com/m v1.0.0"; passing TestA; } > "$log"
assert_passes "a line that is not an event is shown" "go: downloading example.com/m" "$log" 1

log="$scratch/empty"
: > "$log"
assert_fails "empty log" "выполнено тестов 0, меньше порога 1" "$log" 1

output=$("$python" "$check" "$scratch/green" 2>&1) && status=0 || status=$?
if [ "$status" -ne 2 ]; then
    echo "expected a missing threshold to exit 2, got $status: $output" >&2
    failed=1
else
    echo "ok: missing threshold"
fi

# A threshold of 0 would pass an empty log
output=$("$python" "$check" "$scratch/empty" 0 2>&1) && status=0 || status=$?
if [ "$status" -ne 2 ]; then
    echo "expected a zero threshold to exit 2, got $status: $output" >&2
    failed=1
else
    echo "ok: zero threshold"
fi

if [ "$failed" -ne 0 ]; then
    exit 1
fi
echo "check-test-log: all fixture cases pass"
