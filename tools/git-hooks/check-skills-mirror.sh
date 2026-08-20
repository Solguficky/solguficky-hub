#!/usr/bin/env sh
# Проверяет, что скиллы репозитория одинаковы в .claude/skills и .agents/skills.
#
# Проверяется не равенство наборов, а идентичность содержимого общих скиллов:
# часть скиллов намеренно существует только для Claude Code. Такие скиллы
# перечислены в CLAUDE_ONLY и должны появляться там осознанно, а не по забывчивости.

set -eu

CLAUDE_DIR='.claude/skills'
AGENTS_DIR='.agents/skills'

# Скиллы, завязанные на возможности Claude Code (подагенты, worktrees)
# и потому не зеркалируемые для других агентов.
CLAUDE_ONLY='sgh-delegate-subtask'

errors=''
fail() {
    errors="${errors}  - $1
"
}

is_claude_only() {
    for name in $CLAUDE_ONLY; do
        [ "$name" = "$1" ] && return 0
    done
    return 1
}

for path in "$CLAUDE_DIR"/*/; do
    [ -d "$path" ] || continue
    skill=$(basename "$path")

    if is_claude_only "$skill"; then
        continue
    fi

    if [ ! -d "${AGENTS_DIR}/${skill}" ]; then
        fail "${skill}: нет зеркала в ${AGENTS_DIR}/; скопируй его туда или внеси в CLAUDE_ONLY этого скрипта"
        continue
    fi

    if ! diff -r "${CLAUDE_DIR}/${skill}" "${AGENTS_DIR}/${skill}" >/dev/null 2>&1; then
        fail "${skill}: содержимое ${CLAUDE_DIR}/${skill} и ${AGENTS_DIR}/${skill} разошлось"
    fi
done

for path in "$AGENTS_DIR"/*/; do
    [ -d "$path" ] || continue
    skill=$(basename "$path")

    if [ ! -d "${CLAUDE_DIR}/${skill}" ]; then
        fail "${skill}: есть в ${AGENTS_DIR}/, но нет в ${CLAUDE_DIR}/"
    fi
done

if [ -n "$errors" ]; then
    {
        printf 'Скиллы в %s и %s не синхронны:\n\n' "$CLAUDE_DIR" "$AGENTS_DIR"
        printf '%s' "$errors"
        printf '\nПодробности расхождения: diff -r %s %s\n' "$CLAUDE_DIR" "$AGENTS_DIR"
    } >&2
    exit 1
fi
