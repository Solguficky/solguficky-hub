"""Main CLI interface for NATS testing tool."""

import json
import subprocess
import sys
from pathlib import Path
from typing import Optional

import click


@click.group()
@click.version_option()
def cli():
    """NATS Testing Tool for Solguficky microservices.

    Test your NATS-based microservices by publishing events and subscribing to commands.

    Examples:

        # Publish an event
        nats-tester publish samples/bid_placed_with_previous.json

        # Subscribe to commands
        nats-tester subscribe

        # Run full test
        nats-tester test
    """
    pass


@cli.command()
@click.argument('json_file', type=click.Path(exists=True))
@click.option('--nats-url', default='nats://localhost:4222',
              help='NATS server URL')
@click.option('--subject', default='events.auction.bid_placed',
              help='NATS subject to publish to')
@click.option('--proto-path',
              default='../../contracts/proto',
              help='Path to proto files directory')
def publish(json_file: str, nats_url: str, subject: str, proto_path: str):
    """Publish event from JSON file to NATS.

    Reads JSON file, encodes it to Protobuf, and publishes to NATS.

    \b
    Example:
        nats-tester publish samples/bid_placed_with_previous.json
        nats-tester publish samples/my_event.json --subject events.auction.lot_sold
    """
    click.echo(click.style("📦 Publishing event to NATS", fg='cyan', bold=True))
    click.echo(f"   JSON file: {json_file}")
    click.echo(f"   NATS URL:  {nats_url}")
    click.echo(f"   Subject:   {subject}")
    click.echo()

    # Check if tools are installed
    if not _check_tool('protoc'):
        click.secho("❌ protoc not found. Please install Protocol Buffers compiler.", fg='red')
        click.echo("   https://grpc.io/docs/protoc-installation/")
        sys.exit(1)

    if not _check_tool('nats'):
        click.secho("❌ nats CLI not found. Please install NATS CLI.", fg='red')
        click.echo("   go install github.com/nats-io/natscli/nats@latest")
        sys.exit(1)

    # Read and validate JSON
    try:
        with open(json_file, 'r', encoding='utf-8') as f:
            data = json.load(f)

        click.echo(f"✓ Loaded JSON: event_id={data.get('event_id', 'N/A')}")
    except json.JSONDecodeError as e:
        click.secho(f"❌ Invalid JSON: {e}", fg='red')
        sys.exit(1)
    except Exception as e:
        click.secho(f"❌ Error reading file: {e}", fg='red')
        sys.exit(1)

    # Resolve proto path
    proto_dir = Path(__file__).parent.parent / proto_path
    if not proto_dir.exists():
        click.secho(f"❌ Proto directory not found: {proto_dir}", fg='red')
        sys.exit(1)

    # Encode JSON to Protobuf
    try:
        click.echo("✓ Encoding to Protobuf...")

        protoc_result = subprocess.run(
            [
                'protoc',
                '--encode=nats.events.BidPlacedEvent',
                f'--proto_path={proto_dir}',
                'nats/events/auction_events.proto'
            ],
            input=json.dumps(data),
            capture_output=True,
            text=True,
            check=True
        )

        protobuf_data = protoc_result.stdout
        size = len(protobuf_data.encode())
        click.echo(f"✓ Encoded: {size} bytes")

    except subprocess.CalledProcessError as e:
        click.secho(f"❌ Failed to encode Protobuf: {e.stderr}", fg='red')
        sys.exit(1)

    # Publish to NATS
    try:
        click.echo("✓ Publishing to NATS...")

        subprocess.run(
            [
                'nats', 'pub', subject,
                '--server', nats_url
            ],
            input=protobuf_data,
            check=True,
            capture_output=True
        )

        click.echo()
        click.secho("✅ Event published successfully!", fg='green', bold=True)

    except subprocess.CalledProcessError as e:
        click.secho(f"❌ Failed to publish to NATS: {e}", fg='red')
        sys.exit(1)


@cli.command()
@click.option('--nats-url', default='nats://localhost:4222',
              help='NATS server URL')
@click.option('--subject', default='commands.telegram.>',
              help='NATS subject pattern to subscribe to')
@click.option('--proto-path',
              default='../../contracts/proto',
              help='Path to proto files directory')
def subscribe(nats_url: str, subject: str, proto_path: str):
    """Subscribe to NATS commands and decode them.

    Subscribes to NATS subject, decodes Protobuf messages and displays as text.
    Press Ctrl+C to stop.

    \b
    Example:
        nats-tester subscribe
        nats-tester subscribe --subject "commands.telegram.send_message"
    """
    click.echo(click.style("👂 Subscribing to NATS commands", fg='cyan', bold=True))
    click.echo(f"   NATS URL: {nats_url}")
    click.echo(f"   Subject:  {subject}")
    click.echo(f"   Press Ctrl+C to stop")
    click.echo()
    click.echo("─" * 60)
    click.echo()

    # Check tools
    if not _check_tool('nats'):
        click.secho("❌ nats CLI not found", fg='red')
        sys.exit(1)

    if not _check_tool('protoc'):
        click.secho("❌ protoc not found", fg='red')
        sys.exit(1)

    # Resolve proto path
    proto_dir = Path(__file__).parent.parent / proto_path
    if not proto_dir.exists():
        click.secho(f"❌ Proto directory not found: {proto_dir}", fg='red')
        sys.exit(1)

    # Subscribe to NATS and decode messages
    try:
        nats_process = subprocess.Popen(
            ['nats', 'sub', subject, '--server', nats_url, '--raw'],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=False
        )

        message_count = 0

        while True:
            line = nats_process.stdout.readline()
            if not line:
                break

            line_str = line.decode('utf-8', errors='ignore').strip()

            # Check if this is a message header
            if line_str.startswith('[#') and 'Received on' in line_str:
                message_count += 1
                click.echo(click.style(f"📨 Message #{message_count}", fg='yellow'))
                click.echo(f"   {line_str}")

            elif line_str and not line_str.startswith('Listening'):
                # Try to decode as Protobuf
                try:
                    protoc_result = subprocess.run(
                        [
                            'protoc',
                            '--decode=nats.commands.SendMessageCommand',
                            f'--proto_path={proto_dir}',
                            'nats/commands/telegram_commands.proto'
                        ],
                        input=line,
                        capture_output=True,
                        text=True
                    )

                    if protoc_result.returncode == 0:
                        click.echo(click.style("   Decoded:", fg='green'))
                        for decoded_line in protoc_result.stdout.split('\n'):
                            if decoded_line.strip():
                                click.echo(f"   {decoded_line}")
                    else:
                        click.secho("   ❌ Failed to decode", fg='red')

                except Exception as e:
                    click.secho(f"   ❌ Decode error: {e}", fg='red')

                click.echo()
                click.echo("─" * 60)
                click.echo()

    except KeyboardInterrupt:
        click.echo()
        click.secho(f"✅ Stopped. Received {message_count} messages.", fg='green')
        if nats_process:
            nats_process.terminate()
    except Exception as e:
        click.secho(f"❌ Error: {e}", fg='red')
        sys.exit(1)


@cli.command()
@click.option('--nats-url', default='nats://localhost:4222',
              help='NATS server URL')
def test(nats_url: str):
    """Run integration test.

    Publishes a test event with previous_leader_id and shows how to verify.

    \b
    Example:
        nats-tester test
    """
    click.echo(click.style("🧪 Running integration test", fg='cyan', bold=True))
    click.echo()

    # Find sample file
    sample_file = Path(__file__).parent.parent / 'samples' / 'bid_placed_with_previous.json'

    if not sample_file.exists():
        click.secho(f"❌ Sample file not found: {sample_file}", fg='red')
        sys.exit(1)

    click.echo("1️⃣  Publishing test event with previous_leader_id...")
    click.echo()

    # Trigger publish command
    ctx = click.get_current_context()
    ctx.invoke(publish, json_file=str(sample_file), nats_url=nats_url,
               subject='events.auction.bid_placed', proto_path='../../contracts/proto')

    click.echo()
    click.secho("✅ Test event published!", fg='green', bold=True)
    click.echo()
    click.echo("💡 To verify the result, run in another terminal:")
    click.echo(click.style("   nats-tester subscribe", fg='yellow'))
    click.echo()
    click.echo("Expected output:")
    click.echo("   chat_id: 123")
    click.echo("   text: \"❗ Ваша ставка в 100 рублей...\"")
    click.echo("   parse_mode: \"\"")


@cli.command()
def check():
    """Check if required tools are installed.

    Verifies that protoc and nats CLI are available.
    """
    click.echo(click.style("🔍 Checking required tools", fg='cyan', bold=True))
    click.echo()

    all_ok = True

    # Check protoc
    if _check_tool('protoc'):
        version = _get_tool_version('protoc', ['--version'])
        click.secho(f"✅ protoc: {version}", fg='green')
    else:
        click.secho("❌ protoc: not found", fg='red')
        click.echo("   Install: https://grpc.io/docs/protoc-installation/")
        all_ok = False

    # Check nats
    if _check_tool('nats'):
        version = _get_tool_version('nats', ['--version'])
        click.secho(f"✅ nats:   {version}", fg='green')
    else:
        click.secho("❌ nats:   not found", fg='red')
        click.echo("   Install: go install github.com/nats-io/natscli/nats@latest")
        all_ok = False

    click.echo()
    if all_ok:
        click.secho("✅ All tools installed!", fg='green', bold=True)
    else:
        click.secho("⚠️  Some tools are missing", fg='yellow', bold=True)
        sys.exit(1)


@cli.command()
@click.argument('json_file', type=click.Path(exists=True))
@click.option('--proto-path',
              default='../../contracts/proto',
              help='Path to proto files directory')
def validate(json_file: str, proto_path: str):
    """Validate JSON file against Protobuf schema.

    Attempts to encode the JSON to verify it matches the expected schema.

    \b
    Example:
        nats-tester validate samples/bid_placed_with_previous.json
    """
    click.echo(f"🔍 Validating {json_file}")

    if not _check_tool('protoc'):
        click.secho("❌ protoc not found", fg='red')
        sys.exit(1)

    # Resolve proto path
    proto_dir = Path(__file__).parent.parent / proto_path

    try:
        with open(json_file, 'r', encoding='utf-8') as f:
            data = json.load(f)

        result = subprocess.run(
            [
                'protoc',
                '--encode=nats.events.BidPlacedEvent',
                f'--proto_path={proto_dir}',
                'nats/events/auction_events.proto'
            ],
            input=json.dumps(data),
            capture_output=True,
            text=True
        )

        if result.returncode == 0:
            click.secho("✅ Valid JSON structure!", fg='green')
        else:
            click.secho("❌ Invalid JSON structure:", fg='red')
            click.echo(result.stderr)
            sys.exit(1)

    except json.JSONDecodeError as e:
        click.secho(f"❌ Invalid JSON: {e}", fg='red')
        sys.exit(1)
    except Exception as e:
        click.secho(f"❌ Error: {e}", fg='red')
        sys.exit(1)


def _check_tool(tool_name: str) -> bool:
    """Check if a command-line tool is available."""
    try:
        subprocess.run([tool_name, '--version'],
                      capture_output=True, check=True)
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


def _get_tool_version(tool_name: str, args: list) -> str:
    """Get version string of a tool."""
    try:
        result = subprocess.run([tool_name] + args,
                              capture_output=True, text=True)
        return result.stdout.strip() or result.stderr.strip()
    except Exception:
        return "unknown version"


if __name__ == '__main__':
    cli()

