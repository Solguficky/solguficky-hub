#!/usr/bin/env sh
# Installs the pinned just for linux x86_64 into DEST (default $RUNNER_TEMP/just)
# and prints the directory to add to PATH.
#
# Straight from the release, not through extractions/setup-just: that action
# looks the release up through the GitHub releases API and fails every job with
# "no release for just matching version specifier" when the lookup comes back
# empty. The same pattern as tools/apphost/install-helm.sh: the checksum in the
# justfile makes the downloaded binary the pinned one, not merely one that runs.
# Used by ci.yml and chart-publish.yml.

set -eu

root=$(git rev-parse --show-toplevel)
version=$(grep '^JUST_VERSION' "$root/justfile" | cut -d'"' -f2)
sha256=$(grep '^JUST_SHA256' "$root/justfile" | cut -d'"' -f2)
dest=${1:-${RUNNER_TEMP:?RUNNER_TEMP or a destination is required}/just}

archive="$dest/just.tar.gz"
mkdir -p "$dest"
curl -fsSL -o "$archive" \
  "https://github.com/casey/just/releases/download/${version}/just-${version}-x86_64-unknown-linux-musl.tar.gz"
echo "$sha256  $archive" | sha256sum -c - >&2
tar -xzf "$archive" -C "$dest" just
rm "$archive"
"$dest/just" --version >&2
echo "$dest"
