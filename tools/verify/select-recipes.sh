#!/usr/bin/env sh
# Selects the recipes of the mechanical gate that a change can affect.
#
# Which component a path belongs to is read from the `changes` job of
# .github/workflows/ci.yml — the same filter CI uses to skip jobs. Reading it
# instead of copying it keeps one map: a path that starts a CI job starts the
# same recipes locally, and a path CI ignores is ignored here too.
#
# Usage:
#   select-recipes.sh              changed paths come from git: everything that
#                                  differs from the merge base with
#                                  origin/develop, committed or not, plus
#                                  untracked files
#   select-recipes.sh --paths F    changed paths are read from file F, one per
#                                  line; the fixture test uses this form
#
# VERIFY_SELECT_WORKFLOW overrides the workflow file; only the fixture test
# sets it.
#
# Prints the selected recipes on one line, in the order of `verify`. Cheap
# repository-wide checks are always selected.

set -eu

root=$(git rev-parse --show-toplevel)
workflow=${VERIFY_SELECT_WORKFLOW:-$root/.github/workflows/ci.yml}

# Recipes per CI filter, in the order of `verify`. A filter of ci.yml missing
# here fails the selection: a new CI job without local recipes is a decision,
# not a default. `contour` is not part of `verify` and is skipped on purpose.
always="check-agent-tools check-mcp check-commands check-published-pages check-document-numbers check-adr-applicability check-doc-links check-verify-selection"
groups="contracts identity telegram-bot community-site-api apphost meetups notifications auction nats-tester"
skipped_filters="contour"

recipes_of() {
    case $1 in
        contracts) echo "contracts-build contracts-check contracts-codegen-buf" ;;
        identity) echo "identity-build identity-test identity-lint" ;;
        telegram-bot) echo "telegram-bot-typecheck telegram-bot-lint telegram-bot-test telegram-bot-build" ;;
        community-site-api) echo "community-site-api-typecheck community-site-api-lint community-site-api-test" ;;
        apphost) echo "apphost-build apphost-test" ;;
        meetups) echo "meetups-contracts-check meetups-build meetups-test meetups-format-check" ;;
        notifications) echo "notifications-contracts-check notifications-build notifications-test" ;;
        auction) echo "auction-verify" ;;
        nats-tester) echo "nats-tester-check" ;;
    esac
}

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
paths="$scratch/paths"
filters="$scratch/filters"

case ${1:-} in
    --paths)
        [ -n "${2:-}" ] || { echo "select-recipes: --paths needs a file" >&2; exit 2; }
        cat "$2" > "$paths"
        ;;
    "")
        base=$(git merge-base HEAD origin/develop 2>/dev/null) || {
            echo "select-recipes: no merge base with origin/develop — run git fetch origin" >&2
            exit 1
        }
        # --no-renames lists the old path of a move too: a file moved out of a
        # component changes that component as much as one deleted from it.
        {
            git -c core.quotepath=off diff --name-only --no-renames "$base"
            git -c core.quotepath=off ls-files --others --exclude-standard
        } > "$paths"
        ;;
    *)
        echo "select-recipes: unknown argument $1" >&2
        exit 2
        ;;
esac

[ -f "$workflow" ] || { echo "select-recipes: no workflow at $workflow" >&2; exit 1; }

# One "filter<TAB>glob" line per glob of the paths-filter block. The block
# ends at the first line indented less than its filter names.
awk '
    function indent(s) { match(s, /^ */); return RLENGTH }
    # A Windows checkout may carry CRLF; the map must not depend on it.
    { sub(/\r$/, "") }
    /filters: \|[ \t]*$/ { inblock = 1; key = -1; next }
    !inblock { next }
    /^[ \t]*$/ || /^[ \t]*#/ { next }
    {
        i = indent($0)
        if (key < 0) key = i
        if (i < key) exit
        line = substr($0, i + 1)
        if (i == key) { sub(/:[ \t]*$/, "", line); name = line; next }
        if (line ~ /^- /) {
            glob = substr(line, 3)
            gsub(/^["\047]|["\047]$/, "", glob)
            print name "\t" glob
        }
    }
' "$workflow" > "$filters"

[ -s "$filters" ] || { echo "select-recipes: no paths-filter block in $workflow" >&2; exit 1; }

for name in $(cut -f1 "$filters" | sort -u); do
    case " $groups $skipped_filters " in
        *" $name "*) ;;
        *)
            echo "select-recipes: CI filter '$name' has no recipes here — map it in tools/verify/select-recipes.sh or skip it there" >&2
            exit 1
            ;;
    esac
done
for group in $groups; do
    grep -q "^$group	" "$filters" || {
        echo "select-recipes: group '$group' has no CI filter in $workflow" >&2
        exit 1
    }
done

# Only the two glob forms ci.yml uses are understood: an exact path and a
# directory prefix ending in /**. Anything else fails instead of matching
# nothing, which would drop a component silently.
hit=$(awk -F '\t' '
    NR == FNR {
        if ($2 ~ /\/\*\*$/) { prefix[NR] = substr($2, 1, length($2) - 2) }
        else if ($2 ~ /[*?[]/) { print "unsupported glob " $2 > "/dev/stderr"; bad = 1; exit 1 }
        else { exact[NR] = $2 }
        filter[NR] = $1
        n = NR
        next
    }
    $0 == "" { next }
    {
        for (k = 1; k <= n; k++) {
            if ((k in prefix && index($0, prefix[k]) == 1) || (k in exact && $0 == exact[k])) {
                selected[filter[k]] = 1
            }
        }
    }
    END { if (bad) exit 1; for (f in selected) print f }
' "$filters" "$paths") || { echo "select-recipes: cannot read the filters of $workflow" >&2; exit 1; }

out=$always
for group in $groups; do
    if printf '%s\n' "$hit" | grep -qx "$group"; then
        out="$out $(recipes_of "$group")"
    fi
done
echo "$out"
