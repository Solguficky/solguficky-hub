#!/usr/bin/env sh
# Verify the Meetups contracts project holds no handwritten code.
#
# ADR-025 keeps the C# contracts project generated-only, and that rule is the
# condition of its reversibility: while nothing is written by hand there, moving
# to another generator is replacing one project, not a migration. Grpc.Tools
# writes the generated C# into obj/, so under version control the project is
# exactly its .csproj and nothing else.
#
# The gate reads Git, not the working tree: an untracked scratch file is the
# author's business, a committed one is the defect this check exists for.

set -eu

# `git ls-files` resolves a pathspec against the current directory, so the same
# check silently found nothing when run from anywhere but the repository root.
# A gate that cannot fail is worse than no gate, hence the explicit anchor.
root=$(git rev-parse --show-toplevel)
cd "$root"

PROJECT='apps/meetups/Meetups.Contracts'
ALLOWED="$PROJECT/Meetups.Contracts.csproj"

# Kept separate from the filter below: piping straight into grep would hide a
# failing `git` as an empty result, and the gate would report success for
# "could not look" the same way it reports it for "nothing found".
tracked=$(git ls-files -- "$PROJECT")

if [ -z "$tracked" ]; then
    echo "No tracked files under $PROJECT: the project itself is missing." >&2
    exit 1
fi

unexpected=$(printf '%s\n' "$tracked" | grep -v -x -F "$ALLOWED" || true)

if [ -n "$unexpected" ]; then
    echo "Handwritten files in the generated-only contracts project (ADR-025):" >&2
    printf '%s\n' "$unexpected" | sed 's/^/  - /' >&2
    echo "Mapping generated types to domain types lives in F#, on the service boundary." >&2
    exit 1
fi
