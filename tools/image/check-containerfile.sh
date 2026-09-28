#!/usr/bin/env sh
# Verify every external image a Containerfile pulls is pinned by digest.
#
# RFC-010 makes the digest, not the tag, the identity of an image: a tag can be
# moved to other content without a single change here. The .NET images get the
# same guarantee from SOLG0001 in shared/dotnet/Container.targets; a
# Containerfile has no build system to hook, so this check runs before the
# build and prints its own code, SOLG-IMG-TAG, for the negative test to match.
#
# An external reference is the image of a FROM, a COPY --from or a
# RUN --mount=...,from= that is not `scratch`, an earlier stage name or index.
# It passes only as `image@sha256:<64 hex>`. A file with no FROM at all is an
# error, not a pass. Instructions split over continuation lines are not parsed;
# none are used.
#
# The buf image carries a version that docs/standards/contracts/protobuf.md
# keeps in one place, BUF_VERSION in the root justfile. Its digest can only be
# written literally, so the Containerfile holds a copy, and a copy that differs
# from BUF_VERSION fails with SOLG-IMG-BUF: the justfile stays the source.
#
# Usage: check-containerfile.sh <Containerfile>

set -eu

file=${1:?usage: check-containerfile.sh <Containerfile>}
[ -f "$file" ] || { echo "SOLG-IMG-TAG: no such file: $file" >&2; exit 2; }

justfile="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)/justfile"
buf_version=$(sed -n 's/^BUF_VERSION := "\(.*\)"$/\1/p' "$justfile")
[ -n "$buf_version" ] || { echo "SOLG-IMG-BUF: no BUF_VERSION in $justfile" >&2; exit 2; }

# Digest length is counted, not matched with a {64} interval: older mawk has no
# intervals, and every reference would then be rejected as unpinned.
awk -v buf="$buf_version" '
    function pinned(ref,   at) {
        at = index(ref, "@sha256:")
        return at > 0 && length(ref) - at - 7 == 64 && substr(ref, at + 8) !~ /[^0-9a-f]/
    }
    function known(ref) { return ref == "scratch" || (tolower(ref) in stages) || ref ~ /^[0-9]+$/ }
    function check(ref,   version) {
        if (!known(ref) && !pinned(ref)) {
            printf "SOLG-IMG-TAG: %s:%d: %s is not pinned by digest (image@sha256:...)\n", FILENAME, FNR, ref
            bad = 1
        }
        if (ref ~ /(^|\/)bufbuild\/buf:/) {
            version = ref
            sub(/^.*bufbuild\/buf:/, "", version)
            sub(/@.*$/, "", version)
            if (version != buf) {
                printf "SOLG-IMG-BUF: %s:%d: buf %s differs from BUF_VERSION %s in justfile\n", FILENAME, FNR, version, buf
                bad = 1
            }
        }
    }
    toupper($1) == "FROM" {
        froms++
        i = 2
        while ($i ~ /^--/) i++
        check($i)
        if (toupper($(i + 1)) == "AS") stages[tolower($(i + 2))] = 1
        next
    }
    toupper($1) == "COPY" || toupper($1) == "RUN" {
        for (i = 2; i <= NF && $i ~ /^--/; i++) {
            if ($i ~ /^--from=/) check(substr($i, 8))
            if ($i ~ /^--mount=/ && match($i, /(^|,)from=[^,]+/)) {
                ref = substr($i, RSTART, RLENGTH)
                sub(/^,?from=/, "", ref)
                check(ref)
            }
        }
    }
    END {
        if (!froms) { printf "SOLG-IMG-TAG: %s has no FROM\n", FILENAME; bad = 1 }
        exit bad
    }
' "$file" >&2 || exit 1

echo "Every external image in $file is pinned by digest; buf matches BUF_VERSION $buf_version."
