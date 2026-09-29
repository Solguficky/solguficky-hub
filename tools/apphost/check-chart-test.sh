#!/usr/bin/env sh
# Fixture cases for tools/apphost/check-chart.py.
#
# The chart CI renders is one happy path and cannot show that the check fails
# where it must. So each case gets its own rendered tree: four Deployments in
# the shape the generator emits, with one defect, and the failure must name the
# workload and the rule it breaks. Runs without helm: it feeds rendered trees.

set -eu

root=$(git rev-parse --show-toplevel)
check="$root/tools/apphost/check-chart.py"
python=${PYTHON:-python3}
failed=0
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

digest=sha256:0000000000000000000000000000000000000000000000000000000000000000

# deployment NAME - a Deployment that satisfies every rule; cases edit it with sed
deployment() {
    cat <<EOF
---
apiVersion: "apps/v1"
kind: "Deployment"
metadata:
  name: "$1-deployment"
spec:
  template:
    spec:
      containers:
        - image: "ghcr.io/solguficky/$1@$digest"
          livenessProbe:
            grpc:
              port: 8080
          name: "$1"
          readinessProbe:
            grpc:
              service: "$1.v1.Service"
              port: 8080
          resources:
            limits:
              cpu: "1"
              memory: "256Mi"
      securityContext:
        runAsNonRoot: true
  replicas: 1
  strategy:
    type: "Recreate"
EOF
}

# tree CASE - a rendered tree with the four MVP workloads
tree() {
    work="$scratch/$1"
    for name in identity meetups notifications telegram-bot; do
        mkdir -p "$work/solguficky-hub/templates/$name"
        deployment "$name" > "$work/solguficky-hub/templates/$name/deployment.yaml"
    done
    echo "$work"
}

assert_passes() {
    if output=$("$python" "$check" --rendered "$2" 2>&1); then
        echo "ok   $1"
    else
        echo "FAIL $1: expected success, got:"
        echo "$output" | sed 's/^/     /'
        failed=1
    fi
}

assert_fails() {
    if output=$("$python" "$check" --rendered "$3" 2>&1); then
        echo "FAIL $1: expected failure, got success"
        failed=1
    elif echo "$output" | grep -qF -- "$2"; then
        echo "ok   $1"
    else
        echo "FAIL $1: failure does not name '$2':"
        echo "$output" | sed 's/^/     /'
        failed=1
    fi
}

work=$(tree good)
assert_passes "four workloads by the rules pass" "$work"

work=$(tree bot-without-probes)
sed -i '/Probe:/,/port:/d' "$work/solguficky-hub/templates/telegram-bot/deployment.yaml"
assert_passes "the bot is the one workload allowed without probes" "$work"

work=$(tree two-replicas)
sed -i 's/replicas: 1/replicas: 2/' "$work/solguficky-hub/templates/meetups/deployment.yaml"
assert_fails "a second replica" "meetups: replicas must be 1, got 2" "$work"

work=$(tree rolling-update)
sed -i 's/type: "Recreate"/type: "RollingUpdate"/' "$work/solguficky-hub/templates/identity/deployment.yaml"
assert_fails "a rolling update" "identity: strategy must be Recreate" "$work"

work=$(tree rolling-update-block)
sed -i 's/  strategy:/  strategy:\n    rollingUpdate:\n      maxSurge: 0/' "$work/solguficky-hub/templates/notifications/deployment.yaml"
assert_fails "a rollingUpdate block next to Recreate" "notifications: rollingUpdate next to Recreate" "$work"

work=$(tree image-tag)
sed -i "s|telegram-bot@$digest|telegram-bot:latest|" "$work/solguficky-hub/templates/telegram-bot/deployment.yaml"
assert_fails "an image by tag" "telegram-bot: image 'ghcr.io/solguficky/telegram-bot:latest' is not pinned" "$work"

work=$(tree root)
sed -i '/runAsNonRoot/d' "$work/solguficky-hub/templates/identity/deployment.yaml"
assert_fails "a pod that may run as root" "identity: pod must set runAsNonRoot" "$work"

work=$(tree no-limits)
sed -i '/limits:/,/memory:/d' "$work/solguficky-hub/templates/meetups/deployment.yaml"
assert_fails "a container without limits" "meetups: container has no resource limits" "$work"

work=$(tree no-readiness)
sed -i '/readinessProbe:/,/port:/d' "$work/solguficky-hub/templates/notifications/deployment.yaml"
assert_fails "a gRPC service without readiness" "notifications: no readinessProbe" "$work"

work=$(tree leaked-build-step)
mkdir -p "$work/solguficky-hub/templates/identity-build"
deployment identity-build > "$work/solguficky-hub/templates/identity-build/deployment.yaml"
assert_fails "a leaked build step" "identity-build: workload is not one of the MVP services" "$work"

work=$(tree stateful-infrastructure)
mkdir -p "$work/solguficky-hub/templates/postgres"
deployment postgres | sed 's/kind: "Deployment"/kind: "StatefulSet"/' > "$work/solguficky-hub/templates/postgres/statefulset.yaml"
assert_fails "PostgreSQL inside the chart" "postgres: workload kind StatefulSet" "$work"

work=$(tree missing-service)
rm -r "$work/solguficky-hub/templates/notifications"
assert_fails "a service missing from the chart" "notifications: MVP service has no workload" "$work"

values() {
    printf 'parameters:\n  identity:\n    identity_image: "identity:latest"\n'
    printf 'secrets:\n  identity:\n    identity_db: %s\n    nats: ""\n' "$1"
    printf 'config:\n  identity:\n    IDENTITY_GRPC_ADDR: ":50051"\n'
}

assert_values_pass() {
    if output=$("$python" "$check" --values "$2" 2>&1); then
        echo "ok   $1"
    else
        echo "FAIL $1: expected success, got:"
        echo "$output" | sed 's/^/     /'
        failed=1
    fi
}

assert_values_fail() {
    if output=$("$python" "$check" --values "$3" 2>&1); then
        echo "FAIL $1: expected failure, got success"
        failed=1
    elif echo "$output" | grep -qF -- "$2"; then
        echo "ok   $1"
    else
        echo "FAIL $1: failure does not name '$2':"
        echo "$output" | sed 's/^/     /'
        failed=1
    fi
}

values '""' > "$scratch/values-empty.yaml"
assert_values_pass "secrets without values pass, config values are allowed" "$scratch/values-empty.yaml"

values '"postgresql://leaked"' > "$scratch/values-leaked.yaml"
assert_values_fail "a secret with a value in the chart" "secret 'identity.identity_db' has a value" "$scratch/values-leaked.yaml"

if [ "$failed" -ne 0 ]; then
    echo "check-chart-test: some cases failed"
    exit 1
fi
echo "check-chart-test: all cases passed"
