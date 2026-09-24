#!/usr/bin/env sh
# Fixture cases for tools/docs/check-document-numbers.sh.
#
# The live catalog on develop is the happy path. These two trees lock the
# failure modes the gate exists for: a number used twice, and a numbered file
# that never entered the catalog index.

set -eu

root=$(git rev-parse --show-toplevel)
check="$root/tools/docs/check-document-numbers.sh"
failed=0

assert_fails() {
    name=$1
    needle=$2
    work=$3

    output=$(
        cd "$work" || exit 1
        sh "$check" 2>&1
    ) && status=0 || status=$?

    if [ "$status" -eq 0 ]; then
        echo "expected $name to fail, it passed:" >&2
        printf '%s\n' "$output" >&2
        failed=1
        return
    fi

    if ! printf '%s\n' "$output" | grep -Fq "$needle"; then
        echo "expected $name to name $needle:" >&2
        printf '%s\n' "$output" >&2
        failed=1
        return
    fi

    echo "ok: $name"
}

seed_catalog() {
    work=$1
    kind=$2
    dir=$3
    prefix=$4

    mkdir -p "$work/$dir"
    cat > "$work/$dir/README.md" <<EOF
# $kind

## Индекс

| $prefix | Title |
|---|---|
| [${prefix}-001](${prefix}-001-alpha.md) | Alpha |
EOF
    printf '# %s-001: Alpha\n' "$prefix" > "$work/$dir/${prefix}-001-alpha.md"
    printf '# template\n' > "$work/$dir/template.md"
}

work=$(mktemp -d)
dup=$(mktemp -d)
missing=$(mktemp -d)
trap 'rm -rf "$work" "$dup" "$missing"' EXIT

git -C "$work" init -q
git -C "$work" config user.email test@example.com
git -C "$work" config user.name test
seed_catalog "$work" ADR docs/decisions ADR
seed_catalog "$work" RFC docs/rfcs RFC
git -C "$work" add docs
git -C "$work" commit -qm seed

cp -a "$work/." "$dup"
printf '# ADR-001: Clash\n' > "$dup/docs/decisions/ADR-001-clash.md"
git -C "$dup" add docs/decisions/ADR-001-clash.md
git -C "$dup" commit -qm clash
assert_fails \
    'duplicate number' \
    'docs/decisions/ADR-001-clash.md' \
    "$dup"

if ! (
    cd "$dup" || exit 1
    sh "$check" 2>&1
) | grep -Fq 'docs/decisions/ADR-001-alpha.md'; then
    echo "expected duplicate number to name both paths" >&2
    failed=1
else
    echo "ok: duplicate number names both paths"
fi

cp -a "$work/." "$missing"
printf '# ADR-002: Orphan\n' > "$missing/docs/decisions/ADR-002-orphan.md"
git -C "$missing" add docs/decisions/ADR-002-orphan.md
git -C "$missing" commit -qm orphan
assert_fails \
    'file missing from the catalog index' \
    'docs/decisions/ADR-002-orphan.md' \
    "$missing"

printf '# RFC-001: Clash\n' > "$dup/docs/rfcs/RFC-001-clash.md"
git -C "$dup" add docs/rfcs/RFC-001-clash.md
git -C "$dup" commit -qm rfc-clash
assert_fails \
    'duplicate RFC number' \
    'docs/rfcs/RFC-001-clash.md' \
    "$dup"

printf '# RFC-002: Orphan\n' > "$missing/docs/rfcs/RFC-002-orphan.md"
git -C "$missing" add docs/rfcs/RFC-002-orphan.md
git -C "$missing" commit -qm rfc-orphan
assert_fails \
    'RFC file missing from the catalog index' \
    'docs/rfcs/RFC-002-orphan.md' \
    "$missing"

# The gate runs before the commit, so a freshly numbered document is untracked
# when the check matters. A tracked-only file list passed both cases green.
untracked=$(mktemp -d)
trap 'rm -rf "$work" "$dup" "$missing" "$untracked"' EXIT

cp -a "$work/." "$untracked"
printf '# RFC-001: Fresh clash\n' > "$untracked/docs/rfcs/RFC-001-fresh.md"
assert_fails \
    'untracked duplicate number' \
    'docs/rfcs/RFC-001-fresh.md' \
    "$untracked"

rm "$untracked/docs/rfcs/RFC-001-fresh.md"
printf '# ADR-002: Fresh orphan\n' > "$untracked/docs/decisions/ADR-002-fresh.md"
assert_fails \
    'untracked file missing from the catalog index' \
    'docs/decisions/ADR-002-fresh.md' \
    "$untracked"

if [ "$failed" -ne 0 ]; then
    exit 1
fi

echo "Document number fixtures failed where they should."
