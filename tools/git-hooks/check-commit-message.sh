#!/usr/bin/env sh
# Проверяет сообщение коммита по docs/standards/git/commit-messages.md.
#
#   check-commit-message.sh <файл>   — режим хука commit-msg
#   ... | check-commit-message.sh    — режим пайплайна, сообщение из stdin
#
# Возвращает 0, если сообщение соответствует стандарту, иначе 1 со списком
# всех нарушений сразу: чинить по одному за прогон неудобно.

set -eu

TYPES='feat|fix|docs|refactor|test|chore|build|ci|revert'
MAX_SUBJECT=72

if [ "$#" -ge 1 ]; then
    raw=$(cat "$1")
else
    raw=$(cat)
fi

# Убираем комментарии git и diff, который добавляет `commit --verbose`.
message=$(
    printf '%s\n' "$raw" |
        sed -e '/^# *-\{2,\} *>8 *-\{2,\}/,$d' -e '/^#/d' -e 's/\r$//'
)

header=$(printf '%s\n' "$message" | sed -e '/./,$!d' | sed -n '1p')

# Служебные сообщения генерирует сам git, автор их не пишет и не редактирует.
case "$header" in
    'Merge '* | 'fixup!'* | 'squash!'* | 'amend!'*)
        exit 0
        ;;
esac

errors=''
fail() {
    errors="${errors}  - $1
"
}

if [ -z "$header" ]; then
    fail 'сообщение пустое'
    printf 'Сообщение коммита не соответствует docs/standards/git/commit-messages.md:\n%s' "$errors" >&2
    exit 1
fi

# --- Заголовок -------------------------------------------------------------

if printf '%s' "$header" | grep -qE '[А-Яа-яЁё]'; then
    fail 'заголовок на русском; заголовок пишется на английском, обсуждение и документация остаются на русском'
elif [ "${#header}" -gt "$MAX_SUBJECT" ]; then
    # Длина считается в байтах: без LANG=*.UTF-8 sh не умеет иначе. Для
    # соответствующего стандарту заголовка это одно и то же, а для заголовка
    # с кириллицей число было бы вдвое завышено — там уже сработала проверка выше.
    fail "длина заголовка ${#header} символов, максимум ${MAX_SUBJECT}"
fi

case "$header" in
    *.)
        fail 'заголовок заканчивается точкой'
        ;;
esac

if ! printf '%s' "$header" | grep -qE "^(${TYPES})(\([^()]+\))?: "; then
    fail "заголовок не начинается с 'type: ' или 'type(scope): '; допустимые типы: $(printf '%s' "$TYPES" | tr '|' ' ')"
else
    scope=$(printf '%s' "$header" | sed -nE "s/^(${TYPES})\(([^()]+)\):.*/\2/p")
    if [ -n "$scope" ]; then
        case "$scope" in
            *.*)
                fail "scope '${scope}' похож на имя файла; scope — это сервис или раздел (identity, meetups, contracts, adr)"
                ;;
        esac
        if ! printf '%s' "$scope" | grep -qE '^[a-z0-9][a-z0-9-]*$'; then
            fail "scope '${scope}' должен быть в нижнем регистре без пробелов"
        fi
    fi

    subject=$(printf '%s' "$header" | sed -E "s/^(${TYPES})(\([^()]+\))?: //")
    if [ -z "$subject" ]; then
        fail 'после типа нет текста заголовка'
    elif ! printf '%s' "$subject" | grep -qE '^[A-Z]'; then
        fail "после двоеточия нужна заглавная буква, сейчас '${subject}'"
    fi
fi

# --- Тело ------------------------------------------------------------------
#
# Тела у коммита нет. Допускаются только трейлеры после пустой строки:
# 'Co-Authored-By: ...' и продолжения трейлеров с отступом.

body=$(printf '%s\n' "$message" | sed -e '/./,$!d' | sed -e '1d' -e '/./,$!d')

if [ -n "$body" ]; then
    second_line=$(printf '%s\n' "$message" | sed -e '/./,$!d' | sed -n '2p')
    if [ -n "$second_line" ]; then
        fail 'между заголовком и трейлерами нужна пустая строка'
    fi

    offenders=$(
        printf '%s\n' "$body" |
            grep -vE '^[[:space:]]*$' |
            grep -vE '^[A-Za-z][A-Za-z0-9-]*: .+' |
            grep -vE '^[[:space:]]+' |
            head -3 || true
    )
    if [ -n "$offenders" ]; then
        fail 'у коммита не должно быть тела; если объяснение не помещается в заголовок, коммит слишком большой — раздели его, а обоснование запиши в ADR'
        fail "первая лишняя строка: $(printf '%s' "$offenders" | sed -n '1p')"
    fi
fi

# --- Итог ------------------------------------------------------------------

if [ -n "$errors" ]; then
    {
        printf 'Сообщение не соответствует docs/standards/git/commit-messages.md\n\n'
        printf '  %s\n\n' "$header"
        printf '%s' "$errors"
        printf '\nПример: feat(identity): Add access status to the profile table\n'
    } >&2
    exit 1
fi
