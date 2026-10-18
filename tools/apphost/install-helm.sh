#!/usr/bin/env sh
# Installs the pinned helm for linux-amd64 into DEST (default $RUNNER_TEMP/helm)
# and prints the directory to add to PATH.
#
# Straight from the release, not through a third-party setup action: the same
# pattern as protoc in the nats-tester job. The checksum in the justfile makes
# the downloaded binary the pinned one, not merely one that runs. Used by the
# apphost job in ci.yml and by chart-publish.yml.

set -eu

root=$(git rev-parse --show-toplevel)
version=$(grep '^HELM_VERSION' "$root/justfile" | cut -d'"' -f2)
sha256=$(grep '^HELM_SHA256' "$root/justfile" | cut -d'"' -f2)
dest=${1:-${RUNNER_TEMP:?RUNNER_TEMP or a destination is required}/helm}

archive="$dest/helm.tar.gz"
mkdir -p "$dest"
curl -fsSL -o "$archive" "https://get.helm.sh/helm-v${version}-linux-amd64.tar.gz"
echo "$sha256  $archive" | sha256sum -c - >&2
tar -xzf "$archive" -C "$dest" --strip-components=1 linux-amd64/helm
rm "$archive"
"$dest/helm" version >&2
echo "$dest"
