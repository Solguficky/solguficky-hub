#!/usr/bin/env python3
"""Checks the Helm chart that `aspire publish` generates from the AppHost graph.

`helm lint` checks the chart's form, not ADR-055: a chart with a leaked build
step, a second replica or a rolling update renders and lints clean, and the
defect shows only on the cluster. So the chart is rendered with a values
fixture in which every image is pinned by a synthetic digest, and each rendered
workload is checked against the rules of the production chart:

- the workloads are exactly the four MVP services and Auction, nothing else;
- every service runs one replica with the Recreate strategy and no rollingUpdate
  block, which the Kubernetes API rejects next to Recreate;
- every image comes from values as `@sha256:<64 hex>`, not a tag;
- the pod runs as non-root and the container has resource limits;
- the pod template carries checksums of the service's ConfigMap and Secret:
  the service reads them through envFrom, and without the checksums a values
  change or a rollback would not roll the pod;
- every service has liveness and readiness probes of its form: gRPC ones for
  the gRPC services; for Auction an HTTP readiness path and TCP startup and
  liveness, because its readiness path answers 503 while the database is down
  and a liveness on it would restart the pod in a loop. The bot has no health
  endpoint and is the one named exception;
- every secret in the chart's own values.yaml is empty: secrets are parameters
  without values, and the ops repository supplies them per environment;
- the one non-service workload is the JetStream topology Job: a pre-install and
  pre-upgrade Helm hook, because the services bind to their durables at start
  and a post-hook would wait for pods that never get ready without it. Its
  image is pinned by digest, it runs as non-root with limits and never
  restarts in place, and every object it reads is a hook of the same events:
  a pre-hook runs before the release's own objects exist.

The fixture proves that the chart carries a digest through, not that a digest
is real: real digests live in the ops repository (ADR-055).

Usage:
  check-chart.py <chart-dir> <values-fixture>   render with helm, then check
  check-chart.py --rendered <dir>               check an already rendered tree
  check-chart.py --values <values.yaml>         check the chart's own values only
"""

import re
import subprocess
import sys
import tempfile
from pathlib import Path

WORKLOADS = {"identity", "meetups", "notifications", "hub-bot", "auction"}
HOOK_JOBS = {"jetstream-topology"}
HOOK_EVENTS = "pre-install,pre-upgrade"
WITHOUT_PROBES = {"hub-bot"}
GRPC_PROBES = {"livenessProbe": "grpc", "readinessProbe": "grpc"}
PROBES = {"auction": {"startupProbe": "tcpSocket", "livenessProbe": "tcpSocket", "readinessProbe": "httpGet"}}
PROBE_ACTIONS = ("grpc", "httpGet", "tcpSocket", "exec")
WORKLOAD_KINDS = {"Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob", "Pod"}

KIND = re.compile(r'^kind:\s*"?(\w+)"?\s*$', re.M)
NAME = re.compile(r'^  name:\s*"?([\w.-]+)"?\s*$', re.M)
REPLICAS = re.compile(r"^  replicas:\s*(\d+)\s*$", re.M)
STRATEGY = re.compile(r'^  strategy:\s*\n((?:    .*\n?)*)', re.M)
IMAGE = re.compile(r'^\s*(?:- )?image:\s*"?([^"\s]+)"?\s*$', re.M)
DIGEST = re.compile(r"@sha256:[0-9a-f]{64}$")
HOOK = re.compile(r'^    helm\.sh/hook:\s*"?([\w,-]+)"?\s*$', re.M)
COMPONENT = re.compile(r'^    app\.kubernetes\.io/component:\s*"?([\w.-]+)"?\s*$', re.M)


def documents(rendered: Path):
    for path in sorted(rendered.rglob("*.yaml")):
        for text in re.split(r"^---\s*$", path.read_text(encoding="utf-8"), flags=re.M):
            if text.strip():
                yield path.relative_to(rendered), text


def check_workload(name: str, text: str) -> list[str]:
    errors = []
    replicas = REPLICAS.search(text)
    if not replicas or replicas.group(1) != "1":
        errors.append(f"{name}: replicas must be 1, got {replicas.group(1) if replicas else 'none'}")

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


def check_rendered(rendered: Path) -> list[str]:
    errors = []
    found = {}
    for path, text in documents(rendered):
        kind = KIND.search(text)
        component = COMPONENT.search(text)
        if component and component.group(1) in HOOK_JOBS and (not kind or kind.group(1) not in WORKLOAD_KINDS):
            hook = HOOK.search(text)
            if not hook or hook.group(1) != HOOK_EVENTS:
                errors.append(
                    f"{component.group(1)}: {kind.group(1) if kind else 'object'} in {path} must be a {HOOK_EVENTS} hook "
                    f"like its Job, got {hook.group(1) if hook else 'no hook'}")
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
            errors.extend(check_hook_job(name, text))
            continue
        if kind.group(1) != "Deployment":
            errors.append(f"{name}: workload kind {kind.group(1)}, expected Deployment")
        if name in found:
            errors.append(f"{name}: rendered twice ({found[name]} and {path})")
        found[name] = path
        if name in WORKLOADS:
            errors.extend(check_workload(name, text))

    for name in sorted(set(found) - WORKLOADS - HOOK_JOBS):
        errors.append(f"{name}: workload is not one of the chart services {sorted(WORKLOADS)}")
    for name in sorted(WORKLOADS - set(found)):
        errors.append(f"{name}: chart service has no workload")
    for name in sorted(HOOK_JOBS - set(found)):
        errors.append(f"{name}: chart has no hook Job")
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


def render(chart: Path, values: Path, out: Path) -> None:
    subprocess.run(["helm", "lint", str(chart), "--strict", "-f", str(values)], check=True)
    subprocess.run(
        ["helm", "template", "solguficky-hub", str(chart), "-f", str(values), "--output-dir", str(out)],
        check=True,
        stdout=subprocess.DEVNULL,
    )


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[0] == "--rendered":
        errors = check_rendered(Path(argv[1]))
    elif len(argv) == 2 and argv[0] == "--values":
        errors = check_values(Path(argv[1]))
    elif len(argv) == 2:
        with tempfile.TemporaryDirectory() as out:
            try:
                render(Path(argv[0]), Path(argv[1]), Path(out))
            except subprocess.CalledProcessError as error:
                print(f"check-chart: {' '.join(error.cmd[:2])} failed with exit code {error.returncode}", file=sys.stderr)
                return 1
            errors = check_values(Path(argv[0]) / "values.yaml") + check_rendered(Path(out))
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
