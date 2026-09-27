"""Verify appHost.path in aspire.config.json names an existing Aspire AppHost.

Aspire CLI finds the AppHost to run through `appHost.path` in the root
aspire.config.json. No build reads that file: the apphost and contour jobs
call the csproj directly, so a typo in the path stays green everywhere and
surfaces only when a person runs `aspire run`. This check closes that gap
statically - no Aspire CLI, no Docker, no build.

The path must be relative, stay inside the repository (symlinks resolved),
match the tree in case, since CI runs on a case-sensitive file system, and
point at a .csproj that declares Aspire.AppHost.Sdk in any of the three
MSBuild forms: the `Sdk` attribute of `<Project>`
(`Microsoft.NET.Sdk;Aspire.AppHost.Sdk/13.5.3`), an element
`<Sdk Name="Aspire.AppHost.Sdk" ... />` or `<Import Sdk="Aspire.AppHost.Sdk" ...>`,
the last two as direct children of `<Project>`. A file-based
AppHost (apphost.cs) is not a project and is rejected; the repository has
none, and adopting one is a decision that updates this check.

The repository root is the current directory, as in check-doc-links.py: the
fixture test runs the check inside its own trees. stdlib only, so the gate
needs no install step.
"""

import json
import os
import sys
import xml.etree.ElementTree as ET

CONFIG = "aspire.config.json"
SDK = "Aspire.AppHost.Sdk"


def local_name(tag):
    return tag.rsplit("}", 1)[-1]


def names_sdk(value):
    """True when an Sdk attribute value lists the AppHost SDK.

    The value is `Name`, `Name/Version` or several of them joined by `;`.
    SDK names resolve as NuGet ids, which are case-insensitive.
    """
    names = (part.split("/", 1)[0].strip().lower() for part in value.split(";"))
    return SDK.lower() in names


def declares_apphost_sdk(project):
    root = ET.parse(project).getroot()
    if local_name(root.tag) != "Project":
        return False
    if names_sdk(root.get("Sdk", "")):
        return True
    # Only direct children of <Project> count: MSBuild does not evaluate
    # nested XML such as <ProjectExtensions>, so an Sdk there declares nothing.
    for el in root:
        tag = local_name(el.tag) if isinstance(el.tag, str) else ""
        if tag == "Sdk" and names_sdk(el.get("Name", "")):
            return True
        if tag == "Import" and names_sdk(el.get("Sdk", "")):
            return True
    return False


def exists_with_exact_case(path):
    """os.path.isfile, but case-sensitive on Windows and macOS too.

    CI runs on Linux, so a path whose case differs from the tree would pass
    locally and fail there.
    """
    if not os.path.isfile(path):
        return False
    current = "."
    for part in path.split("/"):
        if part in ("", "."):
            continue
        if part != ".." and part not in os.listdir(current):
            return False
        current = os.path.join(current, part)
    return True


def check():
    try:
        # utf-8-sig: a Windows editor may save the file with a BOM, and the
        # CLI reads it through .NET, which skips the BOM.
        with open(CONFIG, encoding="utf-8-sig") as f:
            config = json.load(f)
    except FileNotFoundError:
        return f"{CONFIG}: file not found"
    except json.JSONDecodeError as e:
        return f"{CONFIG}: not valid JSON: {e}"

    app_host = config.get("appHost") if isinstance(config, dict) else None
    path = app_host.get("path") if isinstance(app_host, dict) else None
    if not isinstance(path, str) or not path:
        return f"{CONFIG}: appHost.path is missing"

    # The config is shared across Windows and Linux checkouts, so only the
    # portable form is accepted.
    if "\\" in path:
        return f"{CONFIG}: appHost.path must use forward slashes: {path}"
    if os.path.isabs(path) or path.startswith("/") or os.path.splitdrive(path)[0]:
        return f"{CONFIG}: appHost.path must be relative to the repository root: {path}"
    root = os.path.realpath(".")
    if os.path.commonpath([root, os.path.realpath(path)]) != root:
        return f"{CONFIG}: appHost.path leaves the repository: {path}"
    if not path.endswith(".csproj"):
        return f"{CONFIG}: appHost.path is not a .csproj project: {path}"

    if not exists_with_exact_case(path):
        return f"{CONFIG}: appHost.path not found: {path}"

    try:
        is_apphost = declares_apphost_sdk(path)
    except ET.ParseError as e:
        return f"{CONFIG}: appHost.path is not an MSBuild project: {path}: {e}"
    if not is_apphost:
        return f"{CONFIG}: appHost.path is not an AppHost, no {SDK}: {path}"

    return None


def main():
    error = check()
    if error:
        print(error, file=sys.stderr)
        return 1
    print(f"{CONFIG}: appHost.path is an AppHost")
    return 0


if __name__ == "__main__":
    sys.exit(main())
