#!/usr/bin/env sh
# Verify numbered ADR and RFC documents are unique and listed in their catalog.
#
# A number taken inside a long-lived branch is a distributed counter without a
# lock. Git does not see the collision: the filenames differ, so both files
# merge cleanly. The only place two documents meet is the catalog index, and
# even that conflict appears after the pull request is opened.
#
# On pull_request GitHub Actions checks out the merge ref, where the incoming
# document sits next to whatever develop already accepted. This gate reads that
# tree and asks two questions that need no judgment: each number occurs once,
# and each numbered file is linked from the catalog README.
#
# The file set comes from Git: an untracked scratch file is the author's
# business, a committed one is the defect this check exists for. The catalog
# text is read from the working tree, same as check-published-pages.sh: the
# index row must be a table line that links the basename. README.md and
# template.md have no number and are ignored. docs/learning/ and
# docs/standards/ are out of scope.

set -eu

root=$(git rev-parse --show-toplevel)
cd "$root"

failed=0
adr_count=0
rfc_count=0
scratch=$(mktemp)
trap 'rm -f "$scratch"' EXIT

# Один каталог: номер встречается ровно один раз, и у каждого номера есть
# строка в индексе. Обе проверки собирают все нарушения, а не падают на первом.
check_catalog() {
    prefix=$1
    dir=$2
    index="$dir/README.md"

    tracked=$(git -c core.quotePath=false ls-files -- "$dir")

    if [ -z "$tracked" ]; then
        echo "No tracked files under $dir: the catalog is missing." >&2
        failed=1
        return
    fi

    if ! printf '%s\n' "$tracked" | grep -q -x -F "$index"; then
        echo "$index is not tracked: numbered files have no catalog to appear in." >&2
        failed=1
        return
    fi

    files=$(printf '%s\n' "$tracked" | grep -E "^${dir}/${prefix}-[0-9]{3}-[^/]+\\.md$" || true)

    if [ -z "$files" ]; then
        echo "No numbered ${prefix} files under $dir." >&2
        failed=1
        return
    fi

    count=$(printf '%s\n' "$files" | grep -c .)
    case $prefix in
        ADR) adr_count=$count ;;
        RFC) rfc_count=$count ;;
    esac

    printf '%s\n' "$files" | awk -v prefix="$prefix" '
        {
            if (match($0, prefix "-[0-9]{3}-")) {
                number = substr($0, RSTART + length(prefix) + 1, 3)
                paths[number] = paths[number] "  - " $0 "\n"
                counts[number]++
            }
        }
        END {
            for (number in counts) {
                if (counts[number] > 1) {
                    printf "%s-%s appears %d times:\n%s", prefix, number, counts[number], paths[number]
                }
            }
        }
    ' > "$scratch"

    if [ -s "$scratch" ]; then
        echo "Numbered documents must be unique inside $dir:" >&2
        cat "$scratch" >&2
        failed=1
    fi

    : > "$scratch"
    printf '%s\n' "$files" | while IFS= read -r file; do
        [ -n "$file" ] || continue
        name=${file##*/}
        if ! grep -E '^\|' "$index" | grep -Fq "]($name)"; then
            echo "  - $file" >> "$scratch"
        fi
    done

    if [ -s "$scratch" ]; then
        echo "Numbered files with no link in $index:" >&2
        cat "$scratch" >&2
        failed=1
    fi
}

check_catalog ADR docs/decisions
check_catalog RFC docs/rfcs

if [ "$failed" -ne 0 ]; then
    exit 1
fi

echo "Document numbers are unique: $adr_count ADR, $rfc_count RFC."
