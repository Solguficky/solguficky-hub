#!/usr/bin/env sh
# Verify committed Skillshare targets against their repository sources.
#
# Skillshare 0.20.x does not track native agents copied to a target in a
# manifest, so `skillshare diff` reports every copied agent as a local override.
# This check compares the actual files.

set -eu

SKILLS_ROOT='.skillshare/skills'
PROJECT_SKILLS="$SKILLS_ROOT/proj"
GOLANG_SKILLS="$SKILLS_ROOT/golang/_golang/skills"
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

# Copy mode records every skill it owns in the target manifest, and that manifest
# is committed like the copies themselves. A skill whose frontmatter does not
# parse is dropped from it silently: that is how proj-test-fsharp,
# proj-write-fsharp and proj-write-fsharp-vsa disappeared from both manifests
# while their sources and targets stayed in place. Nothing above reads the
# manifest, so the loss survived every gate.
#
# Only one direction is checked. An entry without a directory is normal: the Go
# pack is managed but deliberately absent from Git. The check is also coarse by
# design - it asks whether the manifest mentions the skill at all, not in which
# section, because a plain grep keeps the script free of a JSON parser.
check_manifest_entries() {
    manifest_target=$1
    manifest="$manifest_target/.skillshare-manifest.json"

    if [ ! -f "$manifest" ]; then
        fail "manifest: missing ${manifest}"
        return
    fi

    for manifest_skill in "$manifest_target"/*; do
        [ -d "$manifest_skill" ] || continue
        manifest_name=$(basename "$manifest_skill")

        if ! grep -Fq "\"${manifest_name}\":" "$manifest"; then
            fail "manifest ${manifest}: ${manifest_name} has no entry"
        fi
    done
}

for skill_dir in "$PROJECT_SKILLS"/*; do
    [ -d "$skill_dir" ] || continue
    name=$(basename "$skill_dir")

    compare_skill_targets "$skill_dir" "$name" "skill"
done

# Installed external sources are not committed, so the loops below find nothing
# in CI and run only locally: they catch a source edit that has not been synced
# to either target before it is pushed. Tracked clones are checked separately
# because their sources are nested inside the clone while the enabled targets
# stay flat.
for skill_dir in "$SKILLS_ROOT"/*; do
    [ -d "$skill_dir" ] || continue
    name=$(basename "$skill_dir")

    case "$name" in
        proj|mattpocock|golang)
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

# Пак Go — тоже tracked-клон, но его скиллы лежат в repo/skills плоско, без
# категорий, поэтому у него свой цикл с одной звёздочкой.
for skill_dir in "$GOLANG_SKILLS"/*; do
    [ -d "$skill_dir" ] || continue
    name=$(basename "$skill_dir")

    if is_ignored "$name"; then
        continue
    fi

    compare_skill_targets "$skill_dir" "$name" "golang skill"
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

check_manifest_entries "$CLAUDE_SKILLS"
check_manifest_entries "$UNIVERSAL_SKILLS"

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
