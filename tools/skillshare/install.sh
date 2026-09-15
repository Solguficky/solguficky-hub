#!/usr/bin/env sh
# Install the declared external skills and refuse to pass if the command
# rewrote the declaration itself.
#
# `skillshare install -p` reconciles .skillshare/ with its configuration, and it
# treats that configuration as its own working file: a skill its security audit
# blocks is dropped from .skillshare/config.yaml, and its entry is cut out of
# .skillshare/skills/.metadata.json alongside. Both files are in Git - they are
# the declaration of dependencies, not a copy of them (ADR-041) - so such an
# edit is a change to the repository that nothing announced. It was found once
# only because the author happened to run `git status` afterwards.
#
# A source that simply fails to resolve is not this case: the run reports
# "failed to clone" and leaves the declaration alone. The silent edit comes from
# the audit verdict, which is why the exemption below is about the audit and not
# about reachability.
#
# The comparison goes through `git hash-object`, which applies the same filters
# Git applies on commit. A line ending that differs only in the working tree is
# therefore not reported: this check is about content, not about checkout style.

set -eu

CONFIG='.skillshare/config.yaml'
METADATA='.skillshare/skills/.metadata.json'
SKILLS='.skillshare/skills'

# Some declared skills cannot be bulk-installed because Skillshare's audit finds
# false-positive output-suppression directives in Microsoft reference files.
# CRITICAL is already the most permissive block threshold, so there is nothing
# to loosen, and `--exclude` does not apply to this mode - it needs a source
# argument.
#
# Installing it by name with --force puts it on disk first. The bulk run that
# follows then reports it as "already exists" and leaves the declaration alone:
# `install -p` rewrites the declaration only for a source it tries to resolve.
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

# The guard below compares before and after, so it sees only what this run
# changed. A declaration an earlier run already stripped looks unchanged to it
# forever, and the skill it named would quietly stop being a dependency. So the
# state is asserted once, up front, against the declaration itself.
for audit_exempt in $AUDIT_EXEMPTS; do
    if ! grep -Fq "name: ${audit_exempt}" "$CONFIG"; then
        printf '%s is not declared in %s any more.\n\n' "$audit_exempt" "$CONFIG" >&2
        printf 'An earlier install most likely dropped it on its audit verdict.\n' >&2
        printf 'Restore the declaration, or remove this exemption from %s.\n' "$0" >&2
        exit 1
    fi
done

config_before=$(fingerprint "$CONFIG")
metadata_before=$(fingerprint "$METADATA")

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

config_exempt=$(fingerprint "$CONFIG")
metadata_exempt=$(fingerprint "$METADATA")

# Without `|| status=$?` a non-zero exit would end the script here under `set -e`
# and skip the guard entirely - losing exactly the case the guard is for, where
# one source fails to resolve and the audit strips another in the same run.
bulk_status=0
skillshare install -p || bulk_status=$?

changed=''
if [ "$(fingerprint "$CONFIG")" != "$config_exempt" ]; then
    changed="${changed}  - ${CONFIG}
"
fi
if [ "$(fingerprint "$METADATA")" != "$metadata_exempt" ]; then
    changed="${changed}  - ${METADATA}
"
fi

if [ -n "$changed" ]; then
    printf '\nskillshare install changed the dependency declaration:\n\n%s\n' "$changed" >&2
    printf 'Review the change before it becomes a commit:\n\n' >&2
    printf '  git diff -- %s %s\n\n' "$CONFIG" "$METADATA" >&2
    printf 'Keep it only if the removed or rewritten entry is meant to go.\n' >&2
    printf 'Otherwise restore the file and decide what to do with the skill\n' >&2
    printf 'the audit rejected:\n\n' >&2
    printf '  git checkout -- %s %s\n' "$CONFIG" "$METADATA" >&2
    exit 1
fi

if [ "$bulk_status" -ne 0 ]; then
    printf '\nskillshare install exited %s; the declaration survived it.\n' "$bulk_status" >&2
    exit "$bulk_status"
fi

# The named installs above record a fresh `version` for skills they reinstall,
# and that is the point of running them. Only .metadata.json may move that way:
# config.yaml is the list of dependencies, and nothing in this script has a
# reason to rewrite it.
if [ "$config_exempt" != "$config_before" ]; then
    printf '\nInstalling audit-exempt skills rewrote %s, which they have no reason to touch:\n\n' "$CONFIG" >&2
    printf '  git diff -- %s\n' "$CONFIG" >&2
    exit 1
fi

if [ "$metadata_exempt" != "$metadata_before" ]; then
    printf '\nInstalling audit-exempt skills refreshed the declaration they record.\n'
    printf 'Review and commit it - the `version` field is what pins the skill text:\n\n'
    printf '  git diff -- %s\n' "$METADATA"
    exit 0
fi

printf 'External skills installed; the declaration is unchanged.\n'
