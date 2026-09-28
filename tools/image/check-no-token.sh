#!/usr/bin/env sh
# Fail when a Telegram Bot API token is found anywhere in a built image.
#
# Tokens are issued to the running container by the environment it runs in;
# the image carries neither the test nor the production one (PER-238). A token
# can reach an image two ways, and both are searched:
#
#   - a layer. Every layer is scanned on its own, not the final filesystem: a
#     file deleted by a later layer is still shipped in the earlier one;
#   - a build argument. Its value is not a file, but every RUN in its scope
#     records it in the image history (`|1 NAME=value ...`), and the history
#     lives in the image config.
#
# `<engine> save` writes the layers and the config as files of one archive, so
# one pass over every file of it covers both. Layers compressed with gzip are
# decompressed first; everything else is searched as bytes.
#
# The pattern is the Bot API token format, `<bot id>:<35 chars>`. Other kinds
# of secrets are out of scope. A hit prints SOLG-IMG-TOKEN, the code the
# negative test matches; the token itself is never printed.
#
# Usage: check-no-token.sh <image>. IMAGE_ENGINE picks podman (default) or docker.

set -eu

image=${1:?usage: check-no-token.sh <image>}
engine=${IMAGE_ENGINE:-podman}
pattern='[0-9]{8,10}:[A-Za-z0-9_-]{35}'

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# stdout rather than -o: docker on Windows reads -o as a Windows path.
"$engine" save "$image" >"$work/image.tar"
mkdir "$work/image"
tar -xf "$work/image.tar" -C "$work/image"

# A failing find would look like "no files, no token"; a count of zero files
# is therefore an error of its own, not a pass.
files=$(find "$work/image" -type f | wc -l)
[ "$files" -gt 0 ] || { echo "SOLG-IMG-TOKEN: $engine save produced no files for $image" >&2; exit 2; }

found=0
for blob in $(find "$work/image" -type f); do
    if gzip -t "$blob" 2>/dev/null; then
        hit=$(gzip -dc "$blob" | grep -caE "$pattern" || true)
    else
        hit=$(grep -caE "$pattern" "$blob" || true)
    fi
    if [ "$hit" -gt 0 ]; then
        echo "SOLG-IMG-TOKEN: a Bot API token is in ${blob#"$work/image/"} of $image" >&2
        found=1
    fi
done

[ "$found" -eq 0 ] || exit 1
echo "No Bot API token in $files files of $image."
