#!/usr/bin/env sh
# Verify every external image a Containerfile pulls is pinned by digest.
#
# RFC-010 makes the digest, not the tag, the identity of an image: a tag can be
# moved to other content without a single change here. The .NET images get the
# same guarantee from SOLG0001 in shared/dotnet/Container.targets; a
# Containerfile has no build system to hook, so this check runs before the
# build and prints its own code, SOLG-IMG-TAG, for the negative test to match.
#
# An external reference is the image of a FROM or of a COPY --from that is not
# an earlier stage name or index. It passes only as `image@sha256:<64 hex>`.
# Instructions split over continuation lines are not parsed; none are used.
#
# Usage: check-containerfile.sh <Containerfile>

set -eu

file=${1:?usage: check-containerfile.sh <Containerfile>}
[ -f "$file" ] || { echo "SOLG-IMG-TAG: no such file: $file" >&2; exit 2; }

awk '
    function pinned(ref) { return ref ~ /@sha256:[0-9a-f]{64}$/ }
    function known(ref) { return (tolower(ref) in stages) || ref ~ /^[0-9]+$/ }
    function reject(ref) {
        printf "SOLG-IMG-TAG: %s:%d: %s is not pinned by digest (image@sha256:...)\n", FILENAME, FNR, ref
        bad = 1
    }
    toupper($1) == "FROM" {
        i = 2
        while ($i ~ /^--/) i++
        ref = $i
        if (!known(ref) && !pinned(ref)) reject(ref)
        if (toupper($(i + 1)) == "AS") stages[tolower($(i + 2))] = 1
        next
    }
    toupper($1) == "COPY" {
        for (i = 2; i <= NF && $i ~ /^--/; i++) {
            if ($i ~ /^--from=/) {
                ref = substr($i, 8)
                if (!known(ref) && !pinned(ref)) reject(ref)
            }
        }
    }
    END { exit bad }
' "$file" >&2 || exit 1

echo "Every external image in $file is pinned by digest."
