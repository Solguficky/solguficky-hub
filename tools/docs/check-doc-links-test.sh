#!/usr/bin/env sh
# Fixture cases for tools/docs/check-doc-links.py.
#
# The live docs/ tree on develop is one happy path, but it cannot prove the
# slug is right: a link the gate wrongly rejects would have been "fixed" to
# match it. So this suite fails where the gate must fail and passes where it
# must pass - Cyrillic, case, punctuation, duplicate headings - each in its
# own tree seeded from one base.

set -eu

root=$(git rev-parse --show-toplevel)
check="$root/tools/docs/check-doc-links.py"
python=${PYTHON:-python3}
failed=0

run_check() {
    (
        cd "$1" || exit 1
        "$python" "$check" 2>&1
    )
}

assert_fails() {
    name=$1
    needle=$2
    work=$3

    output=$(run_check "$work") && status=0 || status=$?

    if [ "$status" -eq 0 ]; then
        echo "expected $name to fail, it passed:" >&2
        printf '%s\n' "$output" >&2
        failed=1
        return
    fi

    if ! printf '%s\n' "$output" | grep -Fq -- "$needle"; then
        echo "expected $name to name $needle:" >&2
        printf '%s\n' "$output" >&2
        failed=1
        return
    fi

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

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

base="$scratch/base"
mkdir -p "$base/docs/guide"
git -C "$base" init -q
git -C "$base" config user.email test@example.com
git -C "$base" config user.name test
# A commit spawns background maintenance, which creates and removes
# objects/maintenance.lock while cp -a walks .git. The copies below inherit
# this config, so their own commits stay quiet too.
git -C "$base" config maintenance.auto false
git -C "$base" config gc.auto 0

cat > "$base/docs/guide/target.md" <<'EOF'
# Target

## Открытые вопросы

## Ответы на 24.09.2026: Ф-4 — «финал», `just verify` и Ёлка 🎄

## Повтор

## Повтор

```md
## Заголовок внутри блока кода
```
EOF

cat > "$base/docs/index.md" <<'EOF'
# Index

- [target](guide/target.md)
- [вопросы](guide/target.md#открытые-вопросы)
EOF

printf 'root\n' > "$base/AGENTS.md"
git -C "$base" add docs AGENTS.md
git -C "$base" commit -qm seed

tree() {
    dir="$scratch/$1"
    cp -a "$base/." "$dir"
    printf '%s\n' "$dir"
}

assert_passes 'the seed tree' "$base"

# --- must fail -------------------------------------------------------------

work=$(tree renamed-heading)
sed 's/^## Открытые вопросы$/## Открытые вопросы на 03.09.2026/' "$base/docs/guide/target.md" > "$work/docs/guide/target.md"
assert_fails \
    'renamed heading names file, line and anchor' \
    'docs/index.md:4: guide/target.md#открытые-вопросы - no heading with anchor #открытые-вопросы' \
    "$work"

work=$(tree missing-file)
printf -- '- [gone](guide/gone.md)\n' >> "$work/docs/index.md"
assert_fails \
    'link to a missing file' \
    'docs/index.md:5: guide/gone.md - file docs/guide/gone.md does not exist' \
    "$work"

work=$(tree missing-local-anchor)
printf -- '- [self](#нет-такого)\n' >> "$work/docs/index.md"
assert_fails \
    'same-file anchor without a heading' \
    'docs/index.md:5: #нет-такого' \
    "$work"

work=$(tree third-duplicate)
printf -- '- [третий](guide/target.md#повтор-2)\n' >> "$work/docs/index.md"
assert_fails \
    'suffix past the last duplicate heading' \
    '#повтор-2' \
    "$work"

work=$(tree heading-in-fence)
printf -- '- [код](guide/target.md#заголовок-внутри-блока-кода)\n' >> "$work/docs/index.md"
assert_fails \
    'heading inside a fenced block is not an anchor' \
    '#заголовок-внутри-блока-кода' \
    "$work"

work=$(tree line-anchor)
printf -- '- [строка](guide/target.md#L3)\n' >> "$work/docs/index.md"
assert_fails \
    'GitHub line anchor on a local Markdown file' \
    '#l3' \
    "$work"

# The gate runs before the commit, so a new document is untracked when the
# check matters. A tracked-only file list would never see its links.
work=$(tree untracked-source)
printf '# New\n\n[gone](guide/gone.md)\n' > "$work/docs/new.md"
assert_fails \
    'broken link in an untracked document' \
    'docs/new.md:3: guide/gone.md' \
    "$work"

# An ignored file exists on disk but not on GitHub, so it is no target.
work=$(tree ignored-target)
printf 'docs/local.md\n' > "$work/.gitignore"
printf '# Local\n' > "$work/docs/local.md"
printf -- '- [local](local.md)\n' >> "$work/docs/index.md"
assert_fails \
    'target that exists only as an ignored file' \
    'file docs/local.md does not exist' \
    "$work"

# A line with an info string is content inside a block, not its end, so the
# heading after it is still code.
work=$(tree fence-info-string)
cat > "$work/docs/guide/fenced.md" <<'EOF'
# Fenced

```text
```md
## Удалённый
```
EOF
printf -- '- [удалённый](guide/fenced.md#удалённый)\n' >> "$work/docs/index.md"
assert_fails \
    'heading after an info-string line inside a block' \
    '#удалённый' \
    "$work"

# A paragraph before a fenced block is not the text of a setext heading.
work=$(tree setext-across-fence)
printf '# Across\n\nПример\n```\nкод\n```\n---\n' > "$work/docs/guide/across.md"
printf -- '- [пример](guide/across.md#пример)\n' >> "$work/docs/index.md"
assert_fails \
    'paragraph before a block read as a setext heading' \
    '#пример' \
    "$work"

# Frontmatter renders as a table, not as a setext heading.
work=$(tree frontmatter)
printf -- '---\ntitle: X\n---\n\n# Body\n' > "$work/docs/guide/front.md"
printf -- '- [мета](guide/front.md#title-x)\n' >> "$work/docs/index.md"
assert_fails \
    'frontmatter is no heading' \
    '#title-x' \
    "$work"

work=$(tree empty-docs)
printf '# Index\n\nСсылок нет.\n' > "$work/docs/index.md"
printf '# Target\n' > "$work/docs/guide/target.md"
assert_fails \
    'docs without a single relative link' \
    'the link parser matched nothing' \
    "$work"

# --- must pass -------------------------------------------------------------

# github-slugger registers suffixed slugs, so a third "Повтор 1" after two
# "Повтор" becomes повтор-1-1; a multi-line setext heading joins its lines;
# a BOM does not hide the first heading.
work=$(tree slugger-details)
printf '\357\273\277# Первый\n\n## Повтор\n\n## Повтор\n\n## Повтор 1\n\nПервая строка\nвторая строка\n---\n' > "$work/docs/guide/details.md"
cat >> "$work/docs/index.md" <<'EOF'
- [bom](guide/details.md#первый)
- [суффикс](guide/details.md#повтор-1-1)
- [setext](guide/details.md#первая-строка-вторая-строка)
EOF
assert_passes 'suffixed duplicates, multi-line setext and BOM' "$work"


work=$(tree github-slug)
cat >> "$work/docs/index.md" <<'EOF'
- [ответы](guide/target.md#ответы-на-24092026-ф-4--финал-just-verify-и-ёлка-)
- [ОТВЕТЫ](guide/target.md#Ответы-на-24092026-ф-4--финал-just-verify-и-ёлка-)
- [закодировано](guide/target.md#%D0%BE%D1%82%D0%BA%D1%80%D1%8B%D1%82%D1%8B%D0%B5-%D0%B2%D0%BE%D0%BF%D1%80%D0%BE%D1%81%D1%8B)
- [первый повтор](guide/target.md#повтор)
- [второй повтор](guide/target.md#повтор-1)
- [с заголовком](guide/target.md#открытые-вопросы "Открытые вопросы")
EOF
assert_passes 'Cyrillic, case, punctuation, code span, emoji and duplicates' "$work"

work=$(tree skipped-links)
cat >> "$work/docs/index.md" <<'EOF'
- [чужой README](https://github.com/example/repo/blob/main/README.md#L3-L13)
- [почта](mailto:someone@example.com)
- [скрипт](../tools/missing.sh)
- пример в коде: `[x](guide/gone.md)`

```md
[x](guide/gone.md#нет)
```
EOF
assert_passes 'external URLs, non-Markdown targets and code are skipped' "$work"

work=$(tree outside-docs)
printf -- '- [корень](../AGENTS.md)\n' >> "$work/docs/index.md"
assert_passes 'a Markdown target outside docs/ resolves' "$work"

if [ "$failed" -ne 0 ]; then
    exit 1
fi

echo "Doc link fixtures failed and passed where they should."
