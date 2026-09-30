#!/usr/bin/env sh
# Run every Identity test under the `integration` build tag and fail on a skip
# or on fewer tests than the threshold.
#
# Usage: test-integration.sh THRESHOLD [go test flags...]
#
# The tag selects the level: files that need PostgreSQL carry
# `//go:build integration`, so the plain `go test ./...` of `verify` never
# compiles them. Under the tag the untagged unit files are compiled too, so
# this run is the whole suite. Extra flags go to `go test`; CI passes -race.
#
# `go test` has no flag that turns a skip into a failure, and a skipped test
# exits 0 exactly like a passing one. A typo in the build tag is quieter still:
# the file is not compiled and nothing reports it. `testdb` already fails
# instead of skipping when the database is unreachable; check-test-log.py is
# the guard for any other `t.Skip` and for a lost file ("skip is not pass",
# docs/standards/testing/testing-strategy.md).

set -eu

[ $# -ge 1 ] || { echo "usage: test-integration.sh THRESHOLD [go test flags...]" >&2; exit 2; }
threshold=$1
shift

root=$(git rev-parse --show-toplevel)
python=${PYTHON:-python3}
cd "$root/apps/identity"

log=$(mktemp)
trap 'rm -f "$log"' EXIT

# Kept apart from the check below: piping `go test` straight into it would
# report the checker's exit code, and a failing run would read as green.
# -count=1 because the test cache keys on source, not on the database: after a
# green run with PostgreSQL gone, a cached `ok` would report tests that never ran.
status=0
go test -tags=integration -count=1 -json "$@" ./... >"$log" 2>&1 || status=$?

"$python" "$root/tools/identity/check-test-log.py" "$log" "$threshold" || {
    [ "$status" -ne 0 ] || status=1
}

exit "$status"
