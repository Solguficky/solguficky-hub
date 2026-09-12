#!/usr/bin/env sh
# Install the declared external skills and refuse to pass if the command
# rewrote the declaration itself.
#
# `skillshare install -p` reconciles .skillshare/ with its configuration, and it
# treats that configuration as its own working file: a source it cannot resolve
# is dropped from .skillshare/config.yaml, and .skillshare/skills/.metadata.json
# is rewritten alongside. Both files are in Git - they are the declaration of
# dependencies, not a copy of them (ADR-040) - so such an edit is a change to
# the repository that nothing announced. It was found once only because the
# author happened to run `git status` afterwards.
#
# The comparison goes through `git hash-object`, which applies the same filters
# Git applies on commit. A line ending that differs only in the working tree is
# therefore not reported: this check is about content, not about checkout style.

set -eu

CONFIG='.skillshare/config.yaml'
METADATA='.skillshare/skills/.metadata.json'

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

config_before=$(fingerprint "$CONFIG")
metadata_before=$(fingerprint "$METADATA")

skillshare install -p

changed=''
if [ "$(fingerprint "$CONFIG")" != "$config_before" ]; then
    changed="${changed}  - ${CONFIG}
"
fi
if [ "$(fingerprint "$METADATA")" != "$metadata_before" ]; then
    changed="${changed}  - ${METADATA}
"
fi

if [ -n "$changed" ]; then
    printf '\nskillshare install changed the dependency declaration:\n\n%s\n' "$changed" >&2
    printf 'Review the change before it becomes a commit:\n\n' >&2
    printf '  git diff -- %s %s\n\n' "$CONFIG" "$METADATA" >&2
    printf 'Keep it only if the removed or rewritten entry is meant to go.\n' >&2
    printf 'Otherwise restore the file and fix the source it could not resolve:\n\n' >&2
    printf '  git checkout -- %s %s\n' "$CONFIG" "$METADATA" >&2
    exit 1
fi

printf 'External skills installed; the declaration is unchanged.\n'
