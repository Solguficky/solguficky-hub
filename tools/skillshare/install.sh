#!/usr/bin/env sh
# Install the declared external skills and refuse to pass if the run left the
# declaration with a different set of skills than it started with, or left a
# declared skill missing from disk.
#
# The declaration is .skillshare/config.yaml (which skills), the lockfile
# .skillshare/skills.lock.json (the exact commit each one resolves to) and
# .skillshare/skills/.metadata.json (install records and audit findings the
# repository accepted). `skillshare install -p` installs the locked commits,
# so a fresh checkout gets the same skill text as the commit that wrote the
# lock, not whatever upstream is at now.
#
# `skillshare install` treats config.yaml as its own working file, not just a
# spec to read from: older releases dropped declared entries on an empty
# .skillshare/skills/ (every fresh worktree starts this way, the directory is
# gitignored per ADR-041), and a skill that is tracked in Git but missing from
# config.yaml gets appended to it. Hence the before/after comparison of the
# declared set below.
#
# Since 0.21 a skill that fails to copy is reported with a cross but does not
# change the exit code: a directory symlink that points outside the skill
# (microsoft/aspire-skills `evals/fixtures`) fails that way. That is why the
# check below looks at the disk, not at the exit code. The aspire skills are
# installed as a tracked clone of the whole repository for the same reason:
# the clone keeps the symlink inside the tree it points into.
#
# Audit findings that were reviewed and rejected live in `audit_accepted` of
# .metadata.json: installing with --force once records them, and later bulk
# installs do not block on them. A new finding still blocks.
#
# The metadata comparison goes through `git hash-object`, which applies the
# same filters Git applies on commit. A line ending that differs only in the
# working tree is therefore not reported: this check is about content, not
# about checkout style.

set -eu

CONFIG='.skillshare/config.yaml'
METADATA='.skillshare/skills/.metadata.json'
LOCK='.skillshare/skills.lock.json'
SKILLS='.skillshare/skills'

if ! command -v skillshare >/dev/null 2>&1; then
    printf 'skillshare not found in PATH; see AGENTS.md for the setup.\n' >&2
    exit 1
fi

fingerprint() {
    if [ -f "$1" ]; then
        git hash-object -- "$1"
    else
        printf 'absent\n'
    fi
}

# Declared skills under the top-level `skills:` list, one per line, sorted, as
# the path each one installs to: `group/name` when the entry has a group,
# `name` otherwise. Deliberately scoped to that list alone: it ignores
# `targets:`, so an unrelated edit there never trips this check. CRLF is
# stripped so a Windows checkout compares the same as a Unix one.
skill_paths() {
    tr -d '\r' < "$CONFIG" | awk '
        function flush() { if (name != "") print (group != "" ? group "/" : "") name; name = ""; group = "" }
        /^skills:/ { insection = 1; next }
        /^[^[:space:]]/ { if (insection) flush(); insection = 0 }
        insection && /^  - name: / { flush(); name = $3; next }
        insection && /^    group: / { group = $2 }
        END { if (insection) flush() }
    ' | sort
}

paths_before=$(skill_paths)
metadata_before=$(fingerprint "$METADATA")
lock_before=$(fingerprint "$LOCK")

# Without `|| status=$?` a non-zero exit would end the script here under `set -e`
# and skip the guards entirely.
bulk_status=0
skillshare install -p || bulk_status=$?

paths_after=$(skill_paths)

if [ "$paths_after" != "$paths_before" ]; then
    tmp_before=$(mktemp)
    tmp_after=$(mktemp)
    printf '%s\n' "$paths_before" >"$tmp_before"
    printf '%s\n' "$paths_after" >"$tmp_after"
    printf '\nskillshare install changed the set of declared skills:\n\n' >&2
    printf '  dropped: %s\n' "$(comm -23 "$tmp_before" "$tmp_after" | tr '\n' ' ')" >&2
    printf '  added:   %s\n\n' "$(comm -13 "$tmp_before" "$tmp_after" | tr '\n' ' ')" >&2
    rm -f "$tmp_before" "$tmp_after"
    printf 'Review the change before it becomes a commit:\n\n' >&2
    printf '  git diff -- %s %s %s\n\n' "$CONFIG" "$METADATA" "$LOCK" >&2
    printf 'Restore it and retry, or decide what to do with the skill that was dropped:\n\n' >&2
    printf '  git checkout -- %s %s %s\n' "$CONFIG" "$METADATA" "$LOCK" >&2
    exit 1
fi

missing=''
for path in $paths_after; do
    [ -d "$SKILLS/$path" ] || missing="$missing $path"
done
if [ -n "$missing" ]; then
    printf '\nDeclared but not installed:%s\n' "$missing" >&2
    printf 'skillshare exited %s; its output above names why each one failed.\n' "$bulk_status" >&2
    exit 1
fi

if [ "$bulk_status" -ne 0 ]; then
    printf '\nskillshare install exited %s; the declaration survived it.\n' "$bulk_status" >&2
    exit "$bulk_status"
fi

if [ "$(fingerprint "$LOCK")" != "$lock_before" ]; then
    printf 'External skills installed; the lockfile moved.\n'
    printf 'Review and commit it together with the metadata - the lockfile is what pins the skill text:\n\n'
    printf '  git diff -- %s %s\n' "$LOCK" "$METADATA"
    exit 0
fi

# With the same lock and the same set of skills, a changed metadata file is
# bookkeeping only: every install rewrites `installed_at` of every entry. Left
# in place it would make each fresh checkout dirty, so it is restored.
if [ "$(fingerprint "$METADATA")" != "$metadata_before" ] && [ "$metadata_before" != absent ]; then
    git checkout -- "$METADATA"
fi

printf 'External skills installed; the declaration is unchanged.\n'
