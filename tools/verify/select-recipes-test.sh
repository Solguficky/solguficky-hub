#!/usr/bin/env sh
# Fixture cases for tools/verify/select-recipes.sh.
#
# The key case is `justfile`: CI starts every job on it, so the full selection
# for it must be exactly the dependency list of `verify`, in the same order. A
# recipe added to `verify` without a group in the selector, or a group whose
# recipes drifted from `verify`, fails here instead of letting a change skip
# its own checks. The local selection is the same list minus the heavy groups,
# and those come back by --deferred: nothing drops out of both.

set -eu

root=$(git rev-parse --show-toplevel)
select="$root/tools/verify/select-recipes.sh"
failed=0
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

always="check-agent-tools check-mcp check-commands check-published-pages check-document-numbers check-adr-applicability check-doc-links check-verify-selection check-agent-ready"
verify_deps=$(tr -d '\r' < "$root/justfile" | sed -n 's/^verify:[[:space:]]*//p')

[ -n "$verify_deps" ] || { echo "no verify recipe in justfile" >&2; exit 1; }

# Selector flags of the case: "--full", "", "--deferred" and so on. The cases
# below set it per block.
mode=""

assert_selects() {
    name=$1
    expected=$2
    shift 2
    printf '%s\n' "$@" > "$scratch/paths"
    # $mode is unquoted on purpose: an empty mode passes no argument.
    actual=$(sh "$select" $mode --paths "$scratch/paths" 2>"$scratch/stderr")
    if [ "$actual" != "$expected" ]; then
        echo "$name: expected" >&2
        echo "  $expected" >&2
        echo "got" >&2
        echo "  $actual" >&2
        failed=1
    fi
}

assert_notice() {
    name=$1
    needle=$2
    if ! grep -qF "$needle" "$scratch/stderr"; then
        echo "$name: stderr does not name '$needle':" >&2
        sed 's/^/  /' "$scratch/stderr" >&2
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

# Full selection: what CI selects.
mode="--full"
assert_selects "justfile selects all of verify" "$verify_deps" justfile
assert_selects "no change selects only the cheap checks" "$always"
assert_selects "docs select only the cheap checks" "$always" docs/README.md AGENTS.md
assert_selects "identity selects identity" \
    "$always identity-build identity-test identity-test-log-check identity-lint" apps/identity/cmd/identity/main.go
assert_selects "identity test tooling selects identity" \
    "$always identity-build identity-test identity-test-log-check identity-lint" tools/identity/check-test-log.py
assert_selects "hub bot selects its own recipes and the units that read its code" \
    "$always hub-bot-typecheck hub-bot-lint hub-bot-test hub-bot-build bot-console-typecheck bot-console-lint bot-console-test auction-seed-typecheck auction-seed-lint auction-seed-test" apps/hub-bot/src/main.ts
assert_selects "published page selects the site api" \
    "$always community-site-api-typecheck community-site-api-lint community-site-api-test" docs/published/index.html
assert_selects "aspire.config.json selects apphost" \
    "$always apphost-config-check apphost-build apphost-test apphost-chart-test" aspire.config.json
assert_selects "auction surface selects the bot package and the units that read it" \
    "$always hub-bot-typecheck hub-bot-lint hub-bot-test hub-bot-build bot-console-typecheck bot-console-lint bot-console-test auction-seed-typecheck auction-seed-lint auction-seed-test" apps/hub-bot/src/surfaces/auction/surface.ts
assert_selects "screen lint selects the bot package and the units that read it" \
    "$always hub-bot-typecheck hub-bot-lint hub-bot-test hub-bot-build bot-console-typecheck bot-console-lint bot-console-test auction-seed-typecheck auction-seed-lint auction-seed-test" apps/hub-bot/testkit/lint/inspect.ts
assert_selects "delivery mechanics select the bot package and the units that read it" \
    "$always hub-bot-typecheck hub-bot-lint hub-bot-test hub-bot-build bot-console-typecheck bot-console-lint bot-console-test auction-seed-typecheck auction-seed-lint auction-seed-test" apps/hub-bot/src/core/delivery/deliver.ts
assert_selects "console selects itself and the hub whose lint covers it" \
    "$always hub-bot-typecheck hub-bot-lint hub-bot-test hub-bot-build bot-console-typecheck bot-console-lint bot-console-test" tests/contour/bot-wire/console/commands.ts
assert_selects "auction seed selects only itself" \
    "$always auction-seed-typecheck auction-seed-lint auction-seed-test" tools/auction-seed/seed.ts
assert_selects "prefix match stops at the directory" "$always" apps/identity-old/readme.md
assert_selects "shared prefix match stops at the directory" "$always" shared/dotnet-old/readme.md
assert_selects "auction selects auction" "$always auction-verify" apps/auction/build.sbt
assert_selects "achievements selects achievements" \
    "$always achievements-build achievements-test achievements-format-check" apps/achievements/lib/achievements/application.ex
mode="--full --deferred"
assert_selects "full selection defers nothing" "" apps/auction/build.sbt

# Local selection: the default. Heavy groups leave the recipe list, are named
# on stderr and come back by --deferred; light groups select as in full.
heavy_recipes="apphost-config-check apphost-build apphost-test apphost-chart-test meetups-contracts-check meetups-build meetups-test meetups-format-check notifications-contracts-check notifications-build notifications-test auction-verify"
local_deps=""
for recipe in $verify_deps; do
    case " $heavy_recipes " in
        *" $recipe "*) ;;
        *) local_deps="${local_deps:+$local_deps }$recipe" ;;
    esac
done

mode=""
assert_selects "justfile selects verify without the heavy groups" "$local_deps" justfile
assert_notice "justfile names every heavy group" "уходит в CI: apphost meetups notifications auction"
assert_selects "auction leaves only the cheap checks" "$always" apps/auction/build.sbt
assert_notice "auction is named as left to CI" "уходит в CI: auction"
assert_selects "docs select only the cheap checks locally too" "$always" docs/README.md AGENTS.md
if [ -s "$scratch/stderr" ]; then
    echo "docs locally: expected no notice, got:" >&2
    sed 's/^/  /' "$scratch/stderr" >&2
    failed=1
fi
assert_selects "aspire.config.json leaves only the cheap checks" "$always" aspire.config.json
assert_selects "identity selects identity locally" \
    "$always identity-build identity-test identity-test-log-check identity-lint" apps/identity/cmd/identity/main.go

mode="--deferred"
assert_selects "justfile defers every heavy group" "apphost meetups notifications auction" justfile
assert_selects "auction defers auction" "auction" apps/auction/build.sbt
assert_selects "shared dotnet defers its consumers" "apphost meetups notifications" shared/dotnet/ServiceDefaults/Extensions.cs
assert_selects "docs defer nothing" "" docs/README.md

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

# A heavy group is also the CI job a delivery waits for: renaming the job
# fails the selection instead of leaving the delivery to wait for nothing.
sed 's/^  auction:$/  auction-jvm:/' "$scratch/ci.yml" > "$scratch/job.yml"
assert_fails "heavy group without its CI job fails" "$scratch/job.yml" "heavy group 'auction'"

printf 'docs/README.md\n' > "$scratch/paths"
if sh "$select" --unknown --paths "$scratch/paths" >/dev/null 2>&1; then
    echo "unknown flag: expected a failure, it passed" >&2
    failed=1
fi

if [ "$failed" -ne 0 ]; then
    exit 1
fi
echo "select-recipes: all fixture cases pass"
