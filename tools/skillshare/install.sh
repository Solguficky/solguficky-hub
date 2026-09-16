#!/usr/bin/env sh
# Install the declared external skills and refuse to pass if the run left the
# declaration with a different set of skills than it started with.
#
# `skillshare install` treats .skillshare/config.yaml as its own working
# file, not just a spec to read from: on a completely empty
# .skillshare/skills/ - every fresh worktree starts this way, the directory
# is gitignored per ADR-041 - it can drop declared entries. Confirmed by
# reinstalling from scratch: bulk `install -p` against an empty directory
# dropped most of the declaration in skillshare 0.20.25, upstream-fixed for
# successfully-installed entries in 0.20.29 (changelog names this exact
# symptom, issue #280). Entries that hit a CRITICAL audit block are a
# separate case that release does not cover: bulk still drops those from the
# declaration on 0.20.29, which is why the two audit-exempt skills below get
# reinstalled by name afterward - that step restores exactly the entries
# bulk just dropped. Bulk runs first, before those named installs, because
# doing it in the opposite order let a single named install drop an
# unrelated declared entry too, on the same empty-directory test - a smaller
# but still real instance of the same bug. Neither order eliminates it,
# which is why the check below looks at the net result of the whole run
# rather than trusting either step alone.
#
# A source that simply fails to resolve is not this case: the run reports
# "failed to clone" and leaves the declaration alone.
#
# The metadata comparison goes through `git hash-object`, which applies the
# same filters Git applies on commit. A line ending that differs only in the
# working tree is therefore not reported: this check is about content, not
# about checkout style.

set -eu

CONFIG='.skillshare/config.yaml'
METADATA='.skillshare/skills/.metadata.json'
SKILLS='.skillshare/skills'

# Some declared skills cannot be bulk-installed because Skillshare's audit finds
# false-positive output-suppression directives in Microsoft reference files.
# CRITICAL is already the most permissive block threshold, so there is nothing
# to loosen, and `--exclude` does not apply to this mode - it needs a source
# argument. Bulk reports each as audit-blocked and drops it from the
# declaration (see above); installing it by name with --force is what
# actually puts it on disk and restores the entry.
#
# Drop this block once the analyzer stops matching that line; the skill itself
# carries no finding this repository accepts as real.
AUDIT_EXEMPTS='aspire-orchestration aspire-deployment'

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

# Names declared under the top-level `skills:` list, one per line, sorted.
# Deliberately scoped to that list alone: it ignores `targets:` and `extras:`,
# so an unrelated edit there (a new sync target, say) never trips this check.
# CRLF is stripped so a Windows checkout compares the same as a Unix one.
skill_names() {
    awk '
        /^skills:/ { insection = 1; next }
        /^[^[:space:]]/ { insection = 0 }
        insection && /^  - name: / { print $3 }
    ' "$CONFIG" | tr -d '\r' | sort
}

# The guard at the end compares before and after, so it sees only whether
# this run changed the set of declared skills - not whether an earlier run
# already had. So that state is asserted once, up front, against the
# declaration itself.
for audit_exempt in $AUDIT_EXEMPTS; do
    if ! grep -Fq "name: ${audit_exempt}" "$CONFIG"; then
        printf '%s is not declared in %s any more.\n\n' "$audit_exempt" "$CONFIG" >&2
        printf 'An earlier install most likely dropped it on its audit verdict.\n' >&2
        printf 'Restore the declaration, or remove this exemption from %s.\n' "$0" >&2
        exit 1
    fi
done

names_before=$(skill_names)
metadata_before=$(fingerprint "$METADATA")

# Without `|| status=$?` a non-zero exit would end the script here under `set -e`
# and skip the guard entirely - losing exactly the case the guard is for, where
# bulk touches the declaration on its way to reporting an audit block.
bulk_status=0
skillshare install -p || bulk_status=$?

for audit_exempt in $AUDIT_EXEMPTS; do
    if [ ! -d "$SKILLS/$audit_exempt" ]; then
        printf 'Installing %s by name: its audit finding is reviewed and rejected.\n\n' "$audit_exempt"
        exempt_status=0
        skillshare install "github.com/microsoft/aspire-skills/skills/$audit_exempt" --force -p || exempt_status=$?
        if [ "$exempt_status" -ne 0 ]; then
            printf '\nskillshare install %s exited %s.\n' "$audit_exempt" "$exempt_status" >&2
            exit "$exempt_status"
        fi
        printf '\n'
    fi
done

names_after=$(skill_names)

if [ "$names_after" != "$names_before" ]; then
    tmp_before=$(mktemp)
    tmp_after=$(mktemp)
    printf '%s\n' "$names_before" >"$tmp_before"
    printf '%s\n' "$names_after" >"$tmp_after"
    printf '\nskillshare install changed the set of declared skills:\n\n' >&2
    printf '  dropped: %s\n' "$(comm -23 "$tmp_before" "$tmp_after" | tr '\n' ' ')" >&2
    printf '  added:   %s\n\n' "$(comm -13 "$tmp_before" "$tmp_after" | tr '\n' ' ')" >&2
    rm -f "$tmp_before" "$tmp_after"
    printf 'Review the change before it becomes a commit:\n\n' >&2
    printf '  git diff -- %s %s\n\n' "$CONFIG" "$METADATA" >&2
    printf 'Restore it and retry, or decide what to do with the skill that was dropped:\n\n' >&2
    printf '  git checkout -- %s %s\n' "$CONFIG" "$METADATA" >&2
    exit 1
fi

if [ "$bulk_status" -ne 0 ]; then
    printf '\nskillshare install exited %s; the declaration survived it.\n' "$bulk_status" >&2
    exit "$bulk_status"
fi

# The named installs above record a fresh `version` for skills they reinstall,
# and that is the point of running them.
if [ "$(fingerprint "$METADATA")" != "$metadata_before" ]; then
    printf 'External skills installed; %s refreshed the version it records.\n' "$METADATA"
    printf 'Review and commit it - the `version` field is what pins the skill text:\n\n'
    printf '  git diff -- %s\n' "$METADATA"
    exit 0
fi

printf 'External skills installed; the declaration is unchanged.\n'
