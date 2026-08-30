#!/usr/bin/env sh
# Verify committed Skillshare targets against their repository sources.
#
# Skillshare 0.20.x does not track native agents copied to a target in a
# manifest, so `skillshare diff` reports every copied agent as a local override.
# This check compares the actual files.

set -eu

SKILLS_ROOT='.skillshare/skills'
PROJECT_SKILLS="$SKILLS_ROOT/proj"
TRACKED_SKILLS="$SKILLS_ROOT/mattpocock/_skills/skills"
SKILLIGNORE="$SKILLS_ROOT/.skillignore"
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

# A target is a copy of its source, so both comparisons allow exactly one
# difference: the line ending Git may have used on checkout.
compare_file() {
    source=$1
    target=$2
    label=$3

    if [ ! -f "$target" ]; then
        fail "${label}: missing target ${target}"
    elif ! git diff --no-index --ignore-cr-at-eol --exit-code -- "$source" "$target" >/dev/null 2>&1; then
        fail "${label}: ${source} and ${target} differ"
    fi
}

compare_tree() {
    source=$1
    target=$2
    label=$3

    if [ ! -d "$target" ]; then
        fail "${label}: missing target ${target}"
    elif ! git diff --no-index --ignore-cr-at-eol --exit-code -- "$source" "$target" >/dev/null 2>&1; then
        fail "${label}: ${source} and ${target} differ"
    fi
}

# sh has no local variables, so the parameters carry a prefix: compare_tree
# below assigns source, target and label of its own.
compare_skill_targets() {
    skill_source=$1
    skill_name=$2
    skill_label=$3

    compare_tree "$skill_source" "$CLAUDE_SKILLS/$skill_name" "${skill_label} ${skill_name} -> claude"
    compare_tree "$skill_source" "$UNIVERSAL_SKILLS/$skill_name" "${skill_label} ${skill_name} -> universal"
}

is_ignored() {
    [ -f "$SKILLIGNORE" ] && grep -Fxq "$1" "$SKILLIGNORE"
}

for skill_dir in "$PROJECT_SKILLS"/*; do
    [ -d "$skill_dir" ] || continue
    name=$(basename "$skill_dir")

    compare_skill_targets "$skill_dir" "$name" "skill"
done

# Installed external sources are not committed, so these two loops find nothing
# in CI and run only locally: they catch a source edit that has not been synced
# to either target before it is pushed. The tracked mattpocock group is checked
# separately because its sources are nested by category while its enabled
# targets are flat.
for skill_dir in "$SKILLS_ROOT"/*; do
    [ -d "$skill_dir" ] || continue
    name=$(basename "$skill_dir")

    case "$name" in
        proj|mattpocock)
            continue
            ;;
    esac

    if is_ignored "$name"; then
        continue
    fi

    compare_skill_targets "$skill_dir" "$name" "external skill"
done

for skill_dir in "$TRACKED_SKILLS"/*/*; do
    [ -d "$skill_dir" ] || continue
    name=$(basename "$skill_dir")

    if is_ignored "$name"; then
        continue
    fi

    compare_skill_targets "$skill_dir" "$name" "tracked skill"
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

for agent_source in "$SOURCE_AGENTS"/*.md; do
    [ -f "$agent_source" ] || continue
    name=$(basename "$agent_source")
    compare_file "$agent_source" "$CLAUDE_AGENTS/$name" "agent ${name}"
done

for agent_target in "$CLAUDE_AGENTS"/*.md; do
    [ -f "$agent_target" ] || continue
    name=$(basename "$agent_target")
    if [ ! -f "$SOURCE_AGENTS/$name" ]; then
        fail "agent ${name}: target has no source"
    fi
done

for command_source in "$SOURCE_COMMANDS"/*; do
    [ -f "$command_source" ] || continue
    name=$(basename "$command_source")
    compare_file "$command_source" "$CLAUDE_COMMANDS/$name" "command ${name}"
done

for command_target in "$CLAUDE_COMMANDS"/*; do
    [ -f "$command_target" ] || continue
    name=$(basename "$command_target")
    if [ ! -f "$SOURCE_COMMANDS/$name" ]; then
        fail "command ${name}: target has no source"
    fi
done

if [ -n "$errors" ]; then
    printf 'Agent tooling is not synchronized:\n\n%s\n' "$errors" >&2
    printf 'Sync the targets from .skillshare/ and re-run the check:\n\n' >&2
    printf '  skillshare sync -p          # skills and agents\n' >&2
    printf '  skillshare sync extras -p   # commands\n' >&2
    printf '  just check-agent-tools\n' >&2
    exit 1
fi

printf 'Agent tooling is synchronized.\n'
