#!/usr/bin/env python3
"""Generate Python code from protobuf definitions."""

import re
import subprocess
import sys
from pathlib import Path

# protoc resolves Python imports from the proto path, so a schema importing another
# schema of the same module emits `from identity.v1 import roles_pb2`. The generated
# tree lives inside a package, where that name does not exist. The rewrite below moves
# such imports under the package; the alias protoc puts after `as` stays untouched, so
# every use site keeps working.
PACKAGE_PREFIX = "nats_tester.generated"


def discover_proto_files(proto_dir: Path) -> list[str]:
    """Return proto paths relative to the buf module root, sorted."""
    return sorted(
        p.relative_to(proto_dir).as_posix()
        for p in proto_dir.rglob("*.proto")
    )


def create_package_markers(output_dir: Path, proto_files: list[str]) -> None:
    """Make every generated directory an importable Python package."""
    for proto_file in proto_files:
        package_dir = output_dir / Path(proto_file).parent
        package_dir.mkdir(parents=True, exist_ok=True)
        current = package_dir
        while current != output_dir and output_dir in current.parents:
            init_file = current / "__init__.py"
            if not init_file.exists():
                init_file.write_text('"""Generated protobuf classes."""\n')
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
            generated.write_text(rewritten, encoding="utf-8")
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

    # Schemas are discovered, not listed: a hardcoded list survives the
    # deletion of the files it names and fails long after the fact.
    proto_files = discover_proto_files(proto_dir)

    if not proto_files:
        print("\n[SKIP] No .proto files found. Nothing to generate.")
        sys.exit(0)

    print("\n[*] Found proto files:")
    for proto_file in proto_files:
        print(f"  - {proto_file}")

    # Create output directory and package markers
    output_dir.mkdir(parents=True, exist_ok=True)
    init_file = output_dir / "__init__.py"
    if not init_file.exists():
        init_file.write_text('"""Generated protobuf classes."""\n')
    create_package_markers(output_dir, proto_files)

    print("\n[*] Compiling proto files...")

    # Run protoc
    try:
        cmd = [
            "protoc",
            f"--python_out={output_dir}",
            f"--proto_path={proto_dir}",
        ] + proto_files

        print(f"Running: {' '.join(cmd)}")
        subprocess.run(cmd, check=True, capture_output=True, text=True)

        print("[OK] Proto files compiled successfully!")
        print("\nGenerated files:")
        for proto_file in proto_files:
            py_file = Path(proto_file).with_name(Path(proto_file).stem + "_pb2.py")
            print(f"  - {py_file.as_posix()}")

        roots = module_roots(proto_files)
        changed = rewrite_imports(output_dir, roots)
        if changed:
            print("\n[*] Rewrote cross-schema imports under the package:")
            for generated in changed:
                print(f"  - {generated.relative_to(output_dir).as_posix()}")

        leftover = find_unresolvable_imports(output_dir, roots)
        if leftover:
            print("\n[ERROR] Generated imports still name a module root:")
            for line in leftover:
                print(f"  - {line}")
            sys.exit(1)

    except subprocess.CalledProcessError as e:
        print("[ERROR] Failed to compile proto files:")
        print(e.stderr)
        sys.exit(1)
    except FileNotFoundError:
        print("[ERROR] protoc not found. Please install Protocol Buffers compiler.")
        print("   https://grpc.io/docs/protoc-installation/")
        sys.exit(1)


if __name__ == "__main__":
    main()
