#!/usr/bin/env sh
# Install the declared external skills and refuse to pass if the command
# rewrote the declaration itself.
#
# `skillshare install -p` reconciles .skillshare/ with its configuration, and it
# treats that configuration as its own working file: a skill its security audit
# blocks is dropped from .skillshare/config.yaml, and its entry is cut out of
# .skillshare/skills/.metadata.json alongside. Both files are in Git - they are
# the declaration of dependencies, not a copy of them (ADR-040) - so such an
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

# One declared skill the bulk install cannot resolve on its own. Skillshare's
# audit blocks it at CRITICAL on a false positive: the analyzer reads
# "do not tell the user the project has a permanent build failure" in Microsoft's
# own references/safety-guardrails.md as an output suppression directive, while
# the line instructs the agent not to lie about a file lock. CRITICAL is already
# the most permissive block threshold, so there is nothing to loosen, and
# `--exclude` does not apply to this mode - it needs a source argument.
#
# Installing it by name with --force puts it on disk first. The bulk run that
# follows then reports it as "already exists" and leaves the declaration alone:
# `install -p` rewrites the declaration only for a source it tries to resolve.
#
# Drop this block once the analyzer stops matching that line; the skill itself
# carries no finding this repository accepts as real.
AUDIT_EXEMPT='aspire-orchestration'

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

config_start=$(fingerprint "$CONFIG")
metadata_start=$(fingerprint "$METADATA")

if [ ! -d "$SKILLS/$AUDIT_EXEMPT" ]; then
    printf 'Installing %s by name: its audit finding is reviewed and rejected.\n\n' "$AUDIT_EXEMPT"
    skillshare install "$AUDIT_EXEMPT" --force -p
    printf '\n'
fi

config_exempt=$(fingerprint "$CONFIG")
metadata_exempt=$(fingerprint "$METADATA")

skillshare install -p

# Only the bulk run is held to the guard. The named install above announces
# itself, and refreshing the `version` it records is the point of running it.
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

if [ "$config_exempt" != "$config_start" ] || [ "$metadata_exempt" != "$metadata_start" ]; then
    printf '\nInstalling %s refreshed the declaration it records.\n' "$AUDIT_EXEMPT"
    printf 'Review and commit it - the `version` field is what pins the skill text:\n\n'
    printf '  git diff -- %s %s\n' "$CONFIG" "$METADATA"
    exit 0
fi

printf 'External skills installed; the declaration is unchanged.\n'
