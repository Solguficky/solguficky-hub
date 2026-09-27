#!/usr/bin/env sh
# Checks that this environment can run the task loop of
# docs/development/agent-execution-loop.md: every tool of the environment
# contract is named with its state, and a tool that is declared but not usable
# differs from one that is not declared at all.
#
# Usage: sh tools/agent-env/ready.sh <harness>
#
#   harness   The agent harness that will run the loop: claude, codex, cursor,
#             opencode or copilot. Named explicitly, not guessed, so that two
#             hosts checked with the same name give comparable answers.
#
# Output: one tab-separated line per tool, `state level tool detail`, in the
# order of the contract. State is one of
#   ok            usable
#   missing       not installed or not declared
#   unauthorized  declared, but the tool itself reports it cannot be used:
#                 not logged in, not approved, disabled
#   unverified    this check cannot see whether it is usable
# Level is `open` (without it the loop is not opened), `deliver` (the loop
# opens, but no pull request comes out of it) or `optional`. Hosts are compared
# on the first three columns: the detail may differ between machines.
#
# Exit code:
#   0  every open and deliver tool is ok
#   1  an open or deliver tool is missing or unauthorized
#   2  the check itself failed: unknown harness or a tool the check needs
#   3  nothing is red, but an open or deliver tool is unverified. This is not
#      green: the state was not seen, the same way a gate that stopped before
#      the change did not pass it.
# Optional tools never change the exit code.
#
# The rows follow the contract table in docs/development/agent-execution-loop.md
# (section «Контракт среды»); a tool added there is added here in the same
# change. The same section says why Linear MCP is asked of the harness CLI,
# why a Claude Code host other than the terminal CLI is unverified, and what
# this check does not cover.
#
# AGENT_ENV_ROOT overrides the repository root; only the fixture test sets it.

set -eu

usage() {
    echo "usage: sh tools/agent-env/ready.sh <claude|codex|cursor|opencode|copilot>" >&2
    exit 2
}

[ $# -eq 1 ] || usage
harness=$1
case $harness in
    claude | codex | cursor | opencode | copilot) ;;
    *) echo "agent-ready: unknown harness '$harness'" >&2; usage ;;
esac

for tool in grep sed tr; do
    command -v "$tool" > /dev/null || { echo "agent-ready: $tool is not in PATH" >&2; exit 2; }
done

root=${AGENT_ENV_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}
mcp_source="$root/.rulesync/mcp.jsonc"

red=no
unverified=no

report() {
    state=$1 level=$2 tool=$3 detail=$4
    printf '%s\t%s\t%s\t%s\n' "$state" "$level" "$tool" "$detail"
    [ "$level" = optional ] && return 0
    case $state in
        missing | unauthorized) red=yes ;;
        unverified) unverified=yes ;;
    esac
}

# A harness CLI may hang on a network health check; a hung probe is
# unverified, not red. `timeout` is used where the host has the coreutils one:
# on Windows the name may resolve to System32\timeout.exe, which takes other
# arguments and fails on these.
if command -v timeout > /dev/null && timeout 5 true 2> /dev/null; then
    has_timeout=yes
else
    has_timeout=no
fi

probe() {
    if [ "$has_timeout" = yes ]; then
        timeout 60 "$@"
    else
        "$@"
    fi
}

check_cli() {
    level=$1 tool=$2 why=$3
    if command -v "$tool" > /dev/null; then
        report ok "$level" "$tool" "$why"
    else
        report missing "$level" "$tool" "not in PATH; needed for: $why"
    fi
}

# gh prints the account and a masked token; neither is echoed here, only the
# verdict. Only the active github.com account counts: a stale token on another
# host or a second account does not stop a pull request here. Offline,
# `gh auth status` prints the same "Failed to log in ... token is invalid" as
# a revoked token, so that answer is settled by a second call: the API says
# "Bad credentials" only when it was reached. An offline host is unverified,
# not logged out.
check_gh() {
    if ! command -v gh > /dev/null; then
        report missing deliver gh "not in PATH; needed for: pull request"
        return
    fi
    if out=$(probe gh auth status --active --hostname github.com 2>&1); then
        report ok deliver gh "logged in"
        return
    fi
    case $out in
        *"not logged in"* | *"not logged into"*)
            report unauthorized deliver gh "installed, not logged in: gh auth login"
            return ;;
    esac
    api=$(probe gh api --hostname github.com rate_limit 2>&1) || true
    case $api in
        *"Bad credentials"*)
            report unauthorized deliver gh "installed, the token is rejected: gh auth login" ;;
        *)
            report unverified deliver gh "gh auth status failed and GitHub was not reached" ;;
    esac
}

# The CLI answers for itself: outside a session, or inside a terminal CLI
# session. Any other Claude Code host (desktop app, IDE, SDK) may keep MCP
# approval where the CLI does not read it, so its answer would be a guess.
linear_in_claude() {
    case ${CLAUDE_CODE_ENTRYPOINT:-} in
        "" | cli) ;;
        *)
            report unverified open linear "claude host '$CLAUDE_CODE_ENTRYPOINT' keeps MCP approval where the CLI may not read it; confirm with get_issue from the session"
            return ;;
    esac
    if ! command -v claude > /dev/null; then
        report missing open linear "claude is not in PATH, nothing runs the server"
        return
    fi
    out=$(probe claude mcp get linear 2>&1) && status=0 || status=$?
    case $out in
        *"No MCP server"*)
            report missing open linear "declared in the repository, not in claude: run claude in the repository root" ;;
        *"Status:"*Connected*)
            report ok open linear "connected in claude" ;;
        *"Status:"*"Needs authentication"*)
            report unauthorized open linear "declared in claude, not authenticated: /mcp in a claude session" ;;
        *"Status:"*"Pending approval"*)
            report unauthorized open linear "declared in claude, not approved: run claude in the repository root" ;;
        *)
            report unverified open linear "claude mcp get linear gave no known status (exit $status)" ;;
    esac
}

# `codex mcp list --json` prints an indented array, one object per server, with
# name, enabled and auth_status four spaces deep. Only that depth is read: the
# same keys nested in a server's env or headers must not be taken for its own.
# Output without an array, or in another layout, is unverified, not ok.
linear_in_codex() {
    if ! command -v codex > /dev/null; then
        report missing open linear "codex is not in PATH, nothing runs the server"
        return
    fi
    out=$(probe codex mcp list --json 2> /dev/null) || {
        report unverified open linear "codex mcp list --json failed"
        return
    }
    case $out in
        *"["*) ;;
        *)
            report unverified open linear "codex mcp list --json printed no server list"
            return ;;
    esac
    fields=$(printf '%s\n' "$out" | tr -d '\r' | sed -n \
        -e 's/^    "name": *"\([^"]*\)".*/name \1/p' \
        -e 's/^    "enabled": *\([a-z]*\).*/enabled \1/p' \
        -e 's/^    "auth_status": *"\([^"]*\)".*/auth \1/p')
    current= servers=0 listed=no enabled= auth=
    while read -r key value; do
        case $key in
            name)
                current=$value
                servers=$((servers + 1))
                [ "$value" = linear ] && listed=yes ;;
            enabled) [ "$current" = linear ] && enabled=$value ;;
            auth) [ "$current" = linear ] && auth=$value ;;
        esac
    done << EOF
$fields
EOF
    # An empty array lists no servers. A non-empty one where no server name was
    # read at the expected depth is a layout this check does not know.
    if [ "$listed" = no ]; then
        if [ "$servers" -eq 0 ] && printf '%s' "$out" | grep -q '"name"'; then
            report unverified open linear "codex lists servers in a layout this check does not read"
        else
            report missing open linear "declared in the repository, not in codex: .codex/config.toml is not loaded"
        fi
        return
    fi
    if [ -z "$enabled" ] || [ -z "$auth" ]; then
        report unverified open linear "codex lists linear without enabled or auth_status"
        return
    fi
    if [ "$enabled" = false ]; then
        report unauthorized open linear "declared in codex, disabled"
        return
    fi
    case $auth in
        o_auth | bearer_token) report ok open linear "authenticated in codex ($auth)" ;;
        not_logged_in) report unauthorized open linear "declared in codex, not logged in: codex mcp login linear" ;;
        *) report unverified open linear "codex reports auth_status '$auth'" ;;
    esac
}

# The server is declared when "linear" opens a line as a key; a commented-out
# entry or the word as a value elsewhere does not count.
check_linear() {
    if ! grep -Eq '^[[:space:]]*"linear"[[:space:]]*:' "$mcp_source" 2> /dev/null; then
        report missing open linear "not declared in .rulesync/mcp.jsonc"
        return
    fi
    case $harness in
        claude) linear_in_claude ;;
        codex) linear_in_codex ;;
        *)
            report unverified open linear "this check cannot read MCP state in $harness; confirm with get_issue from the session" ;;
    esac
}

check_cli open git "branch, commit, push"
check_linear
check_cli deliver just "mechanical gate"
check_gh
check_cli optional skillshare "proj- skills and subagent roles for claude and opencode"
check_cli optional lefthook "local commit-msg hook"
check_cli optional aspire "Aspire MCP and the live gate"

echo "not checked: component tooling (just tools), push rights, Linear write access"

if [ "$red" = yes ]; then
    echo "agent-ready: not ready — see missing and unauthorized above"
    exit 1
fi
if [ "$unverified" = yes ]; then
    echo "agent-ready: not verified — nothing is red, but unverified is not green"
    exit 3
fi
echo "agent-ready: ready"
