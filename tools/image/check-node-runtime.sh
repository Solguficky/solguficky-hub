#!/usr/bin/env sh
# Verify a Node image ships the built code and production dependencies only.
#
# Reads the final filesystem of the image, not its layers: what matters here is
# what the container sees. Fails with SOLG-IMG-DEVDEPS when under <app dir>
#   - node_modules holds a package that <package-lock.json> marks `"dev": true`;
#   - a TypeScript source (*.ts other than *.d.ts, *.mts, *.cts) or a
#     tsconfig*.json is present outside node_modules.
#
# The lockfile, not the devDependencies list, is the source: npm marks there
# every package only development needs, transitive ones included, and a name
# from devDependencies may still be a production dependency of another package
# (protobufjs depends on @types/node) and then legitimately ships. Packages
# bring their own .ts files, so node_modules is exempt from the second rule; the
# node runtime of the base image lives outside <app dir> and is not looked at.
#
# Usage: check-node-runtime.sh <image> <package-lock.json> <app dir>.
# IMAGE_ENGINE picks podman (default) or docker; node reads the lockfile.

set -eu

usage='usage: check-node-runtime.sh <image> <package-lock.json> <app dir>'
image=${1:?$usage}
lock=${2:?$usage}
app=${3:?$usage}
app=${app#/}
app=${app%/}
engine=${IMAGE_ENGINE:-podman}

work=$(mktemp -d)
container=
trap '[ -z "$container" ] || "$engine" rm -f "$container" >/dev/null 2>&1; rm -rf "$work"' EXIT

# Lockfile first: a lockfile without dev marks would make the check vacuous.
node -e '
    const lock = require(process.argv[1]);
    if (lock.lockfileVersion < 2) throw new Error("lockfileVersion 2+ required");
    for (const [path, entry] of Object.entries(lock.packages))
        if (entry.dev) console.log(path);
' "$(cd "$(dirname "$lock")" && pwd)/$(basename "$lock")" >"$work/dev"
[ -s "$work/dev" ] || { echo "SOLG-IMG-DEVDEPS: $lock marks no package as dev" >&2; exit 2; }

container=$("$engine" create "$image")
# stdout rather than -o: docker on Windows reads -o as a Windows path.
"$engine" export "$container" >"$work/fs.tar"
tar -tf "$work/fs.tar" | sed 's|^\./||' >"$work/entries"
grep -q "^$app/node_modules/" "$work/entries" || { echo "SOLG-IMG-DEVDEPS: $image has no /$app/node_modules" >&2; exit 2; }

bad=0
while IFS= read -r path; do
    # Prefix match, literal: a lockfile path is not a regex, and a substring
    # match would take a/node_modules/x for a hoisted node_modules/x.
    if awk -v p="$app/$path/" 'index($0, p) == 1 { found = 1; exit } END { exit !found }' "$work/entries"; then
        echo "SOLG-IMG-DEVDEPS: dev-only package /$app/$path is in the image" >&2
        bad=1
    fi
done <"$work/dev"

sources=$(grep "^$app/" "$work/entries" | grep -v "^$app/node_modules/" \
    | grep -E '(\.[mc]?ts$|/tsconfig[^/]*\.json$)' | grep -vE '\.d\.[mc]?ts$' || true)
if [ -n "$sources" ]; then
    echo "SOLG-IMG-DEVDEPS: TypeScript sources in /$app:" >&2
    echo "$sources" >&2
    bad=1
fi

[ "$bad" -eq 0 ] || exit 1
echo "/$app of $image holds no dev-only package and no TypeScript sources."
