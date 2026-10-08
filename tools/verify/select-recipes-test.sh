#!/usr/bin/env sh
# Fixture cases for tools/verify/select-recipes.sh.
#
# The key case is `justfile`: CI starts every job on it, so the selection for
# it must be exactly the dependency list of `verify`, in the same order. A
# recipe added to `verify` without a group in the selector, or a group whose
# recipes drifted from `verify`, fails here instead of letting a change skip
# its own checks.

set -eu

root=$(git rev-parse --show-toplevel)
select="$root/tools/verify/select-recipes.sh"
failed=0
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

always="check-agent-tools check-mcp check-commands check-published-pages check-document-numbers check-adr-applicability check-doc-links check-verify-selection check-agent-ready"
verify_deps=$(tr -d '\r' < "$root/justfile" | sed -n 's/^verify:[[:space:]]*//p')

[ -n "$verify_deps" ] || { echo "no verify recipe in justfile" >&2; exit 1; }

assert_selects() {
    name=$1
    expected=$2
    shift 2
    printf '%s\n' "$@" > "$scratch/paths"
    actual=$(sh "$select" --paths "$scratch/paths")
    if [ "$actual" != "$expected" ]; then
        echo "$name: expected" >&2
        echo "  $expected" >&2
        echo "got" >&2
        echo "  $actual" >&2
        failed=1
    fi
}

assert_fails() {
    name=$1
    workflow=$2
    needle=$3
    printf 'justfile\n' > "$scratch/paths"
    output=$(VERIFY_SELECT_WORKFLOW=$workflow sh "$select" --paths "$scratch/paths" 2>&1) && status=0 || status=$?
    if [ "$status" -eq 0 ]; then
        echo "$name: expected a failure, it passed: $output" >&2
        failed=1
    elif ! printf '%s' "$output" | grep -qF "$needle"; then
        echo "$name: failure does not name '$needle': $output" >&2
        failed=1
    fi
}

assert_selects "justfile selects all of verify" "$verify_deps" justfile
assert_selects "no change selects only the cheap checks" "$always"
assert_selects "docs select only the cheap checks" "$always" docs/README.md AGENTS.md
assert_selects "identity selects identity" \
    "$always identity-build identity-test identity-test-log-check identity-lint" apps/identity/cmd/identity/main.go
assert_selects "identity test tooling selects identity" \
    "$always identity-build identity-test identity-test-log-check identity-lint" tools/identity/check-test-log.py
assert_selects "hub bot selects its own recipes and the console that reads its kit" \
    "$always hub-bot-typecheck hub-bot-lint hub-bot-test hub-bot-build bot-console-typecheck bot-console-lint bot-console-test" apps/hub-bot/src/main.ts
assert_selects "published page selects the site api" \
    "$always community-site-api-typecheck community-site-api-lint community-site-api-test" docs/published/index.html
assert_selects "aspire.config.json selects apphost" \
    "$always apphost-config-check apphost-build apphost-test apphost-chart-test" aspire.config.json
assert_selects "auction surface selects the bot package and the console" \
    "$always hub-bot-typecheck hub-bot-lint hub-bot-test hub-bot-build bot-console-typecheck bot-console-lint bot-console-test" apps/hub-bot/src/surfaces/auction/surface.ts
assert_selects "screen lint selects the bot package and the console" \
    "$always hub-bot-typecheck hub-bot-lint hub-bot-test hub-bot-build bot-console-typecheck bot-console-lint bot-console-test" apps/hub-bot/testkit/lint/inspect.ts
assert_selects "delivery mechanics select the bot package and the console" \
    "$always hub-bot-typecheck hub-bot-lint hub-bot-test hub-bot-build bot-console-typecheck bot-console-lint bot-console-test" apps/hub-bot/src/core/delivery/deliver.ts
assert_selects "console selects itself and the hub whose lint covers it" \
    "$always hub-bot-typecheck hub-bot-lint hub-bot-test hub-bot-build bot-console-typecheck bot-console-lint bot-console-test" tests/contour/bot-wire/console/commands.ts
assert_selects "prefix match stops at the directory" "$always" apps/identity-old/readme.md
assert_selects "shared prefix match stops at the directory" "$always" shared/dotnet-old/readme.md

# A CI filter without local recipes and a glob form the selector does not
# understand both fail loudly instead of selecting less. The fixtures edit an
# LF copy: a Windows checkout may carry CRLF, and the patterns anchor at $.
tr -d '\r' < "$root/.github/workflows/ci.yml" > "$scratch/ci.yml"
sed 's/^            nats-tester:$/            nats-tester:\n              - '"'"'x\/**'"'"'\n            orphan:/' \
    "$scratch/ci.yml" > "$scratch/orphan.yml"
assert_fails "unmapped CI filter fails" "$scratch/orphan.yml" "orphan"

sed "s|^              - 'apps/identity/\*\*'\$|              - 'apps/*/go.mod'|" \
    "$scratch/ci.yml" > "$scratch/glob.yml"
assert_fails "unsupported glob fails" "$scratch/glob.yml" "apps/*/go.mod"

if [ "$failed" -ne 0 ]; then
    exit 1
fi
echo "select-recipes: all fixture cases pass"
