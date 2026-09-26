#!/usr/bin/env sh
# Smoke-test a live AppHost profile: every resource settles, and every gRPC
# service answers a domain call, not just its health probe.
#
# Usage: sh tools/apphost/smoke.sh [--attach] [--keep] [profile [apphost args...]]
#
#   profile   Topology profile, `hub` by default. Extra args go to the AppHost.
#   --attach  Check the AppHost already running from this worktree instead of
#             starting one. Used after restarting a resource by hand.
#   --keep    Leave the AppHost running afterwards for manual checks.
#
# Exit code 0 means every check passed. Needs aspire, grpcurl and python3.
#
# Why a health probe is not enough: PER-7 saw Identity answer SERVING while
# every ResolveIdentity failed on a commit the schema rejected. The domain
# calls below share one x-request-id, so the same chain can be found in
# Structured logs by that value afterwards.
#
# Why resources are read from `aspire describe` instead of waited on one by
# one: a resource whose dependency failed stays Waiting forever, and waiting on
# it only turns the real failure into a timeout. The loop stops as soon as
# nothing left can still make progress and names what failed.

set -eu

APPHOST=infra/apphost/AppHost.csproj
ATTACH=no
KEEP=no
while [ $# -gt 0 ]; do
  case $1 in
    --attach) ATTACH=yes; shift ;;
    --keep) KEEP=yes; shift ;;
    *) break ;;
  esac
done
PROFILE=${1:-hub}
[ $# -gt 0 ] && shift

# `aspire` finds the AppHost by walking up from the current directory, and a
# worktree lives inside the main clone: from anywhere but the root it would
# pick the parent's AppHost.
cd "$(git rev-parse --show-toplevel)"

for tool in aspire grpcurl python3; do
  command -v "$tool" > /dev/null || { echo "smoke: $tool is not in PATH" >&2; exit 2; }
done

# The CLI gives the AppHost 120 s to come up by default, and a cold build of
# four components takes longer: the start then fails although nothing is wrong.
ASPIRE_CLI_START_TIMEOUT=${ASPIRE_CLI_START_TIMEOUT:-600}
export ASPIRE_CLI_START_TIMEOUT
SETTLE_TIMEOUT=${SMOKE_SETTLE_TIMEOUT:-600}
RUN=$(python3 -c 'import secrets; print(secrets.token_hex(4))')
REQUEST_ID=smoke-$RUN
FAILS=0

ok() { echo "  ok    $1"; }
fail() { echo "  FAIL  $1"; FAILS=$((FAILS + 1)); }

describe() {
  aspire describe --format Json --apphost "$APPHOST" --non-interactive 2> /dev/null
}

# Prints one line per resource: name, verdict (ok | pending | fail), detail.
# One-shot executables (code generation, build, npm install) end as Finished,
# long-running ones must be Running and healthy if they have health checks.
# No readable snapshot or no resources at all is a failure, not an empty
# success: with --attach and nothing running, every later check would skip.
# Pseudo-resources are named in parentheses and have no log to show.
classify() {
  python3 -c '
import json, sys
PENDING = {"", "Unknown", "NotStarted", "Starting", "Waiting", "Building", "Stopping", "Activating"}
try:
    resources = json.load(sys.stdin)["resources"]
except Exception:
    print("(describe)\tfail\tno readable snapshot from aspire describe"); sys.exit()
if not resources:
    print("(describe)\tfail\tthe AppHost reports no resources"); sys.exit()
for r in resources:
    name, state = r["displayName"], r.get("state") or ""
    health = r.get("healthStatus")
    if state == "Finished":
        code = r.get("exitCode")
        verdict = "ok" if code == 0 else "fail"
        detail = f"finished, exit code {code}"
    elif state == "Running":
        verdict = "ok" if health in (None, "Healthy") else "pending"
        detail = "running" + (f", {health}" if health else "")
    elif state in PENDING:
        verdict, detail = "pending", state.lower() or "no state"
    else:
        verdict, detail = "fail", state
    print(f"{name}\t{verdict}\t{detail}")
'
}

endpoint() {
  python3 -c '
import json, sys
try: resources = json.load(sys.stdin)["resources"]
except Exception: sys.exit()
for r in resources:
    if r["displayName"] == sys.argv[1]:
        for u in r.get("urls") or []:
            if u["url"].startswith("http://"):
                print(u["url"].removeprefix("http://")); sys.exit()
' "$1"
}

present() {
  python3 -c '
import json, sys
try: resources = json.load(sys.stdin)["resources"]
except Exception: sys.exit(1)
sys.exit(0 if any(r["displayName"] == sys.argv[1] for r in resources) else 1)
' "$1"
}

logs() {
  aspire logs "$1" --apphost "$APPHOST" --non-interactive 2> /dev/null \
    | sed 's/\x1b\[[0-9;]*m//g'
}

# A crashing Go build prints the reason once and then pages of goroutines, so
# the tail alone hides it: show the first error-looking lines, then the tail.
show_failure_logs() {
  out=$(logs "$1")
  echo "$out" | grep -i -m 5 'fatal\|panic\|error\|exception' | sed 's/^/        /' || true
  echo "        ..."
  echo "$out" | tail -n 5 | sed 's/^/        /'
}

stop_apphost() {
  if [ "$KEEP" = no ]; then
    if aspire stop --apphost "$APPHOST" --non-interactive > /dev/null 2>&1; then
      echo "AppHost stopped"
    else
      fail "aspire stop failed: the AppHost may still hold its containers (aspire ps)"
    fi
  else
    echo "AppHost left running (--keep)"
  fi
}

echo "smoke run=$RUN profile=$PROFILE"

if [ "$ATTACH" = no ]; then
  echo "1. Start"
  if aspire start --isolated --non-interactive --apphost "$APPHOST" -- --profile "$PROFILE" "$@" > /dev/null 2>&1; then
    ok "aspire start"
  else
    fail "aspire start did not bring the AppHost up; see ~/.aspire/logs"
    exit 1
  fi
fi

echo "2. Resources settle"
deadline=$(( $(date +%s) + SETTLE_TIMEOUT ))
while :; do
  states=$(describe | classify)
  pending=$(printf '%s\n' "$states" | awk -F '\t' '$2 == "pending"')
  failed=$(printf '%s\n' "$states" | awk -F '\t' '$2 == "fail"')
  # A failure leaves its dependents Waiting for good: nothing can move any more.
  stuck=$(printf '%s\n' "$pending" | awk -F '\t' 'NF && $3 != "waiting"')
  if [ -z "$pending" ] || { [ -n "$failed" ] && [ -z "$stuck" ]; }; then break; fi
  if [ "$(date +%s)" -ge "$deadline" ]; then break; fi
  sleep 5
done
printf '%s\n' "$states" | while IFS="$(printf '\t')" read -r name verdict detail; do
  [ -n "$name" ] || continue
  case $verdict in
    ok) echo "  ok    $name: $detail" ;;
    *) echo "  FAIL  $name: $detail" ;;
  esac
done
bad=$(printf '%s\n' "$states" | awk -F '\t' '$2 != "ok" && NF' | cut -f1)
for name in $bad; do
  FAILS=$((FAILS + 1))
  case $(printf '%s\n' "$states" | awk -F '\t' -v n="$name" '$1 == n { print $3 }') in
    waiting) ;; # its own log is empty; the cause is the failed dependency
    *) case $name in
         '('*) ;;
         *) echo "      log of $name:"; show_failure_logs "$name" ;;
       esac ;;
  esac
done

echo "3. Domain calls (x-request-id: $REQUEST_ID)"
snapshot=$(describe)
IDENTITY=$(echo "$snapshot" | endpoint identity)
MEETUPS=$(echo "$snapshot" | endpoint meetups)
NOTIFICATIONS=$(echo "$snapshot" | endpoint notifications)

call() {
  addr=$1 method=$2 body=$3
  grpcurl -plaintext -max-time 10 -H "x-request-id: $REQUEST_ID" -H "x-use-case: smoke" \
    -d "$body" "$addr" "$method" 2>&1 || true
}
has() { python3 -c 'import sys; sys.exit(0 if sys.argv[1] in sys.stdin.read() else 1)' "$1"; }

# Readiness is asked by the service name: the empty name only answers liveness
# and never checks the database. The status is compared whole, because
# NOT_SERVING contains SERVING as a substring.
for triple in "identity identity.v1.IdentityService $IDENTITY" \
              "meetups meetups.v1.MeetupsService $MEETUPS" \
              "notifications notifications.v1.NotificationsService $NOTIFICATIONS"; do
  set -- $triple
  [ $# -eq 3 ] || continue
  if grpcurl -plaintext -max-time 10 -d "{\"service\": \"$2\"}" "$3" grpc.health.v1.Health/Check 2>&1 \
      | has '"status": "SERVING"'; then
    ok "$1 readiness: SERVING"
  else
    fail "$1 readiness is not SERVING"
  fi
done

# A synthetic Telegram id far above real ones: the smoke leaves a profile
# behind in the worktree's own database, never in anyone else's.
VIEWER=
if [ -n "$IDENTITY" ]; then
  tg=$(python3 -c 'import random; print(9_000_000_000_000 + random.randrange(10**9))')
  out=$(call "$IDENTITY" identity.v1.IdentityService/ResolveIdentity "{\"telegram_user_id\":$tg}")
  VIEWER=$(echo "$out" | python3 -c 'import json, sys
try: print(json.load(sys.stdin)["identityId"])
except Exception: pass')
  if [ -n "$VIEWER" ]; then
    ok "identity ResolveIdentity: new profile $VIEWER"
  else
    fail "identity ResolveIdentity: $(echo "$out" | tr '\n' ' ')"
  fi
fi
# Without Identity in the profile the other services still get a well-formed
# viewer: they check its shape, not its existence.
[ -n "$VIEWER" ] || VIEWER=$(python3 -c '
import os, time
b = bytearray(int(time.time() * 1000).to_bytes(6, "big") + os.urandom(10))
b[6] = (b[6] & 0x0F) | 0x70; b[8] = (b[8] & 0x3F) | 0x80
h = b.hex(); print(f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}")')

if [ -n "$MEETUPS" ]; then
  out=$(call "$MEETUPS" meetups.v1.MeetupsService/GetMeetup \
    "{\"viewer\":{\"identity_id\":\"$VIEWER\"},\"id\":\"0199a000-0000-7000-8000-000000000000\"}")
  if echo "$out" | has NotFound; then
    ok "meetups GetMeetup of a missing id: NotFound"
  else
    fail "meetups GetMeetup: $(echo "$out" | tr '\n' ' ')"
  fi
fi

if [ -n "$NOTIFICATIONS" ]; then
  out=$(call "$NOTIFICATIONS" notifications.v1.NotificationsService/GetGlobalNotificationPreferences \
    "{\"identity_id\":\"$VIEWER\"}")
  if echo "$out" | has ERROR; then
    fail "notifications GetGlobalNotificationPreferences: $(echo "$out" | tr '\n' ' ')"
  else
    ok "notifications GetGlobalNotificationPreferences answered"
  fi
fi

if echo "$snapshot" | present nats; then
  echo "4. Bus"
  if logs nats | has "JetStream topology applied"; then
    ok "nats: JetStream topology applied"
  else
    fail "nats: no 'JetStream topology applied' in its log"
  fi
fi

echo "request_id for Structured logs: $REQUEST_ID"
stop_apphost
if [ "$FAILS" -gt 0 ]; then
  echo "smoke: $FAILS check(s) failed"
  exit 1
fi
echo "smoke: all checks passed"
