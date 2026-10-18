#!/usr/bin/env sh
# Verify the YAML frontmatter of every SKILL.md, in the Skillshare sources and
# in the targets laid out on this machine.
#
# Nothing else looks inside a skill. Targets are generated rather than committed
# (ADR-041), so an unparseable frontmatter reaches every machine unnoticed:
# Skillshare and Claude Code drop the description, fall back to the H1 heading,
# and the skill silently loses the text a model decides to invoke it by.
#
# The frontmatter dialect here is small but not flat: alongside `name` and
# `description` the vendored packs carry nested mappings, sequences, flow
# sequences, quoted scalars and folded scalars. So this check does not parse
# YAML. It walks the top level of the block, validates the shape of every
# top-level entry, descends only into plain scalars (the one construct where the
# silent failure lives) and treats every other nested body as opaque. That keeps
# it free of a YAML library: CI runs `sh` with nothing installed beyond the
# checkout.

set -eu

SKILLS_ROOT='.skillshare/skills'
SKILLIGNORE="$SKILLS_ROOT/.skillignore"
UNIVERSAL_SKILLS='.agents/skills'
CLAUDE_SKILLS='.claude/skills'

is_ignored() {
    [ -f "$SKILLIGNORE" ] && grep -Fxq "$1" "$SKILLIGNORE"
}

# The tree is walked with shell globs, not `find`. Called from PowerShell, `sh`
# resolves an unqualified `find` to C:\Windows\system32\find.exe, which prints
# usage errors and finds nothing, so the check failed on an empty file list
# without looking at a single skill. Globs need no external binary at all.
#
# POSIX sh has no `local`, so the recursion shares `entry` with its caller; that
# is safe only because nothing reads `entry` after the recursive call returns.
found=''
collect() {
    for entry in "$1"/* "$1"/.[!.]*; do
        [ -e "$entry" ] || continue
        case ${entry##*/} in .git) continue ;; esac
        if [ -d "$entry" ]; then
            collect "$entry"
        elif [ "${entry##*/}" = SKILL.md ]; then
            found="$found$entry
"
        fi
    done
}

for root in "$SKILLS_ROOT" "$CLAUDE_SKILLS" "$UNIVERSAL_SKILLS"; do
    [ -d "$root" ] && collect "$root"
done

# Disabled skills are never synced to a target, so an upstream frontmatter this
# repository cannot fix is not a reason to fail the check.
set --
IFS='
'
for skill_file in $found; do
    name=$(basename "$(dirname "$skill_file")")
    if is_ignored "$name"; then
        continue
    fi
    set -- "$@" "$skill_file"
done
unset IFS

if [ "$#" -eq 0 ]; then
    printf 'No SKILL.md found under %s, %s or %s.\n' \
        "$SKILLS_ROOT" "$CLAUDE_SKILLS" "$UNIVERSAL_SKILLS" >&2
    exit 1
fi

program=$(cat <<'AWK'
function trim(text) {
    sub(/^[ \t]+/, "", text)
    sub(/[ \t]+$/, "", text)
    return text
}

function fail(message) {
    printf "  - %s: %s\n", current, message
    problems++
    broken = 1
}

# A plain scalar ends at ": " and at " #", and cannot end with ":" either. Both
# failures are silent in different ways, so both point at the same fix.
function check_plain(text) {
    if (index(text, ": ") > 0)
        fail("value of \"" key_of_value "\" contains \": \" and breaks the mapping; quote the value")
    else if (text ~ /:$/)
        fail("value of \"" key_of_value "\" ends with \":\" and breaks the mapping; quote the value")
    else if (index(text, " #") > 0)
        fail("value of \"" key_of_value "\" contains \" #\" and is truncated as a comment; quote the value")
}

# Where a quoted scalar closes, or 0 if it runs past the end of the line. The
# scan starts at `from`: past the opening quote on the entry line, at the first
# column on a continuation. It honours the two ways YAML hides a quote inside a
# scalar - a backslash escape in a double-quoted one, a doubled quote in a
# single-quoted one.
#
# What follows the closing quote is deliberately not inspected. A trailing
# comment is legal there, and reading the last character of the line instead
# would report `description: "text" # note` as an unclosed scalar.
function close_pos(value, quote, from,   i, n, c) {
    n = length(value)
    i = from

    while (i <= n) {
        c = substr(value, i, 1)
        if (quote == "\"" && c == "\\") {
            i += 2
            continue
        }
        if (c == quote) {
            if (quote == "'" && substr(value, i + 1, 1) == quote) {
                i += 2
                continue
            }
            return i
        }
        i++
    }

    return 0
}

function unclosed() {
    fail("value of \"" key_of_value "\" opens with " open_quote " and never closes; YAML swallows the rest of the block")
}

function require(name) {
    if (!(name in seen))
        fail("frontmatter has no \"" name "\" key")
    else if (kind[name] == "flow")
        fail("\"" name "\" must be a non-empty string")
    else if (trim(text[name]) == "")
        fail("\"" name "\" must be a non-empty string")
}

function finish() {
    if (broken)
        return
    if (state == 0)
        fail("no YAML frontmatter: the file does not start with \"---\"")
    else if (state == 1)
        fail("frontmatter is not closed: no second \"---\"")
    else {
        require("name")
        require("description")
    }
}

BEGIN {
    problems = 0
    current = ""
}

FNR == 1 {
    if (current != "")
        finish()
    current = FILENAME
    state = 0
    broken = 0
    mode = ""
    open_quote = ""
    key_of_value = ""
    split("", seen)
    split("", kind)
    split("", text)
}

{
    line = $0
    sub(/\r$/, "", line)
    sub(/[ \t]+$/, "", line)

    if (broken || state == 2)
        next

    if (state == 0) {
        if (line == "---")
            state = 1
        else
            fail("no YAML frontmatter: the file does not start with \"---\"")
        next
    }

    if (line == "---" || line == "...") {
        if (mode == "quoted")
            unclosed()
        state = 2
        next
    }
    if (line == "" || line ~ /^#/)
        next

    # An indented line continues the previous entry. Only a plain or a block
    # scalar carries text this check cares about; anything else is a nested
    # body it deliberately does not read.
    if (line ~ /^[ \t]/) {
        body = trim(line)
        if (mode == "quoted") {
            at = close_pos(body, open_quote, 1)
            if (at > 0) {
                text[key_of_value] = text[key_of_value] " " substr(body, 1, at - 1)
                mode = "opaque"
                open_quote = ""
            } else {
                text[key_of_value] = text[key_of_value] " " body
            }
            next
        }
        if (mode == "plain" || mode == "block") {
            if (mode == "plain")
                check_plain(body)
            text[key_of_value] = text[key_of_value] " " body
        }
        next
    }

    # A quoted scalar may run over several indented lines, so it is broken only
    # once something that cannot belong to it arrives: the end of the block
    # above, or the next top-level key here.
    if (mode == "quoted") {
        unclosed()
        next
    }

    if (!match(line, /^[A-Za-z0-9_][A-Za-z0-9_.-]*:([ \t]|$)/)) {
        fail("line is not a YAML mapping entry: " substr(line, 1, 40))
        next
    }

    separator = index(line, ":")
    key = substr(line, 1, separator - 1)
    value = trim(substr(line, separator + 1))

    if (key in seen) {
        fail("duplicate \"" key "\" key")
        next
    }
    seen[key] = 1
    key_of_value = key
    text[key] = ""

    if (value == "") {
        kind[key] = "nested"
        mode = "opaque"
        next
    }

    marker = substr(value, 1, 1)
    if (marker == "|" || marker == ">") {
        kind[key] = "block"
        mode = "block"
        next
    }
    if (marker == "[" || marker == "{") {
        kind[key] = "flow"
        mode = "opaque"
        next
    }
    if (marker == "\"" || marker == "'") {
        kind[key] = "quoted"
        at = close_pos(value, marker, 2)
        if (at > 0) {
            mode = "opaque"
            text[key] = substr(value, 2, at - 2)
        } else {
            mode = "quoted"
            open_quote = marker
            text[key] = substr(value, 2)
        }
        next
    }
    if (index("*&!%@`", marker) > 0) {
        fail("value of \"" key "\" starts with the YAML indicator \"" marker "\"; quote the value")
        next
    }

    kind[key] = "plain"
    mode = "plain"
    check_plain(value)
    text[key] = value
}

END {
    if (current != "")
        finish()
    if (problems > 0)
        exit 1
}
AWK
)

if report=$(awk "$program" "$@") ; then
    printf 'Skill frontmatter is valid in %s files.\n' "$#"
    exit 0
fi

printf 'Skill frontmatter is not valid YAML:\n\n%s\n\n' "$report" >&2
printf 'A skill whose frontmatter does not parse loses its description:\n' >&2
printf 'Skillshare and Claude Code fall back to the H1 heading, so the model\n' >&2
printf 'no longer sees when to invoke the skill. Fix the source under %s,\n' "$SKILLS_ROOT" >&2
printf 'then re-sync and re-run the check:\n\n' >&2
printf '  skillshare sync --all -p\n' >&2
printf '  just check-agent-tools\n' >&2
exit 1
