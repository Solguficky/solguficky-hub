#!/usr/bin/env sh
# Verify committed Skillshare targets against their repository sources.
#
# Skillshare 0.20.x does not track native agents copied to a target in a
# manifest, so `skillshare diff` reports every copied agent as a local override.
# This check compares the actual files and verifies the Claude-only boundary.

set -eu

SOURCE_SKILLS='.skillshare/skills/proj'
SOURCE_AGENTS='.skillshare/agents'
SOURCE_COMMANDS='.skillshare/extras/commands'
UNIVERSAL_SKILLS='.agents/skills'
CLAUDE_SKILLS='.claude/skills'
CLAUDE_AGENTS='.claude/agents'
CLAUDE_COMMANDS='.claude/commands'
CLAUDE_ONLY='proj-delegate-subtask'

errors=''

fail() {
    errors="${errors}  - $1
"
}

compare_file() {
    source=$1
    target=$2
    label=$3

    if [ ! -f "$target" ]; then
        fail "${label}: missing target ${target}"
    elif ! diff "$source" "$target" >/dev/null 2>&1; then
        fail "${label}: ${source} and ${target} differ"
    fi
}

compare_tree() {
    source=$1
    target=$2
    label=$3

    if [ ! -d "$target" ]; then
        fail "${label}: missing target ${target}"
    elif ! diff -r "$source" "$target" >/dev/null 2>&1; then
        fail "${label}: ${source} and ${target} differ"
    fi
}

for source in "$SOURCE_SKILLS"/*; do
    [ -d "$source" ] || continue
    name=$(basename "$source")

    compare_tree "$source" "$CLAUDE_SKILLS/$name" "skill ${name} -> claude"

    if [ "$name" = "$CLAUDE_ONLY" ]; then
        if [ -e "$UNIVERSAL_SKILLS/$name" ]; then
            fail "skill ${name}: Claude-only skill exists in universal target"
        fi
    else
        compare_tree "$source" "$UNIVERSAL_SKILLS/$name" "skill ${name} -> universal"
    fi
done

# External Skillshare sources are ignored. Their committed target copies must
# still remain identical between Claude and the universal target.
for claude_skill in "$CLAUDE_SKILLS"/*; do
    [ -d "$claude_skill" ] || continue
    name=$(basename "$claude_skill")
    [ "$name" = "$CLAUDE_ONLY" ] && continue
    compare_tree "$claude_skill" "$UNIVERSAL_SKILLS/$name" "shared skill ${name}"
done

for universal_skill in "$UNIVERSAL_SKILLS"/*; do
    [ -d "$universal_skill" ] || continue
    name=$(basename "$universal_skill")
    if [ ! -d "$CLAUDE_SKILLS/$name" ]; then
        fail "shared skill ${name}: missing Claude target"
    fi
done

for source in "$SOURCE_AGENTS"/*.md; do
    [ -f "$source" ] || continue
    name=$(basename "$source")
    compare_file "$source" "$CLAUDE_AGENTS/$name" "agent ${name}"
done

for target in "$CLAUDE_AGENTS"/*.md; do
    [ -f "$target" ] || continue
    name=$(basename "$target")
    if [ ! -f "$SOURCE_AGENTS/$name" ]; then
        fail "agent ${name}: target has no source"
    fi
done

for source in "$SOURCE_COMMANDS"/*; do
    [ -f "$source" ] || continue
    name=$(basename "$source")
    compare_file "$source" "$CLAUDE_COMMANDS/$name" "command ${name}"
done

for target in "$CLAUDE_COMMANDS"/*; do
    [ -f "$target" ] || continue
    name=$(basename "$target")
    if [ ! -f "$SOURCE_COMMANDS/$name" ]; then
        fail "command ${name}: target has no source"
    fi
done

if [ -n "$errors" ]; then
    printf 'Agent tooling is not synchronized:\n\n%s' "$errors" >&2
    exit 1
fi

printf 'Agent tooling is synchronized.\n'
