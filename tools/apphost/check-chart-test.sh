#!/usr/bin/env sh
# Fixture cases for tools/apphost/check-chart.py.
#
# The chart CI renders is one happy path and cannot show that the check fails
# where it must. So each case gets its own rendered tree: six Deployments in
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
checksum=1111111111111111111111111111111111111111111111111111111111111111

# probes NAME - probes of the service's form: gRPC, or HTTP readiness with TCP
# startup and liveness for Auction
probes() {
    if [ "$1" = auction ]; then
        cat <<EOF
          livenessProbe:
            tcpSocket:
              port: 8080
          name: "$1"
          readinessProbe:
            httpGet:
              path: "/health"
              port: 8080
          startupProbe:
            tcpSocket:
              port: 8080
EOF
    else
        cat <<EOF
          livenessProbe:
            grpc:
              port: 8080
          name: "$1"
          readinessProbe:
            grpc:
              service: "$1.v1.Service"
              port: 8080
EOF
    fi
}

# image NAME - the image a service runs: the auction and support bots run the hub bot's
image() {
    case "$1" in
        auction-bot | support-bot) echo "ghcr.io/solguficky/hub-bot@$digest" ;;
        *) echo "ghcr.io/solguficky/$1@$digest" ;;
    esac
}

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
    metadata:
      annotations:
        checksum/config: "$checksum"
        checksum/secrets: "$checksum"
    spec:
      containers:
        - image: "$(image "$1")"
EOF
    probes "$1"
    cat <<EOF
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

# topology - the JetStream topology hook Job and the ConfigMap it reads, both
# pre-hooks in the shape the AppHost publish emits
topology() {
    cat <<EOF
---
apiVersion: "batch/v1"
kind: "Job"
metadata:
  name: "jetstream-topology"
  annotations:
    helm.sh/hook: "pre-install,pre-upgrade"
    helm.sh/hook-weight: "0"
  labels:
    app.kubernetes.io/component: "jetstream-topology"
spec:
  template:
    spec:
      containers:
        - image: "docker.io/natsio/nats-box@$digest"
          resources:
            limits:
              memory: "64Mi"
      securityContext:
        runAsNonRoot: true
      restartPolicy: "Never"
      volumes:
        - name: "topology"
          configMap:
            name: "jetstream-topology-files"
---
apiVersion: "v1"
kind: "ConfigMap"
metadata:
  name: "jetstream-topology-files"
  annotations:
    helm.sh/hook: "pre-install,pre-upgrade"
    helm.sh/hook-weight: "-10"
  labels:
    app.kubernetes.io/component: "jetstream-topology"
EOF
}

# tunnel - the public entry tunnel switched off, its ingress rules and the
# Auction Service they reach, in the shape the AppHost publish emits (ADR-071)
tunnel() {
    cat <<EOF
---
apiVersion: "apps/v1"
kind: "Deployment"
metadata:
  name: "cloudflared-deployment"
spec:
  selector:
    matchLabels:
      app.kubernetes.io/component: "cloudflared"
  revisionHistoryLimit: 3
  strategy:
    type: "Recreate"
  template:
    metadata:
      annotations:
        checksum/config: "$checksum"
        checksum/secrets: "$checksum"
        checksum/ingress: "$checksum"
    spec:
      containers:
        - image: "docker.io/cloudflare/cloudflared@$digest"
          livenessProbe:
            tcpSocket:
              port: 2000
          name: "cloudflared"
          readinessProbe:
            httpGet:
              path: "/ready"
              port: 2000
          startupProbe:
            tcpSocket:
              port: 2000
          args:
            - "tunnel"
            - "--config"
            - "/etc/cloudflared/config.yml"
            - "run"
          resources:
            limits:
              cpu: "200m"
              memory: "128Mi"
      volumes:
        - name: "ingress"
          configMap:
            name: "cloudflared-ingress"
      securityContext:
        runAsNonRoot: true
  replicas: !!int "0"
EOF
    cat <<'EOF'
---
apiVersion: "v1"
kind: "ConfigMap"
metadata:
  name: "cloudflared-ingress"
  labels:
    app.kubernetes.io/component: "cloudflared"
data:
  config.yml: "ingress:\n  - path: ^/screen/\n    service: http://auction-service:8080\n  - service: http_status:404\n"
EOF
}

# auction_service - the Service the tunnel's rules reach
auction_service() {
    cat <<EOF
---
apiVersion: "v1"
kind: "Service"
metadata:
  name: "auction-service"
spec:
  type: "ClusterIP"
  ports:
    - name: "http"
      protocol: "TCP"
      port: 8080
      targetPort: 8080
    - name: "grpc"
      protocol: "TCP"
      port: 8081
      targetPort: 8081
EOF
}

# tree CASE - a rendered tree with the eight chart workloads and the topology Job
tree() {
    work="$scratch/$1"
    for name in identity meetups notifications hub-bot auction auction-bot support-bot; do
        mkdir -p "$work/solguficky-hub/templates/$name"
        deployment "$name" > "$work/solguficky-hub/templates/$name/deployment.yaml"
    done
    auction_service > "$work/solguficky-hub/templates/auction/service.yaml"
    mkdir -p "$work/solguficky-hub/templates/cloudflared"
    tunnel > "$work/solguficky-hub/templates/cloudflared/deployment.yaml"
    mkdir -p "$work/solguficky-hub/templates/jetstream-topology"
    topology > "$work/solguficky-hub/templates/jetstream-topology/jetstream-topology.yaml"
    echo "$work"
}

# A case renders with the tunnel switched off unless it names --rendered-enabled.
assert_passes() {
    if output=$("$python" "$check" "${3:---rendered}" "$2" 2>&1); then
        echo "ok   $1"
    else
        echo "FAIL $1: expected success, got:"
        echo "$output" | sed 's/^/     /'
        failed=1
    fi
}

assert_fails() {
    if output=$("$python" "$check" "${4:---rendered}" "$3" 2>&1); then
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
assert_passes "eight workloads and the topology Job by the rules pass" "$work"

work=$(tree tunnel-enabled)
sed -i 's/replicas: !!int "0"/replicas: !!int "1"/' "$work/solguficky-hub/templates/cloudflared/deployment.yaml"
assert_passes "the tunnel runs one replica where the environment enables it" "$work" --rendered-enabled

work=$(tree tunnel-on-without-key)
sed -i 's/replicas: !!int "0"/replicas: !!int "1"/' "$work/solguficky-hub/templates/cloudflared/deployment.yaml"
assert_fails "the tunnel running in an environment that did not enable it" 'cloudflared: replicas must be !!int "0", got !!int "1"' "$work"

work=$(tree tunnel-off-with-key)
assert_fails "the tunnel staying off where the environment enables it" 'cloudflared: replicas must be !!int "1", got !!int "0"' "$work" --rendered-enabled

work=$(tree tunnel-quoted-count)
sed -i 's/replicas: !!int "0"/replicas: "1"/' "$work/solguficky-hub/templates/cloudflared/deployment.yaml"
assert_fails "a quoted replica count the Kubernetes API rejects" 'cloudflared: replicas must be !!int "1", got "1"' "$work" --rendered-enabled

work=$(tree tunnel-unanchored-path)
sed -i 's|path: ^/screen/|path: /screen/|' "$work/solguficky-hub/templates/cloudflared/deployment.yaml"
assert_fails "an unanchored screen path that passes /x/screen/y" "cloudflared: ingress rules must pass only ^/screen/" "$work"

work=$(tree tunnel-no-catch-all)
sed -i 's|  - service: http_status:404\\n||' "$work/solguficky-hub/templates/cloudflared/deployment.yaml"
assert_fails "rules without the 404 catch-all" "cloudflared: ingress rules must pass only ^/screen/" "$work"

work=$(tree tunnel-to-grpc)
sed -i 's|auction-service:8080|auction-service:8081|' "$work/solguficky-hub/templates/cloudflared/deployment.yaml"
assert_fails "rules reaching the gRPC port" "cloudflared: ingress rules must pass only ^/screen/ to auction-service:8080" "$work"

work=$(tree tunnel-origin-missing)
rm "$work/solguficky-hub/templates/auction/service.yaml"
assert_fails "rules reaching a Service the chart does not render" "cloudflared: chart renders no auction-service Service" "$work"

work=$(tree tunnel-token-argument)
sed -i 's|            - "run"|            - "run"\n            - "--token"|' "$work/solguficky-hub/templates/cloudflared/deployment.yaml"
assert_fails "the token in the pod spec" "cloudflared: the token must come from TUNNEL_TOKEN" "$work"

work=$(tree tunnel-no-ingress-checksum)
sed -i '/checksum\/ingress:/d' "$work/solguficky-hub/templates/cloudflared/deployment.yaml"
assert_fails "a pod that a rules change would not roll" "cloudflared: pod template has no checksum/ingress annotation" "$work"

work=$(tree tunnel-rules-unmounted)
sed -i 's/^            name: "cloudflared-ingress"$/            name: "cloudflared-other"/' "$work/solguficky-hub/templates/cloudflared/deployment.yaml"
assert_fails "a tunnel that does not mount its rules" "cloudflared: pod does not mount the cloudflared-ingress ConfigMap" "$work"

work=$(tree bot-without-probes)
sed -i '/Probe:/,/port:/d' "$work/solguficky-hub/templates/hub-bot/deployment.yaml"
sed -i '/Probe:/,/port:/d' "$work/solguficky-hub/templates/auction-bot/deployment.yaml"
sed -i '/Probe:/,/port:/d' "$work/solguficky-hub/templates/support-bot/deployment.yaml"
assert_passes "the three bots are the workloads allowed without probes" "$work"

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
sed -i "s|hub-bot@$digest|hub-bot:latest|" "$work/solguficky-hub/templates/hub-bot/deployment.yaml"
sed -i "s|hub-bot@$digest|hub-bot:latest|" "$work/solguficky-hub/templates/auction-bot/deployment.yaml"
sed -i "s|hub-bot@$digest|hub-bot:latest|" "$work/solguficky-hub/templates/support-bot/deployment.yaml"
assert_fails "an image by tag" "hub-bot: image 'ghcr.io/solguficky/hub-bot:latest' is not pinned" "$work"

work=$(tree auction-bot-own-image)
sed -i "s|hub-bot@$digest|auction-bot@$digest|" "$work/solguficky-hub/templates/auction-bot/deployment.yaml"
assert_fails "the auction bot on an image of its own" "auction-bot: image ['ghcr.io/solguficky/auction-bot@$digest'] differs from hub-bot's" "$work"

work=$(tree support-bot-own-image)
sed -i "s|hub-bot@$digest|support-bot@$digest|" "$work/solguficky-hub/templates/support-bot/deployment.yaml"
assert_fails "the support bot on an image of its own" "support-bot: image ['ghcr.io/solguficky/support-bot@$digest'] differs from hub-bot's" "$work"

work=$(tree root)
sed -i '/runAsNonRoot/d' "$work/solguficky-hub/templates/identity/deployment.yaml"
assert_fails "a pod that may run as root" "identity: pod must set runAsNonRoot" "$work"

work=$(tree no-limits)
sed -i '/limits:/,/memory:/d' "$work/solguficky-hub/templates/meetups/deployment.yaml"
assert_fails "a container without limits" "meetups: container has no resource limits" "$work"

work=$(tree no-config-checksum)
sed -i '/checksum\/config:/d' "$work/solguficky-hub/templates/notifications/deployment.yaml"
assert_fails "a pod that a values change would not roll" "notifications: pod template has no checksum/config annotation" "$work"

work=$(tree no-readiness)
sed -i '/readinessProbe:/,/port:/d' "$work/solguficky-hub/templates/notifications/deployment.yaml"
assert_fails "a gRPC service without readiness" "notifications: no readinessProbe" "$work"

work=$(tree auction-without-liveness)
sed -i '/livenessProbe:/,/port:/d' "$work/solguficky-hub/templates/auction/deployment.yaml"
assert_fails "Auction without liveness" "auction: no livenessProbe" "$work"

work=$(tree auction-missing)
rm -r "$work/solguficky-hub/templates/auction"
assert_fails "Auction missing from the chart" "auction: chart service has no workload" "$work"

work=$(tree auction-liveness-on-readiness)
sed -i '/livenessProbe:/{n;s/tcpSocket:/httpGet:/}' "$work/solguficky-hub/templates/auction/deployment.yaml"
assert_fails "Auction liveness on the readiness path" "auction: livenessProbe must be tcpSocket, got httpGet" "$work"

work=$(tree grpc-probe-swapped)
sed -i '/readinessProbe:/{n;s/grpc:/httpGet:/}' "$work/solguficky-hub/templates/meetups/deployment.yaml"
assert_fails "a gRPC service with an HTTP readiness" "meetups: readinessProbe must be grpc, got httpGet" "$work"

work=$(tree leaked-build-step)
mkdir -p "$work/solguficky-hub/templates/identity-build"
deployment identity-build > "$work/solguficky-hub/templates/identity-build/deployment.yaml"
assert_fails "a leaked build step" "identity-build: workload is not one of the chart services" "$work"

work=$(tree stateful-infrastructure)
mkdir -p "$work/solguficky-hub/templates/postgres"
deployment postgres | sed 's/kind: "Deployment"/kind: "StatefulSet"/' > "$work/solguficky-hub/templates/postgres/statefulset.yaml"
assert_fails "PostgreSQL inside the chart" "postgres: workload kind StatefulSet" "$work"

work=$(tree missing-service)
rm -r "$work/solguficky-hub/templates/notifications"
assert_fails "a service missing from the chart" "notifications: chart service has no workload" "$work"

work=$(tree topology-post-hook)
sed -i '0,/pre-install,pre-upgrade/s//post-install,post-upgrade/' "$work/solguficky-hub/templates/jetstream-topology/jetstream-topology.yaml"
assert_fails "the topology Job as a post-hook" "jetstream-topology: Job must be a pre-install,pre-upgrade hook, got post-install,post-upgrade" "$work"

work=$(tree topology-input-not-hook)
sed -i '/^  name: "jetstream-topology-files"/{n;d}' "$work/solguficky-hub/templates/jetstream-topology/jetstream-topology.yaml"
sed -i '/^  name: "jetstream-topology-files"/{n;d}' "$work/solguficky-hub/templates/jetstream-topology/jetstream-topology.yaml"
assert_fails "a topology input outside the hook" "jetstream-topology: ConfigMap" "$work"

work=$(tree topology-input-same-weight)
sed -i 's/hook-weight: "-10"/hook-weight: "0"/' "$work/solguficky-hub/templates/jetstream-topology/jetstream-topology.yaml"
assert_fails "a topology input created no earlier than the Job" "jetstream-topology: ConfigMap jetstream-topology-files" "$work"

work=$(tree topology-input-missing)
sed -i '/^kind: "ConfigMap"/,$d' "$work/solguficky-hub/templates/jetstream-topology/jetstream-topology.yaml"
sed -i '$d' "$work/solguficky-hub/templates/jetstream-topology/jetstream-topology.yaml"
assert_fails "a topology Job reading an input the chart does not render" "jetstream-topology: Job reads jetstream-topology-files" "$work"

work=$(tree topology-restarts)
sed -i 's/restartPolicy: "Never"/restartPolicy: "OnFailure"/' "$work/solguficky-hub/templates/jetstream-topology/jetstream-topology.yaml"
assert_fails "a topology Job restarting in place" "jetstream-topology: Job pod must set restartPolicy: Never" "$work"

work=$(tree topology-missing)
rm -r "$work/solguficky-hub/templates/jetstream-topology"
assert_fails "the topology Job missing from the chart" "jetstream-topology: chart has no hook Job" "$work"

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
