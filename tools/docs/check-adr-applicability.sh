#!/usr/bin/env sh
# Verify the applicability of a non-Active ADR agrees between the catalog index
# and the banner inside the file.
#
# docs/decisions/README.md keeps applicability in two places: the index row and
# the "> **Текущая применимость:**" banner on the first line after the file's
# heading. The index serves someone scanning all decisions, the banner serves
# someone who came to the file by a link. They drift silently: ADR-006 said
# Superseded in the file and Needs review in the index until someone read both.
#
# The subjects come from the index, because the status lives only there; each
# linked file is then read from disk, tracked or not. Five failures need no
# judgment: an ADR row whose first cell does not parse, a row linking a file
# that does not exist, a status outside the five allowed values, a non-Active
# file whose first non-empty line after the heading is not the banner, and a
# banner whose status differs from the row. Active and "Active, limited scope"
# need no banner: for them only the file and the value are checked. An index
# with no non-Active rows is treated as a broken parse, not as green: a gate
# that sees nothing to check must not report that everything matches, and a
# row it could not read must not quietly shrink what it checks.
#
# The index rows are read the way check-document-numbers.sh reads them: table
# lines, the link to the file in the first cell. The status is the third cell.
# Whether the banner's fate is well-formed is left to review.

set -eu

root=$(git rev-parse --show-toplevel)
cd "$root"

dir=docs/decisions
index="$dir/README.md"
banner_prefix='> **Текущая применимость:** '
tab=$(printf '\t')
failed=0
total=0
checked=0

if [ ! -f "$index" ]; then
    echo "$index is missing: there is no applicability to compare." >&2
    exit 1
fi

# Строка индекса -> "имя файла<TAB>статус". Строкой ADR считается любая, что
# начинается ссылкой [ADR-NNN], с ведущим "|" или без: проза индекса тоже
# ссылается на ADR, но не с начала строки. Строка, чью первую ячейку не удалось
# разобрать как [ADR-NNN](ADR-NNN-slug.md), выходит с маркером "!" вместо имени:
# молча отброшенная, она вывела бы решение из-под проверки зелёным.
rows=$(
    awk -F'|' '
        {
            sub(/\r$/, "")
            if ($0 !~ /^[ \t]*\|?[ \t]*\[ADR-[0-9][0-9][0-9]\]/) {
                next
            }
            cell = $2
            gsub(/^[ \t]+|[ \t]+$/, "", cell)
            if ($0 !~ /^\|/ || cell !~ /^\[ADR-[0-9][0-9][0-9]\]\(ADR-[0-9][0-9][0-9]-[^)#\/]+\.md\)$/) {
                print "!\t" $0
                next
            }
            match(cell, /\(ADR-[^)]+\)/)
            name = substr(cell, RSTART + 1, RLENGTH - 2)
            status = $4
            gsub(/`/, "", status)
            gsub(/^[ \t]+|[ \t]+$/, "", status)
            print name "\t" status
        }
    ' "$index"
)

if [ -z "$rows" ]; then
    echo "No ADR rows parsed from $index: the index table is missing or changed shape." >&2
    exit 1
fi

while IFS="$tab" read -r name status; do
    [ -n "$name" ] || continue
    total=$((total + 1))

    if [ "$name" = '!' ]; then
        echo "$index: ADR row not parsed, expected '| [ADR-NNN](ADR-NNN-slug.md) | ... | status | ...': $status" >&2
        failed=1
        continue
    fi

    file="$dir/$name"

    if [ ! -f "$file" ]; then
        echo "$file: index says '$status', but the file does not exist." >&2
        failed=1
        continue
    fi

    case $status in
        'Active' | 'Active, limited scope')
            continue
            ;;
        'Historical' | 'Superseded' | 'Needs review') ;;
        *)
            echo "$file: index status '$status' is not one of the values listed in $index." >&2
            failed=1
            continue
            ;;
    esac

    checked=$((checked + 1))

    # Первая непустая строка после заголовка "# ".
    line=$(
        awk '
            { sub(/\r$/, "") }
            !heading && /^# / { heading = 1; next }
            heading && NF { print; exit }
        ' "$file"
    )

    case $line in
        "$banner_prefix"*) ;;
        *)
            echo "$file: index says '$status', banner missing from the first line after the heading." >&2
            failed=1
            continue
            ;;
    esac

    rest=${line#"$banner_prefix"}
    banner=${rest%%.*}

    if [ "$banner" != "$status" ]; then
        echo "$file: index says '$status', banner says '$banner'." >&2
        failed=1
    fi
done <<EOF
$rows
EOF

if [ "$checked" -eq 0 ] && [ "$failed" -eq 0 ]; then
    echo "No non-Active ADR in $index: nothing was compared, the index parse is suspect." >&2
    exit 1
fi

if [ "$failed" -ne 0 ]; then
    exit 1
fi

echo "ADR applicability matches the index: $checked non-Active of $total ADR."
