#!/usr/bin/env python3
"""Checks the Helm chart that `aspire publish` generates from the AppHost graph.

`helm lint` checks the chart's form, not ADR-055: a chart with a leaked build
step, a second replica or a rolling update renders and lints clean, and the
defect shows only on the cluster. So the chart is rendered with a values
fixture in which every image is pinned by a synthetic digest, and each rendered
workload is checked against the rules of the production chart:

- the workloads are exactly the four MVP services, Auction, the auction bot,
  the support bot and the public entry tunnel, nothing else;
- every service runs one replica with the Recreate strategy and no rollingUpdate
  block, which the Kubernetes API rejects next to Recreate;
- the tunnel (ADR-071) runs one replica only where the environment's values set
  `enabled.cloudflared: true`, and none without the key: the chart is rendered
  twice, and the count is a `!!int`-tagged scalar, because a plain template in a
  number field is quoted by the generator and a quoted count is rejected by the
  Kubernetes API while helm stays silent;
- the tunnel passes only the hall screen routes: its mounted ingress rules are,
  character for character, the screen prefix to Auction's rendered `http`
  Service port and 404 for everything else, the pod rolls when they change,
  and its token never appears in the pod spec, as `--token` or as an inline
  TUNNEL_TOKEN: it comes from the Secret through envFrom;
- every image comes from values as `@sha256:<64 hex>`, not a tag;
- the auction and support bots run the hub bot's image, character for
  character: one package serves every surface (ADR-064, item 18; ADR-068,
  item 1), and an image of its own would let the bots drift apart under one
  name;
- the pod runs as non-root and the container has resource limits;
- the pod template carries checksums of the service's ConfigMap and Secret:
  the service reads them through envFrom, and without the checksums a values
  change or a rollback would not roll the pod;
- every service has liveness and readiness probes of its form: gRPC ones for
  the gRPC services; for Auction an HTTP readiness path and TCP startup and
  liveness, because its readiness path answers 503 while the database is down
  and a liveness on it would restart the pod in a loop; for the tunnel TCP
  only, because its `/ready` answers 200 only while Cloudflare is reachable,
  and a readiness on it would hold `helm --wait` of the whole release hostage
  to that network, while no Service routes to the tunnel. The three bots have no
  health endpoint and are the named exceptions;
- every secret in the chart's own values.yaml is empty: secrets are parameters
  without values, and the ops repository supplies them per environment;
- the one non-service workload is the JetStream topology Job: a pre-install and
  pre-upgrade Helm hook, because the services bind to their durables at start
  and a post-hook would wait for pods that never get ready without it. Its
  image is pinned by digest, it runs as non-root with limits and never
  restarts in place, and every object it reads is rendered as a hook of the
  same events with a lower weight: a pre-hook runs before the release's own
  objects exist, and Helm creates the hooks of one event in weight order.
  Equal weights fall back to Helm's kind order, which happens to put
  ConfigMap and Secret before Job; the rule states the order instead of
  leaning on that.

The fixture proves that the chart carries a digest through, not that a digest
is real: real digests live in the ops repository (ADR-055).

Usage:
  check-chart.py <chart-dir> <values-fixture>   render with helm, then check
  check-chart.py --rendered <dir>               check an already rendered tree
  check-chart.py --rendered-enabled <dir>       the same, rendered with the tunnel enabled
  check-chart.py --values <values.yaml>         check the chart's own values only
"""

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

WORKLOADS = {"identity", "meetups", "notifications", "hub-bot", "auction", "auction-bot", "support-bot", "cloudflared"}
# Workloads an environment switches on with `enabled.<key>: true` in its values.
SWITCHED = {"cloudflared": "cloudflared"}
TUNNEL = "cloudflared"
TUNNEL_RULES = "cloudflared-ingress"
TUNNEL_ORIGIN = "auction-service"
SCREEN_PATH = "^/screen/"
HOOK_JOBS = {"jetstream-topology"}
HOOK_EVENTS = "pre-install,pre-upgrade"
WITHOUT_PROBES = {"hub-bot", "auction-bot", "support-bot"}
SHARED_IMAGES = {"auction-bot": "hub-bot", "support-bot": "hub-bot"}
GRPC_PROBES = {"livenessProbe": "grpc", "readinessProbe": "grpc"}
HTTP_READINESS = {"startupProbe": "tcpSocket", "livenessProbe": "tcpSocket", "readinessProbe": "httpGet"}
TCP_ONLY = {"startupProbe": "tcpSocket", "livenessProbe": "tcpSocket", "readinessProbe": "tcpSocket"}
PROBES = {"auction": HTTP_READINESS, "cloudflared": TCP_ONLY}
PROBE_ACTIONS = ("grpc", "httpGet", "tcpSocket", "exec")
WORKLOAD_KINDS = {"Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob", "Pod"}

KIND = re.compile(r'^kind:\s*"?(\w+)"?\s*$', re.M)
NAME = re.compile(r'^  name:\s*"?([\w.-]+)"?\s*$', re.M)
REPLICAS = re.compile(r"^  replicas:\s*(.+?)\s*$", re.M)
STRATEGY = re.compile(r'^  strategy:\s*\n((?:    .*\n?)*)', re.M)
IMAGE = re.compile(r'^\s*(?:- )?image:\s*"?([^"\s]+)"?\s*$', re.M)
DIGEST = re.compile(r"@sha256:[0-9a-f]{64}$")
HOOK = re.compile(r'^    helm\.sh/hook:\s*"?([\w,-]+)"?\s*$', re.M)
WEIGHT = re.compile(r'^    helm\.sh/hook-weight:\s*"?(-?\d+)"?\s*$', re.M)
REFERENCE = re.compile(r'^\s*(?:- )?(?:configMap|secretRef|configMapRef|secret):\s*\n\s+(?:name|secretName):\s*"?([\w.-]+)"?\s*$', re.M)
COMPONENT = re.compile(r'^    app\.kubernetes\.io/component:\s*"?([\w.-]+)"?\s*$', re.M)
RULES_FILE = re.compile(r'^  config\.yml:\s*(".*")\s*$', re.M)
HTTP_PORT = re.compile(r'^\s*- name:\s*"?http"?\s*\n(?:\s+(?!- )\w+:.*\n)*?\s+port:\s*(\d+)\s*$', re.M)


def documents(rendered: Path):
    for path in sorted(rendered.rglob("*.yaml")):
        for text in re.split(r"^---\s*$", path.read_text(encoding="utf-8"), flags=re.M):
            if text.strip():
                yield path.relative_to(rendered), text


def expected_replicas(name: str, enabled: bool) -> str:
    if name not in SWITCHED:
        return "1"
    return '!!int "1"' if enabled else '!!int "0"'


def check_workload(name: str, text: str, enabled: bool = False) -> list[str]:
    errors = []
    replicas = REPLICAS.search(text)
    expected = expected_replicas(name, enabled)
    if not replicas or replicas.group(1) != expected:
        errors.append(f"{name}: replicas must be {expected}, got {replicas.group(1) if replicas else 'none'}")

    strategy = STRATEGY.search(text)
    block = strategy.group(1) if strategy else ""
    if not re.search(r'^    type:\s*"?Recreate"?\s*$', block, re.M):
        errors.append(f"{name}: strategy must be Recreate")
    if re.search(r"^    rollingUpdate:", block, re.M):
        errors.append(f"{name}: rollingUpdate next to Recreate is rejected by the Kubernetes API")

    errors.extend(check_pod(name, text))
    for checksum in ("checksum/config", "checksum/secrets"):
        if not re.search(rf'^\s+{re.escape(checksum)}:\s*"?[0-9a-f]{{64}}"?\s*$', text, re.M):
            errors.append(f"{name}: pod template has no {checksum} annotation, a values change would not roll the pod")

    if name not in WITHOUT_PROBES:
        for probe, expected in PROBES.get(name, GRPC_PROBES).items():
            action = probe_action(text, probe)
            if action is None:
                errors.append(f"{name}: no {probe}")
            elif action != expected:
                errors.append(f"{name}: {probe} must be {expected}, got {action}")
    return errors


def check_pod(name: str, text: str) -> list[str]:
    errors = []
    images = IMAGE.findall(text)
    if not images:
        errors.append(f"{name}: no image")
    for image in images:
        if not DIGEST.search(image):
            errors.append(f"{name}: image '{image}' is not pinned by @sha256 digest")

    if not re.search(r"^\s*runAsNonRoot:\s*true\s*$", text, re.M):
        errors.append(f"{name}: pod must set runAsNonRoot: true")
    if not re.search(r"^\s*limits:\s*$", text, re.M):
        errors.append(f"{name}: container has no resource limits")
    return errors


def check_hook_job(name: str, text: str) -> list[str]:
    errors = check_pod(name, text)
    hook = HOOK.search(text)
    if not hook or hook.group(1) != HOOK_EVENTS:
        errors.append(f"{name}: Job must be a {HOOK_EVENTS} hook, got {hook.group(1) if hook else 'no hook'}")
    if not re.search(r'^\s*restartPolicy:\s*"?Never"?\s*$', text, re.M):
        errors.append(f"{name}: Job pod must set restartPolicy: Never")
    return errors


def probe_action(text: str, probe: str) -> str | None:
    """The handler of a probe: the first action key among the lines nested under it."""
    block = re.search(rf"^([ -]*){probe}:\s*\n((?:\1\s+\S.*\n?)*)", text, re.M)
    if not block:
        return None
    actions = re.findall(rf"^\s*({'|'.join(PROBE_ACTIONS)}):", block.group(2), re.M)
    return actions[0] if actions else "none"


def hook_weight(text: str) -> int:
    """Helm reads a missing weight as 0."""
    weight = WEIGHT.search(text)
    return int(weight.group(1)) if weight else 0


def check_tunnel(text: str, rules: str | None, origin: str | None) -> list[str]:
    errors = []
    if not re.search(r'^\s+checksum/ingress:\s*"?[0-9a-f]{64}"?\s*$', text, re.M):
        errors.append(f"{TUNNEL}: pod template has no checksum/ingress annotation, a rules change would not roll the pod")
    if TUNNEL_RULES not in REFERENCE.findall(text):
        errors.append(f"{TUNNEL}: pod does not mount the {TUNNEL_RULES} ConfigMap")
    if "--token" in text or "TUNNEL_TOKEN" in text:
        errors.append(f"{TUNNEL}: the token must come from TUNNEL_TOKEN in the Secret through envFrom, not the pod spec")
    if rules is None:
        errors.append(f"{TUNNEL}: chart renders no {TUNNEL_RULES} ConfigMap with config.yml")
    elif origin is None:
        errors.append(f"{TUNNEL}: chart renders no {TUNNEL_ORIGIN} Service with an http port for the rules to reach")
    else:
        expected = f"ingress:\n  - path: {SCREEN_PATH}\n    service: http://{origin}\n  - service: http_status:404\n"
        if rules != expected:
            errors.append(f"{TUNNEL}: ingress rules must pass only {SCREEN_PATH} to {origin} and 404 the rest, got {rules!r}")
    return errors


def check_rendered(rendered: Path, enabled: bool = False) -> list[str]:
    errors = []
    found = {}
    images = {}
    inputs = {}
    jobs = {}
    workloads = {}
    rules = None
    origin = None
    for path, text in documents(rendered):
        kind = KIND.search(text)
        component = COMPONENT.search(text)
        object_name = NAME.search(text)
        if kind and kind.group(1) == "ConfigMap" and object_name and object_name.group(1) == TUNNEL_RULES:
            data = RULES_FILE.search(text)
            rules = json.loads(data.group(1)) if data else None
            continue
        if kind and kind.group(1) == "Service" and object_name and object_name.group(1) == TUNNEL_ORIGIN:
            port = HTTP_PORT.search(text)
            origin = f"{TUNNEL_ORIGIN}:{port.group(1)}" if port else None
            continue
        if component and component.group(1) in HOOK_JOBS and (not kind or kind.group(1) not in WORKLOAD_KINDS):
            hook = HOOK.search(text)
            if not hook or hook.group(1) != HOOK_EVENTS:
                errors.append(
                    f"{component.group(1)}: {kind.group(1) if kind else 'object'} in {path} must be a {HOOK_EVENTS} hook "
                    f"like its Job, got {hook.group(1) if hook else 'no hook'}")
            input_name = NAME.search(text)
            if input_name:
                inputs[input_name.group(1)] = (component.group(1), kind.group(1) if kind else "object", path, hook_weight(text))
            continue
        if not kind or kind.group(1) not in WORKLOAD_KINDS:
            continue
        name_match = NAME.search(text)
        raw = name_match.group(1) if name_match else f"<unnamed in {path}>"
        name = raw.removesuffix("-deployment")
        if name in HOOK_JOBS:
            if kind.group(1) != "Job":
                errors.append(f"{name}: workload kind {kind.group(1)}, expected a hook Job")
            if name in found:
                errors.append(f"{name}: rendered twice ({found[name]} and {path})")
            found[name] = path
            jobs[name] = (hook_weight(text), REFERENCE.findall(text))
            errors.extend(check_hook_job(name, text))
            continue
        if kind.group(1) != "Deployment":
            errors.append(f"{name}: workload kind {kind.group(1)}, expected Deployment")
        if name in found:
            errors.append(f"{name}: rendered twice ({found[name]} and {path})")
        found[name] = path
        images[name] = IMAGE.findall(text)
        workloads[name] = text
        if name in WORKLOADS:
            errors.extend(check_workload(name, text, enabled))

    if TUNNEL in workloads:
        errors.extend(check_tunnel(workloads[TUNNEL], rules, origin))

    for name in sorted(set(found) - WORKLOADS - HOOK_JOBS):
        errors.append(f"{name}: workload is not one of the chart services {sorted(WORKLOADS)}")
    for name in sorted(WORKLOADS - set(found)):
        errors.append(f"{name}: chart service has no workload")
    for name in sorted(HOOK_JOBS - set(found)):
        errors.append(f"{name}: chart has no hook Job")
    for name, owner in sorted(SHARED_IMAGES.items()):
        if name in images and owner in images and images[name] != images[owner]:
            errors.append(f"{name}: image {images[name]} differs from {owner}'s {images[owner]}, the two must run one image")
    for name, (weight, references) in sorted(jobs.items()):
        # A reference to an object the chart does not render passes helm and
        # leaves the pod in ContainerCreating until the Job's deadline.
        for reference in references:
            if reference not in inputs or inputs[reference][0] != name:
                errors.append(f"{name}: Job reads {reference}, which the chart does not render as its hook input")
    for input_name, (name, kind, path, weight) in sorted(inputs.items()):
        if name in jobs and weight >= jobs[name][0]:
            errors.append(
                f"{name}: {kind} {input_name} in {path} has hook weight {weight}, not below its Job's {jobs[name][0]}: "
                f"the order would rest on Helm's kind order alone")
    return errors


def check_values(values: Path) -> list[str]:
    """Every leaf under the top-level `secrets:` key must be an empty string."""
    errors = []
    inside = False
    path: list[str] = []
    for line in values.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        if indent == 0:
            inside = line.rstrip() == "secrets:"
            path = []
            continue
        if not inside:
            continue
        key, _, value = line.strip().partition(":")
        depth = indent // 2 - 1
        path = path[:depth] + [key]
        value = value.strip()
        if value and value not in ('""', "''"):
            errors.append(f"secret '{'.'.join(path)}' has a value in the chart's values.yaml")
    return errors


def render(chart: Path, values: Path, out: Path, extra: list[str]) -> None:
    subprocess.run(["helm", "lint", str(chart), "--strict", "-f", str(values), *extra], check=True)
    subprocess.run(
        ["helm", "template", "solguficky-hub", str(chart), "-f", str(values), *extra, "--output-dir", str(out)],
        check=True,
        stdout=subprocess.DEVNULL,
    )


def switched_on() -> list[str]:
    return [arg for key in SWITCHED.values() for arg in ("--set", f"enabled.{key}=true")]


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[0] == "--rendered":
        errors = check_rendered(Path(argv[1]))
    elif len(argv) == 2 and argv[0] == "--rendered-enabled":
        errors = check_rendered(Path(argv[1]), enabled=True)
    elif len(argv) == 2 and argv[0] == "--values":
        errors = check_values(Path(argv[1]))
    elif len(argv) == 2:
        # Twice: the tunnel stays off without its key, and on with it.
        with tempfile.TemporaryDirectory() as off, tempfile.TemporaryDirectory() as on:
            try:
                render(Path(argv[0]), Path(argv[1]), Path(off), [])
                render(Path(argv[0]), Path(argv[1]), Path(on), switched_on())
            except subprocess.CalledProcessError as error:
                print(f"check-chart: {' '.join(error.cmd[:2])} failed with exit code {error.returncode}", file=sys.stderr)
                return 1
            errors = check_values(Path(argv[0]) / "values.yaml") + check_rendered(Path(off)) \
                + check_rendered(Path(on), enabled=True)
    else:
        print(__doc__, file=sys.stderr)
        return 2

    for error in errors:
        print(f"check-chart: {error}", file=sys.stderr)
    if errors:
        return 1
    checked = "chart values have no secret values" if argv[0] == "--values" else \
        f"{len(WORKLOADS)} workloads and {len(HOOK_JOBS)} hook Job match the production chart rules"
    print(f"check-chart: {checked}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
