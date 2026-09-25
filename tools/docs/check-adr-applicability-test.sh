#!/usr/bin/env sh
# Fixture cases for tools/docs/check-adr-applicability.sh.
#
# The live catalog on develop is the happy path. These trees lock the failure
# modes the gate exists for, plus the ones that would otherwise let it pass
# while comparing nothing. Fixture files are never committed: the gate reads
# the index and the disk, so a freshly written, untracked ADR must be seen.

set -eu

root=$(git rev-parse --show-toplevel)
check="$root/tools/docs/check-adr-applicability.sh"
failed=0
# new_tree runs in a command substitution, so it cannot record its tree in a
# variable of this shell; every tree lives under one directory removed on exit.
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

run_check() {
    (
        cd "$1" || exit 1
        sh "$check" 2>&1
    )
}

assert_fails() {
    name=$1
    work=$2
    shift 2

    output=$(run_check "$work") && status=0 || status=$?

    if [ "$status" -eq 0 ]; then
        echo "expected $name to fail, it passed:" >&2
        printf '%s\n' "$output" >&2
        failed=1
        return
    fi

    for needle in "$@"; do
        if ! printf '%s\n' "$output" | grep -Fq -- "$needle"; then
            echo "expected $name to name $needle:" >&2
            printf '%s\n' "$output" >&2
            failed=1
            return
        fi
    done

    echo "ok: $name"
}

assert_passes() {
    name=$1
    work=$2

    output=$(run_check "$work") && status=0 || status=$?

    if [ "$status" -ne 0 ]; then
        echo "expected $name to pass, it failed:" >&2
        printf '%s\n' "$output" >&2
        failed=1
        return
    fi

    echo "ok: $name"
}

# Каталог из трёх ADR: Active и Active, limited scope без баннера и один
# Superseded с баннером. Вторая строка индекса строится аргументами.
new_tree() {
    work=$(mktemp -d "$scratch/tree.XXXXXX")
    git -C "$work" init -q
    mkdir -p "$work/docs/decisions"
    cat > "$work/docs/decisions/README.md" <<'EOF'
# Architecture Decision Records

## Индекс

| ADR | Решение | Current applicability | Комментарий |
|---|---|---|---|
| [ADR-001](ADR-001-alpha.md) | Alpha | Active | Действует |
| [ADR-002](ADR-002-beta.md) | Beta | Superseded | Заменён ADR-001 |
| [ADR-003](ADR-003-gamma.md) | Gamma | Active, limited scope | Только для Gamma |
EOF
    printf '# ADR-001: Alpha\n\n## Контекст\n' > "$work/docs/decisions/ADR-001-alpha.md"
    printf '# ADR-002: Beta\n\n> **Текущая применимость:** Superseded. Заменён ADR-001.\n\n## Контекст\n' \
        > "$work/docs/decisions/ADR-002-beta.md"
    printf '# ADR-003: Gamma\n\n## Контекст\n' > "$work/docs/decisions/ADR-003-gamma.md"
    printf '%s\n' "$work"
}

base=$(new_tree)
assert_passes 'Active family without a banner, untracked files' "$base"

# No dot after the status: cutting at the first dot would drop a trailing CR by
# accident, so only stripping CR itself keeps this banner equal to the row.
crlf=$(new_tree)
sed 's/$/\r/' "$crlf/docs/decisions/README.md" > "$crlf/readme.tmp"
mv "$crlf/readme.tmp" "$crlf/docs/decisions/README.md"
printf '# ADR-002: Beta\r\n\r\n> **Текущая применимость:** Superseded\r\n' \
    > "$crlf/docs/decisions/ADR-002-beta.md"
assert_passes 'CRLF line endings in the index and the file' "$crlf"

no_banner=$(new_tree)
printf '# ADR-002: Beta\n\n## Контекст\n' > "$no_banner/docs/decisions/ADR-002-beta.md"
assert_fails 'non-Active ADR without a banner' "$no_banner" \
    'docs/decisions/ADR-002-beta.md' 'banner missing'

mismatch=$(new_tree)
printf '# ADR-002: Beta\n\n> **Текущая применимость:** Historical. Свидетельство.\n' \
    > "$mismatch/docs/decisions/ADR-002-beta.md"
assert_fails 'banner status differs from the index' "$mismatch" \
    'docs/decisions/ADR-002-beta.md' "'Superseded'" "'Historical'"

buried=$(new_tree)
printf '# ADR-002: Beta\n\n## Контекст\n\n> **Текущая применимость:** Superseded. Заменён ADR-001.\n' \
    > "$buried/docs/decisions/ADR-002-beta.md"
assert_fails 'banner below the first line after the heading' "$buried" \
    'docs/decisions/ADR-002-beta.md' 'banner missing'

# The same typo in both places agrees with itself; only the list of allowed
# values tells it apart from a real status.
unknown=$(new_tree)
sed 's/| Superseded |/| Supersede |/' "$unknown/docs/decisions/README.md" > "$unknown/readme.tmp"
mv "$unknown/readme.tmp" "$unknown/docs/decisions/README.md"
printf '# ADR-002: Beta\n\n> **Текущая применимость:** Supersede. Заменён ADR-001.\n' \
    > "$unknown/docs/decisions/ADR-002-beta.md"
assert_fails 'index status outside the allowed values' "$unknown" \
    'docs/decisions/ADR-002-beta.md' "'Supersede'"

orphan_row=$(new_tree)
rm "$orphan_row/docs/decisions/ADR-002-beta.md"
assert_fails 'index row linking a missing file' "$orphan_row" \
    'docs/decisions/ADR-002-beta.md' 'does not exist'

active_orphan_row=$(new_tree)
rm "$active_orphan_row/docs/decisions/ADR-001-alpha.md"
assert_fails 'Active row linking a missing file' "$active_orphan_row" \
    'docs/decisions/ADR-001-alpha.md' 'does not exist'

# Each of these rows used to drop out of the check while the rest stayed green.
for shape in \
    'dot-slash link|s#](ADR-003-gamma.md)#](./ADR-003-gamma.md)#' \
    'anchored link|s#](ADR-003-gamma.md)#](ADR-003-gamma.md\#x)#' \
    'row without a leading pipe|s#^| \[ADR-003\]#[ADR-003]#'; do
    label=${shape%%|*}
    unparsed=$(new_tree)
    sed "${shape#*|}" "$unparsed/docs/decisions/README.md" > "$unparsed/readme.tmp"
    mv "$unparsed/readme.tmp" "$unparsed/docs/decisions/README.md"
    assert_fails "unparsed ADR row: $label" "$unparsed" \
        'ADR row not parsed' 'ADR-003'
done

all_active=$(new_tree)
sed 's/| Superseded |/| Active |/' "$all_active/docs/decisions/README.md" > "$all_active/readme.tmp"
mv "$all_active/readme.tmp" "$all_active/docs/decisions/README.md"
assert_fails 'index with no non-Active rows' "$all_active" \
    'nothing was compared'

no_table=$(new_tree)
printf '# Architecture Decision Records\n' > "$no_table/docs/decisions/README.md"
assert_fails 'index without ADR rows' "$no_table" \
    'No ADR rows parsed'

if [ "$failed" -ne 0 ]; then
    exit 1
fi

echo "ADR applicability fixtures failed where they should."
