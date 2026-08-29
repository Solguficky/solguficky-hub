#!/usr/bin/env sh
# Verify committed Skillshare targets against their repository sources.
#
# Skillshare 0.20.x does not track native agents copied to a target in a
# manifest, so `skillshare diff` reports every copied agent as a local override.
# This check compares the actual files.

set -eu

SOURCE_SKILLS='.skillshare/skills'
PROJECT_SKILLS="$SOURCE_SKILLS/proj"
TRACKED_SKILLS="$SOURCE_SKILLS/mattpocock/_skills/skills"
SKILLIGNORE="$SOURCE_SKILLS/.skillignore"
SOURCE_AGENTS='.skillshare/agents'
SOURCE_COMMANDS='.skillshare/extras/commands'
UNIVERSAL_SKILLS='.agents/skills'
CLAUDE_SKILLS='.claude/skills'
CLAUDE_AGENTS='.claude/agents'
CLAUDE_COMMANDS='.claude/commands'
errors=''

fail() {
    errors="${errors}  - $1
"
}

compare_file() {
    if [ ! -f "$2" ]; then
        fail "$3: missing target $2"
    elif ! diff "$1" "$2" >/dev/null 2>&1; then
        fail "$3: $1 and $2 differ"
    fi
}

compare_tree() {
    if [ ! -d "$2" ]; then
        fail "$3: missing target $2"
    elif ! git diff --no-index --ignore-cr-at-eol --exit-code -- "$1" "$2" >/dev/null 2>&1; then
        fail "$3: $1 and $2 differ"
    fi
}

compare_skill_targets() {
    source=$1
    name=$2
    label=$3

    compare_tree "$source" "$CLAUDE_SKILLS/$name" "${label} ${name} -> claude"
    compare_tree "$source" "$UNIVERSAL_SKILLS/$name" "${label} ${name} -> universal"
}

for source in "$PROJECT_SKILLS"/*; do
    [ -d "$source" ] || continue
    name=$(basename "$source")

    compare_skill_targets "$source" "$name" "skill"
done

# Installed external sources are not committed, but a local check must still
# catch a source edit that has not been synced to either target. The tracked
# mattpocock group is checked separately below because its sources are nested
# by category while its enabled targets are flat.
for source in "$SOURCE_SKILLS"/*; do
    [ -d "$source" ] || continue
    name=$(basename "$source")

    case "$name" in
        proj|mattpocock)
            continue
            ;;
    esac

    if [ -f "$SKILLIGNORE" ] && grep -Fxq "$name" "$SKILLIGNORE"; then
        continue
    fi

    compare_skill_targets "$source" "$name" "external skill"
done

# The tracked repository groups skills by category, while target_naming=standard
# flattens enabled skills into the target root.
for source in "$TRACKED_SKILLS"/*/*; do
    [ -d "$source" ] || continue
    name=$(basename "$source")

    if [ -f "$SKILLIGNORE" ] && grep -Fxq "$name" "$SKILLIGNORE"; then
        continue
    fi

    compare_skill_targets "$source" "$name" "tracked skill"
done

# Committed target copies must also remain identical when external sources are
# absent, as they are in a fresh checkout used by CI.
for claude_skill in "$CLAUDE_SKILLS"/*; do
    [ -d "$claude_skill" ] || continue
    name=$(basename "$claude_skill")
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
