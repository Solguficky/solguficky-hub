#!/usr/bin/env python3
"""Generate Python code from protobuf definitions."""

import subprocess
import sys
from pathlib import Path

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

    # Create output directory
    output_dir.mkdir(parents=True, exist_ok=True)

    # Create __init__.py
    init_file = output_dir / "__init__.py"
    init_file.write_text('"""Generated protobuf classes."""\n')

    # Proto files to compile
    proto_files = [
        "nats/events/auction_events.proto",
        "nats/commands/telegram_commands.proto",
        "nats/commands/auction_commands.proto",
    ]

    print("\n[*] Compiling proto files...")

    # Run protoc
    try:
        cmd = [
            "protoc",
            f"--python_out={output_dir}",
            f"--proto_path={proto_dir}",
        ] + proto_files

        print(f"Running: {' '.join(cmd)}")
        result = subprocess.run(cmd, check=True, capture_output=True, text=True)

        print("[OK] Proto files compiled successfully!")
        print(f"\nGenerated files:")
        for proto_file in proto_files:
            py_file = Path(proto_file).stem + "_pb2.py"
            print(f"  - {py_file}")

    except subprocess.CalledProcessError as e:
        print(f"[ERROR] Failed to compile proto files:")
        print(e.stderr)
        sys.exit(1)
    except FileNotFoundError:
        print("[ERROR] protoc not found. Please install Protocol Buffers compiler.")
        print("   https://grpc.io/docs/protoc-installation/")
        sys.exit(1)

if __name__ == "__main__":
    main()

