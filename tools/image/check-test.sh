#!/usr/bin/env sh
# Negative path of the image checks: each must fail on the defect it exists for,
# and fail with its own code. A non-zero exit alone proves nothing: the check
# might have failed for an unrelated reason and would then pass real defects.
#
#   - check-containerfile.sh on a base pinned by tag must print SOLG-IMG-TAG,
#     and on a buf image other than BUF_VERSION must print SOLG-IMG-BUF;
#   - check-no-token.sh must print SOLG-IMG-TOKEN on two canary images: one
#     with a token in a layer that a later layer deletes, one with a token
#     passed only as a build argument.
#
# The canaries are built on the final base of the Containerfile under test: it
# is pinned, already pulled by the real build and has a shell. The token is
# generated per run and never committed, so push protection has nothing to
# block and nobody can mistake it for a real one.
#
# Usage: check-test.sh <Containerfile>. IMAGE_ENGINE picks podman or docker.

set -eu

containerfile=${1:?usage: check-test.sh <Containerfile>}
engine=${IMAGE_ENGINE:-podman}
here=$(cd "$(dirname "$0")" && pwd)

work=$(mktemp -d)
trap 'rm -rf "$work"; "$engine" rmi -f solg-canary-layer solg-canary-arg >/dev/null 2>&1 || true' EXIT

# expect_code <code> <log> <command...>: the command must fail and print <code>.
expect_code() {
    code=$1 log=$2
    shift 2
    if "$@" >"$log" 2>&1; then
        cat "$log"
        echo "::error::$* passed, but must fail with $code"
        exit 1
    fi
    cat "$log"
    grep -q "$code" "$log" || { echo "::error::$* failed, but not with $code"; exit 1; }
}

# --- base by tag -------------------------------------------------------------
printf 'FROM docker.io/library/node:22-bookworm-slim\n' >"$work/Containerfile.tag"
expect_code SOLG-IMG-TAG "$work/tag.log" sh "$here/check-containerfile.sh" "$work/Containerfile.tag"

# --- buf other than BUF_VERSION ----------------------------------------------
printf 'FROM docker.io/bufbuild/buf:0.0.0@sha256:%064d AS buf\n' 0 >"$work/Containerfile.buf"
expect_code SOLG-IMG-BUF "$work/buf.log" sh "$here/check-containerfile.sh" "$work/Containerfile.buf"

# --- token in a layer and in a build argument ---------------------------------
base=$(awk 'toupper($1) == "FROM" { i = 2; while ($i ~ /^--/) i++; ref = $i } END { print ref }' "$containerfile")
case "$base" in
    *@sha256:*) ;;
    *) echo "::error::final base of $containerfile is not pinned: '$base'"; exit 1 ;;
esac

# The bot id is always nine digits: a random number printed as is may be short
# enough to fall outside the pattern, and the negative test would then flake.
id=$(printf '1%08d' $(( $(od -An -N4 -tu4 /dev/urandom | tr -d ' \n') % 100000000 )))
token="$id:$(tr -dc 'A-Za-z0-9_-' </dev/urandom | head -c 35)"

mkdir "$work/layer"
printf '%s\n' "$token" >"$work/layer/leak"
cat >"$work/layer/Containerfile" <<EOF
FROM $base
COPY leak /leak
RUN rm /leak
EOF
"$engine" build -q -t solg-canary-layer -f "$work/layer/Containerfile" "$work/layer" >/dev/null
expect_code SOLG-IMG-TOKEN "$work/layer.log" sh "$here/check-no-token.sh" solg-canary-layer

mkdir "$work/arg"
cat >"$work/arg/Containerfile" <<EOF
FROM $base
ARG HUB_BOT_TOKEN
RUN true
EOF
"$engine" build -q -t solg-canary-arg --build-arg "HUB_BOT_TOKEN=$token" -f "$work/arg/Containerfile" "$work/arg" >/dev/null
expect_code SOLG-IMG-TOKEN "$work/arg.log" sh "$here/check-no-token.sh" solg-canary-arg

echo "Image checks reject a tag-pinned base, a stray buf version, a token in a layer and a token in a build argument."
