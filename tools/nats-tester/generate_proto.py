#!/usr/bin/env python3
"""Generate Python code from protobuf definitions.

Compiled are the bus schemas and everything they import: a gRPC-only schema has
no subject, and its classes are dead weight in a tool that publishes and
subscribes. The set is derived from `nats_tester/proto_sources.py` — the same
list the gate compares the committed tree against. The import closure is part
of it: protoc writes an import of a dependency into the generated module, and
without that module the package does not import.
"""

import re
import subprocess
import sys
from pathlib import Path

from nats_tester.proto_sources import generated_modules, resolve_generation_set

# protoc resolves Python imports from the proto path, so a schema importing another
# schema of the same module emits `from identity.v1 import roles_pb2`. The generated
# tree lives inside a package, where that name does not exist. The rewrite below moves
# such imports under the package; the alias protoc puts after `as` stays untouched, so
# every use site keeps working.
PACKAGE_PREFIX = "nats_tester.generated"


def create_package_markers(output_dir: Path, proto_files: list[str]) -> None:
    """Make every generated directory an importable Python package."""
    for proto_file in proto_files:
        package_dir = output_dir / Path(proto_file).parent
        package_dir.mkdir(parents=True, exist_ok=True)
        current = package_dir
        while current != output_dir and output_dir in current.parents:
            init_file = current / "__init__.py"
            if not init_file.exists():
                init_file.write_text(
                    '"""Generated protobuf classes."""\n',
                    encoding="utf-8",
                    newline="\n",
                )
            current = current.parent


def module_roots(proto_files: list[str]) -> list[str]:
    """Top-level directories of the buf module: the names protoc writes into imports."""
    return sorted({Path(proto_file).parts[0] for proto_file in proto_files})


def rewrite_imports(output_dir: Path, roots: list[str]) -> list[Path]:
    """Move module-root imports under the generated package. Returns the changed files."""
    alternatives = "|".join(re.escape(root) for root in roots)
    from_import = re.compile(rf"^from ({alternatives})((?:\.\w+)*) import ", re.MULTILINE)
    plain_import = re.compile(rf"^import ({alternatives})((?:\.\w+)+) as ", re.MULTILINE)

    changed = []
    for generated in sorted(output_dir.rglob("*_pb2.py")):
        source = generated.read_text(encoding="utf-8")
        rewritten = from_import.sub(rf"from {PACKAGE_PREFIX}.\1\2 import ", source)
        rewritten = plain_import.sub(rf"import {PACKAGE_PREFIX}.\1\2 as ", rewritten)
        if rewritten != source:
            # newline="\n" keeps the tree identical between platforms: the CI
            # regeneration check compares the committed bytes, not the lines.
            generated.write_text(rewritten, encoding="utf-8", newline="\n")
            changed.append(generated)
    return changed


def find_unresolvable_imports(output_dir: Path, roots: list[str]) -> list[str]:
    """Imports still naming a module root: they raise ModuleNotFoundError at import time."""
    alternatives = "|".join(re.escape(root) for root in roots)
    leftover = re.compile(rf"^(?:from|import) (?:{alternatives})\b.*$", re.MULTILINE)
    return [
        f"{generated.relative_to(output_dir).as_posix()}: {line}"
        for generated in sorted(output_dir.rglob("*_pb2.py"))
        for line in leftover.findall(generated.read_text(encoding="utf-8"))
    ]


def prune_stale(output_dir: Path, expected: list[str]) -> list[str]:
    """Remove classes of schemas that left the generation set.

    A hardcoded list survives the deletion of the files it names; a generated
    module survives the deletion of its schema the same way, and keeps
    importing as if the contract still existed.
    """
    expected_files = set(expected)
    removed = []
    for generated in sorted(output_dir.rglob("*_pb2.py")):
        relative = generated.relative_to(output_dir).as_posix()
        if relative not in expected_files:
            generated.unlink()
            removed.append(relative)

    # A directory that kept no classes at all does not keep its package marker:
    # the marker would hold an empty package in the layout.
    directories = sorted(
        (path for path in output_dir.rglob("*") if path.is_dir()),
        key=lambda path: len(path.parts),
        reverse=True,
    )
    for directory in directories:
        if any(directory.rglob("*_pb2.py")):
            continue
        init_file = directory / "__init__.py"
        if init_file.exists():
            init_file.unlink()
        try:
            directory.rmdir()
        except OSError:
            # __pycache__ держит каталог, но пакетом он уже не является.
            pass

    return removed


def main():
    # Paths
    script_dir = Path(__file__).parent
    proto_dir = script_dir / "../../contracts/proto"
    output_dir = script_dir / "nats_tester/generated"

    # Resolve paths
    proto_dir = proto_dir.resolve()
    output_dir = output_dir.resolve()

    print(f"Proto directory: {proto_dir}")
    print(f"Output directory: {output_dir}")

    if not proto_dir.exists():
        print(f"[ERROR] Proto directory not found: {proto_dir}")
        sys.exit(1)

    # The set is derived, not listed: a list that names schemas would survive
    # their deletion and fail long after the fact.
    try:
        proto_files = resolve_generation_set(proto_dir)
    except FileNotFoundError as error:
        print(f"\n[ERROR] {error}")
        sys.exit(1)

    if not proto_files:
        # Схем шины не осталось — дерево обязано опустеть вместе с ними: иначе
        # гейт красный навсегда, а его подсказка «перегенерируй» ничего не
        # делает.
        output_dir.mkdir(parents=True, exist_ok=True)
        removed = prune_stale(output_dir, [])
        if removed:
            print("\n[*] Removed classes of schemas outside the generation set:")
            for generated in removed:
                print(f"  - {generated}")
        print("\n[SKIP] No bus schemas found. Nothing to generate.")
        sys.exit(0)

    print("\n[*] Found bus schemas and their imports:")
    for proto_file in proto_files:
        print(f"  - {proto_file}")

    # Create output directory and package markers
    output_dir.mkdir(parents=True, exist_ok=True)
    init_file = output_dir / "__init__.py"
    if not init_file.exists():
        init_file.write_text(
            '"""Generated protobuf classes."""\n', encoding="utf-8", newline="\n"
        )
    create_package_markers(output_dir, proto_files)

    print("\n[*] Compiling proto files...")

    # Run protoc
    cmd = [
        "protoc",
        f"--python_out={output_dir}",
        f"--proto_path={proto_dir}",
    ] + proto_files

    print(f"Running: {' '.join(cmd)}")
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as e:
        print("[ERROR] Failed to compile proto files:")
        print(e.stderr)
        sys.exit(1)
    except FileNotFoundError:
        print("[ERROR] protoc not found. Please install Protocol Buffers compiler.")
        print("   https://grpc.io/docs/protoc-installation/")
        sys.exit(1)

    print("[OK] Proto files compiled successfully!")
    print("\nGenerated files:")
    for generated in generated_modules(proto_files):
        print(f"  - {generated}")

    roots = module_roots(proto_files)
    changed = rewrite_imports(output_dir, roots)
    if changed:
        print("\n[*] Rewrote cross-schema imports under the package:")
        for generated in changed:
            print(f"  - {generated.relative_to(output_dir).as_posix()}")

    removed = prune_stale(output_dir, generated_modules(proto_files))
    if removed:
        print("\n[*] Removed classes of schemas outside the generation set:")
        for generated in removed:
            print(f"  - {generated}")

    leftover = find_unresolvable_imports(output_dir, roots)
    if leftover:
        print("\n[ERROR] Generated imports still name a module root:")
        for line in leftover:
            print(f"  - {line}")
        sys.exit(1)


if __name__ == "__main__":
    main()
