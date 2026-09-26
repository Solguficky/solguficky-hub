#!/usr/bin/env sh
# Run every Identity test under the `integration` build tag and fail on a skip.
#
# The tag selects the level: files that need PostgreSQL carry
# `//go:build integration`, so the plain `go test ./...` of `verify` never
# compiles them. Under the tag the untagged unit files are compiled too, so
# this run is the whole suite.
#
# `go test` has no flag that turns a skip into a failure, and a skipped test
# exits 0 exactly like a passing one. `testdb` already fails instead of skipping
# when the database is unreachable; this script is the guard for any other
# `t.Skip` that finds its way into the suite ("skip is not pass",
# docs/standards/testing/testing-strategy.md).

set -eu

root=$(git rev-parse --show-toplevel)
cd "$root/apps/identity"

log=$(mktemp)
trap 'rm -f "$log"' EXIT

# Kept apart from the filter below: piping `go test` straight into grep would
# report grep's exit code, and a failing run would read as green.
# -count=1 because the test cache keys on source, not on the database: after a
# green run with PostgreSQL gone, a cached `ok` would report tests that never ran.
status=0
go test -tags=integration -count=1 -v ./... >"$log" 2>&1 || status=$?

# The verbose log lists every RUN, PAUSE and CONT; the summary keeps what a
# reader needs: failures, skips, package verdicts and anything unrecognised.
grep -v -E '^(=== (RUN|PAUSE|CONT|NAME)|[[:space:]]*--- PASS|PASS$)' "$log" || true

skipped=$(grep -c -E '^[[:space:]]*--- SKIP' "$log" || true)
if [ "$skipped" -gt 0 ]; then
    echo "identity-test-integration: пропущено тестов: $skipped — пропуск не равен прохождению, прогон считается упавшим" >&2
    [ "$status" -ne 0 ] || status=1
fi

exit "$status"
