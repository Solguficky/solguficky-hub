#!/usr/bin/env python3
"""Generate Python code from protobuf definitions."""

import subprocess
import sys
from pathlib import Path

# Modules kept in the repository although their schemas were removed from
# contracts/proto together with the auction. They are frozen: regenerating
# will not reproduce them, and only legacy services still use these subjects.
FROZEN_PACKAGE = "nats"


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

    except subprocess.CalledProcessError as e:
        print("[ERROR] Failed to compile proto files:")
        print(e.stderr)
        sys.exit(1)
    except FileNotFoundError:
        print("[ERROR] protoc not found. Please install Protocol Buffers compiler.")
        print("   https://grpc.io/docs/protoc-installation/")
        sys.exit(1)

    if (output_dir / FROZEN_PACKAGE).exists():
        print(
            f"\n[NOTE] {FROZEN_PACKAGE}/ holds frozen classes: their schemas were "
            "removed from contracts/proto together with the auction and are not "
            "regenerated. Only legacy services still use those subjects."
        )


if __name__ == "__main__":
    main()
