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
- every service has liveness and readiness probes of its form: gRPC ones for
  the gRPC services; for Auction an HTTP readiness path and TCP startup and
  liveness, because its readiness path answers 503 while the database is down
  and a liveness on it would restart the pod in a loop. The bot has no health
  endpoint and is the one named exception;
- every secret in the chart's own values.yaml is empty: secrets are parameters
  without values, and the ops repository supplies them per environment.

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

    if name not in WITHOUT_PROBES:
        for probe, expected in PROBES.get(name, GRPC_PROBES).items():
            action = probe_action(text, probe)
            if action is None:
                errors.append(f"{name}: no {probe}")
            elif action != expected:
                errors.append(f"{name}: {probe} must be {expected}, got {action}")
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
        if not kind or kind.group(1) not in WORKLOAD_KINDS:
            continue
        name_match = NAME.search(text)
        raw = name_match.group(1) if name_match else f"<unnamed in {path}>"
        name = raw.removesuffix("-deployment")
        if kind.group(1) != "Deployment":
            errors.append(f"{name}: workload kind {kind.group(1)}, expected Deployment")
        if name in found:
            errors.append(f"{name}: rendered twice ({found[name]} and {path})")
        found[name] = path
        if name in WORKLOADS:
            errors.extend(check_workload(name, text))

    for name in sorted(set(found) - WORKLOADS):
        errors.append(f"{name}: workload is not one of the chart services {sorted(WORKLOADS)}")
    for name in sorted(WORKLOADS - set(found)):
        errors.append(f"{name}: chart service has no workload")
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
        f"{len(WORKLOADS)} workloads match the production chart rules"
    print(f"check-chart: {checked}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
