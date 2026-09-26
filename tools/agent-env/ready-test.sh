#!/usr/bin/env sh
# Fixture cases for tools/agent-env/ready.sh.
#
# The live answer depends on the host and its logins, so it cannot be a gate.
# These cases lock what the check exists for: every red state names the tool,
# a declared-but-unusable tool differs from an undeclared one, and no silent or
# unreadable answer turns into `ready`.
#
# Each case runs with PATH reduced to one directory: stubs for the tools the
# contract names and wrappers for the few utilities the check itself uses. The
# real gh, claude or codex of the host never answer, so the cases need neither
# network nor a harness. A utility added to ready.sh must be added to
# `utilities` below, or every case fails on it.

set -eu

root=$(git rev-parse --show-toplevel)
check="$root/tools/agent-env/ready.sh"
sh_path=$(command -v sh)
utilities="grep sed tr"
failed=0

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

declared="$scratch/declared"
undeclared="$scratch/undeclared"
mkdir -p "$declared/.rulesync" "$undeclared/.rulesync"
printf '{ "mcpServers": { "linear": { "type": "http" } } }\n' > "$declared/.rulesync/mcp.jsonc"
printf '{ "mcpServers": { "aspire": { "command": "aspire" } } }\n' > "$undeclared/.rulesync/mcp.jsonc"

stub() {
    printf '#!/bin/sh\n%s\n' "$2" > "$1"
    chmod +x "$1"
}

# make_bin DIR [TOOL...] — every stub except the named tools.
make_bin() {
    bin=$1
    shift
    mkdir -p "$bin"
    for util in $utilities; do
        stub "$bin/$util" "exec \"$(command -v "$util")\" \"\$@\""
    done
    for tool in git just skillshare lefthook aspire; do
        stub "$bin/$tool" 'exit 0'
    done
    stub "$bin/gh" '
case ${STUB_GH:-ok} in
    ok) echo "  Logged in to github.com account fixture"; exit 0 ;;
    out) echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2; exit 1 ;;
    net) echo "error connecting to api.github.com" >&2; exit 1 ;;
esac'
    stub "$bin/claude" '
case ${STUB_CLAUDE:-connected} in
    connected) printf "linear:\n  Status: \342\234\224 Connected\n" ;;
    needs-auth) printf "linear:\n  Status: ! Needs authentication\n" ;;
    pending) printf "linear:\n  Status: \342\217\270 Pending approval (run claude to approve)\n" ;;
    absent) echo "No MCP server named \"linear\" found." >&2; exit 1 ;;
    silent) exit 0 ;;
esac'
    stub "$bin/codex" '
server() { printf "  {\n    \"name\": \"%s\",\n    \"enabled\": %s,\n    \"transport\": {\n      \"type\": \"streamable_http\"\n    },\n    \"auth_status\": \"%s\"\n  }" "$1" "$2" "$3"; }
case ${STUB_CODEX:-o_auth} in
    absent) printf "[\n"; server aspire true unsupported; printf "\n]\n" ;;
    disabled) printf "[\n"; server linear false o_auth; printf "\n]\n" ;;
    silent) ;;
    *) printf "[\n"; server aspire true unsupported; printf ",\n"; server linear true "${STUB_CODEX:-o_auth}"; printf "\n]\n" ;;
esac'
    for tool; do
        rm -f "$bin/$tool"
    done
}

# expect NAME CODE NEEDLE HARNESS [VAR=VALUE...] [-- TOOL...]
# Runs ready.sh against the declared fixture unless AGENT_ENV_ROOT is among the
# variables; tools after `--` are removed from PATH.
cases=0
expect() {
    name=$1 code=$2 needle=$3 harness=$4
    shift 4
    cases=$((cases + 1))
    bin="$scratch/bin$cases"
    assignments=
    while [ $# -gt 0 ] && [ "$1" != -- ]; do
        assignments="$assignments $1"
        shift
    done
    [ $# -gt 0 ] && shift
    make_bin "$bin" "$@"

    output=$(
        export PATH="$bin"
        export AGENT_ENV_ROOT="$declared" CLAUDE_CODE_ENTRYPOINT=
        for assignment in $assignments; do
            export "$assignment"
        done
        "$sh_path" "$check" "$harness" 2>&1
    ) && status=0 || status=$?

    if [ "$status" -ne "$code" ]; then
        echo "$name: expected exit $code, got $status:" >&2
        printf '%s\n' "$output" >&2
        failed=1
        return
    fi
    if ! printf '%s\n' "$output" | grep -Fq "$needle"; then
        echo "$name: output does not contain '$needle':" >&2
        printf '%s\n' "$output" >&2
        failed=1
        return
    fi
    if [ "$code" -ne 0 ] && printf '%s\n' "$output" | grep -Fxq 'agent-ready: ready'; then
        echo "$name: exit $code, but the output says ready" >&2
        failed=1
        return
    fi
    echo "ok: $name"
}

row() {
    printf '%s\t%s\t%s' "$1" "$2" "$3"
}

expect 'everything ready in claude' 0 'agent-ready: ready' claude
expect 'everything ready in codex' 0 "$(row ok open linear)" codex

# Linear is declared but not usable: the harness says so itself.
expect 'claude needs authentication' 1 "$(row unauthorized open linear)" claude STUB_CLAUDE=needs-auth
expect 'claude has not approved the server' 1 "$(row unauthorized open linear)" claude STUB_CLAUDE=pending
expect 'codex is not logged in' 1 "$(row unauthorized open linear)" codex STUB_CODEX=not_logged_in
expect 'codex has the server disabled' 1 "$(row unauthorized open linear)" codex STUB_CODEX=disabled

# Linear is not declared: in the repository, in the harness, or no harness.
expect 'repository does not declare linear' 1 'not declared in .rulesync/mcp.jsonc' codex AGENT_ENV_ROOT="$undeclared"
expect 'claude does not know the server' 1 "$(row missing open linear)" claude STUB_CLAUDE=absent
expect 'codex does not list the server' 1 "$(row missing open linear)" codex STUB_CODEX=absent
expect 'codex lists nothing' 1 "$(row missing open linear)" codex STUB_CODEX=silent
expect 'claude is not installed' 1 "$(row missing open linear)" claude -- claude

# The state is not visible: never green, never red.
expect 'desktop session' 3 "$(row unverified open linear)" claude CLAUDE_CODE_ENTRYPOINT=claude-desktop
expect 'claude answers without a status' 3 "$(row unverified open linear)" claude STUB_CLAUDE=silent
expect 'codex reports an unknown auth status' 3 "$(row unverified open linear)" codex STUB_CODEX=unsupported
expect 'harness without an MCP command' 3 "$(row unverified open linear)" cursor
expect 'gh cannot reach github' 3 "$(row unverified deliver gh)" codex STUB_GH=net

# Other required tools are named, optional ones never change the verdict.
expect 'git is not installed' 1 "$(row missing open git)" codex -- git
expect 'just is not installed' 1 "$(row missing deliver just)" codex -- just
expect 'gh is not installed' 1 "$(row missing deliver gh)" codex -- gh
expect 'gh is logged out' 1 "$(row unauthorized deliver gh)" codex STUB_GH=out
expect 'optional aspire is not installed' 0 "$(row missing optional aspire)" codex -- aspire

expect 'unknown harness' 2 "unknown harness 'zed'" zed
expect 'a utility of the check is missing' 2 'sed is not in PATH' codex -- sed

if [ "$failed" -ne 0 ]; then
    exit 1
fi
echo "agent-ready: all $cases fixture cases pass"
