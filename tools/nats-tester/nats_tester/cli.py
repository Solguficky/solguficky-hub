"""Main CLI interface for NATS testing tool."""

import asyncio
import json
import subprocess
import sys
from typing import Optional

import click
from google.protobuf import json_format
from google.protobuf.message import DecodeError
import nats

from nats_tester import gate
from nats_tester.registry import ALL_MESSAGE_TYPES, COMMAND_TYPES, EVENT_TYPES

try:
    from uuid import uuid7  # Python 3.14+
except ImportError:
    from uuid6 import uuid7


@click.group()
@click.version_option()
def cli():
    """NATS Testing Tool for Solguficky microservices.

    Test your NATS-based microservices by publishing events and subscribing to commands.

    Examples:

        # Show which subjects the tool knows
        nats-tester list-types

        # Publish a message from JSON
        nats-tester publish message.json --subject commands.example.do

        # Watch everything on the bus
        nats-tester subscribe

        # Read a durable JetStream consumer, flagging repeats by event_id
        nats-tester consume --stream MEETUPS_EVENTS --durable nats-tester-meetups-events
    """
    pass


@cli.command()
@click.argument('json_file', type=click.Path(exists=True))
@click.option('--nats-url', default='nats://localhost:4222',
              help='NATS server URL')
@click.option('--subject', required=True,
              help='NATS subject to publish to')
@click.option('--event-type',
              help='Message type (auto-detected from subject if not specified)')
@click.option('--msg-id',
              help='Nats-Msg-Id header; defaults to event_id from the JSON')
@click.option('--no-msg-id', is_flag=True,
              help='Publish without Nats-Msg-Id, bypassing JetStream server-side dedup')
def publish(json_file: str, nats_url: str, subject: str, event_type: Optional[str],
            msg_id: Optional[str], no_msg_id: bool):
    """Publish event from JSON file to NATS.

    Reads JSON file, encodes it to Protobuf, and publishes to NATS.
    Automatically detects event type from subject or use --event-type to specify.

    \b
    Example:
        nats-tester publish message.json --subject commands.example.do
        nats-tester list-types  # Show all registered subjects
    """
    click.echo(click.style("📦 Publishing event to NATS", fg='cyan', bold=True))
    click.echo(f"   JSON file: {json_file}")
    click.echo(f"   NATS URL:  {nats_url}")
    click.echo(f"   Subject:   {subject}")
    click.echo()

    # Check if nats CLI is installed
    if not _check_tool('nats'):
        click.secho("❌ nats CLI not found. Please install NATS CLI.", fg='red')
        click.echo("   go install github.com/nats-io/natscli/nats@latest")
        sys.exit(1)

    # Determine event type
    if not event_type:
        event_type = subject

    if event_type not in ALL_MESSAGE_TYPES:
        click.secho(f"❌ Unknown message type for subject: {subject}", fg='red')
        click.echo(f"   Supported subjects:")
        for s in ALL_MESSAGE_TYPES.keys():
            click.echo(f"     - {s}")
        click.echo()
        click.echo(f"   Run 'nats-tester list-types' to see all supported types")
        sys.exit(1)

    message_class = ALL_MESSAGE_TYPES[event_type]
    click.echo(f"✓ Event type: {message_class.DESCRIPTOR.name}")

    # Read and validate JSON
    try:
        with open(json_file, 'r', encoding='utf-8') as f:
            json_data = f.read()

        # Parse to dict to show event_id
        data = json.loads(json_data)
        click.echo(f"✓ Loaded JSON: event_id={data.get('event_id', 'N/A')}")
    except json.JSONDecodeError as e:
        click.secho(f"❌ Invalid JSON: {e}", fg='red')
        sys.exit(1)
    except Exception as e:
        click.secho(f"❌ Error reading file: {e}", fg='red')
        sys.exit(1)

    # Create Protobuf message from JSON using json_format
    try:
        click.echo("✓ Encoding to Protobuf...")

        # Use google.protobuf.json_format for automatic conversion
        event = json_format.Parse(json_data, message_class())

        # Serialize to bytes
        protobuf_data = event.SerializeToString()
        size = len(protobuf_data)
        click.echo(f"✓ Encoded: {size} bytes")

        # Debug: показать первые байты
        if size > 0:
            click.echo(f"✓ First bytes: {protobuf_data[:min(20, size)].hex()}")
        else:
            click.secho("❌ WARNING: Protobuf data is empty!", fg='red')

    except json_format.ParseError as e:
        click.secho(f"❌ Failed to parse JSON to Protobuf: {e}", fg='red')
        click.echo("   Check that JSON fields match the Protobuf schema")
        sys.exit(1)
    except Exception as e:
        click.secho(f"❌ Failed to encode Protobuf: {e}", fg='red')
        sys.exit(1)

    # Publish to NATS
    try:
        click.echo("✓ Publishing to NATS...")

        # Nats-Msg-Id = event_id — то же правило, что у адаптеров публикации:
        # JetStream отбрасывает повтор внутри окна дедупликации стрима. Флаг
        # --no-msg-id снимает заголовок, чтобы повтор дошёл до потребителя и
        # проверялась уже его дедупликация.
        # Из разобранного сообщения, а не из JSON: json_format принимает и
        # event_id, и eventId, и ключ файла не обязан совпадать с именем поля.
        header_id = None if no_msg_id else (msg_id or getattr(event, 'event_id', None))
        command = ['nats', 'pub', subject, '--server', nats_url, '--force-stdin']
        if header_id:
            command += ['--header', f'Nats-Msg-Id:{header_id}']
            click.echo(f"✓ Nats-Msg-Id: {header_id}")

        result = subprocess.run(
            command,
            input=protobuf_data,
            check=True,
            capture_output=True
        )

        click.echo()
        click.secho("✅ Event published successfully!", fg='green', bold=True)

        if result.stdout:
            output = result.stdout.decode('utf-8', errors='ignore').strip()
            if output:
                click.echo(f"   NATS output: {output}")

    except subprocess.CalledProcessError as e:
        click.secho(f"❌ Failed to publish to NATS: {e}", fg='red')
        if e.stderr:
            stderr = e.stderr.decode('utf-8', errors='ignore').strip()
            if stderr:
                click.echo(f"   Error details: {stderr}")
        sys.exit(1)


@cli.command()
@click.option('--nats-url', default='nats://localhost:4222',
              help='NATS server URL')
@click.option('--subject', default='>',
              help='NATS subject pattern to subscribe to')
def subscribe(nats_url: str, subject: str):
    """Subscribe to NATS messages and decode them.

    Subscribes to NATS subject, automatically detects message type by subject,
    decodes Protobuf messages and displays as JSON. Press Ctrl+C to stop.

    \b
    Examples:
        nats-tester subscribe
        nats-tester subscribe --subject "events.>"
        nats-tester list-types  # Show all registered subjects
    """
    asyncio.run(_subscribe_async(nats_url, subject))


async def _subscribe_async(nats_url: str, subject: str):
    """Async implementation of subscribe."""
    click.echo(click.style("👂 Subscribing to NATS messages", fg='cyan', bold=True))
    click.echo(f"   NATS URL: {nats_url}")
    click.echo(f"   Subject:  {subject}")
    click.echo(f"   Press Ctrl+C to stop")
    click.echo()
    click.echo("─" * 60)
    click.echo()

    message_count = 0

    async def message_handler(msg):
        nonlocal message_count
        message_count += 1

        msg_subject = msg.subject
        data = msg.data

        click.echo(click.style(f"📨 Message #{message_count}", fg='yellow'))
        click.echo(f"   Subject: {msg_subject}")
        click.echo(f"   Size: {len(data)} bytes")

        if msg_subject in ALL_MESSAGE_TYPES:
            message_class = ALL_MESSAGE_TYPES[msg_subject]
            try:
                message = message_class()
                message.ParseFromString(data)

                json_str = json_format.MessageToJson(
                    message,
                    preserving_proto_field_name=True,
                    indent=2,
                    ensure_ascii=False
                )

                click.echo(click.style("   Decoded:", fg='green'))
                click.echo(f"   Type: {message_class.DESCRIPTOR.name}")
                click.echo(f"   JSON:")
                for json_line in json_str.split('\n'):
                    click.echo(f"     {json_line}")

            except Exception as e:
                click.secho(f"   ❌ Failed to decode as {message_class.DESCRIPTOR.name}: {e}", fg='red')
        else:
            click.secho(f"   ⚠️  Unknown subject: {msg_subject}", fg='yellow')
            click.echo(f"   Registered subjects: {list(ALL_MESSAGE_TYPES.keys())}")

        click.echo()
        click.echo("─" * 60)
        click.echo()

    try:
        nc = await nats.connect(nats_url)

        await nc.subscribe(subject, cb=message_handler)

        click.echo(click.style(f"✓ Connected to NATS", fg='green'))
        click.echo()

        # Keep running until interrupted
        try:
            while True:
                await asyncio.sleep(1)
        except KeyboardInterrupt:
            pass

    except KeyboardInterrupt:
        click.echo()
        click.secho(f"✅ Stopped. Received {message_count} messages.", fg='green')
    except Exception as e:
        click.secho(f"❌ Error: {e}", fg='red')
        if 'connection refused' in str(e).lower():
            click.echo(f"   Make sure NATS server is running at {nats_url}")
        sys.exit(1)
    finally:
        if 'nc' in locals():
            await nc.close()


@cli.command()
@click.option('--nats-url', default='nats://localhost:4222',
              help='NATS server URL')
@click.option('--stream', required=True,
              help='JetStream stream, e.g. MEETUPS_EVENTS')
@click.option('--durable', required=True,
              help='Existing durable consumer, e.g. nats-tester-meetups-events')
@click.option('--drain', is_flag=True,
              help='Exit once the durable has nothing pending instead of waiting')
def consume(nats_url: str, stream: str, durable: str, drain: bool):
    """Read a durable JetStream consumer, ack and flag repeats by event_id.

    Binds to a durable declared by the AppHost topology, not a new one: the
    position lives on the server, so a restart continues after the last acked
    message. A second message with an already seen event_id is reported as a
    duplicate and acked without being applied — the consumer-side dedup rule.
    Seen ids live in memory for this run only.

    \b
    Examples:
        nats-tester consume --stream MEETUPS_EVENTS --durable nats-tester-meetups-events
        nats-tester consume --stream IDENTITY_EVENTS --durable nats-tester-identity-events --drain
    """
    try:
        asyncio.run(_consume_async(nats_url, stream, durable, drain))
    except KeyboardInterrupt:
        pass


async def _consume_async(nats_url: str, stream: str, durable: str, drain: bool):
    """Async implementation of consume."""
    click.echo(click.style(f"📥 Consuming {stream} as durable {durable}", fg='cyan', bold=True))

    seen: set[str] = set()
    applied = 0
    duplicates = 0
    rejected = 0

    try:
        nc = await nats.connect(nats_url)
        js = nc.jetstream()
        sub = await js.pull_subscribe_bind(durable=durable, stream=stream)

        while True:
            try:
                messages = await sub.fetch(10, timeout=1)
            except nats.errors.TimeoutError:
                if drain:
                    break
                continue

            for msg in messages:
                sequence = msg.metadata.sequence.stream
                try:
                    event_id = _event_id(msg.subject, msg.data)
                except DecodeError as e:
                    # term, а не ack и не выход: без него сервер возвращал бы
                    # сообщение после AckWait бесконечно, и durable застревал.
                    rejected += 1
                    click.secho(f"⛔ #{sequence} {msg.subject} undecodable, terminated: {e}", fg='red')
                    await msg.term()
                    continue
                if event_id is not None and event_id in seen:
                    duplicates += 1
                    click.secho(f"🔁 #{sequence} {msg.subject} event_id={event_id} DUPLICATE, skipped", fg='yellow')
                else:
                    applied += 1
                    if event_id is not None:
                        seen.add(event_id)
                    click.secho(f"✅ #{sequence} {msg.subject} event_id={event_id} applied", fg='green')
                # Ack и у повтора: он обработан — распознан и пропущен. Без ack
                # сервер вернул бы его снова после AckWait.
                await msg.ack()

    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    except Exception as e:
        click.secho(f"❌ Error: {e}", fg='red')
        sys.exit(1)
    finally:
        if 'nc' in locals():
            await nc.close()

    click.echo(f"Applied {applied}, duplicates {duplicates}, undecodable {rejected}.")


def _event_id(subject: str, data: bytes) -> Optional[str]:
    """event_id конверта, если subject известен реестру и сообщение его несёт."""
    message_class = ALL_MESSAGE_TYPES.get(subject)
    if message_class is None:
        return None
    message = message_class()
    message.ParseFromString(data)
    return getattr(message, 'event_id', None) or None


@cli.command()
@click.option('--nats-url', default='nats://localhost:4222',
              help='NATS server URL')
def streams(nats_url: str):
    """Show JetStream streams and their durable consumers.

    Confirms that the AppHost applied the topology: stream subjects, retention,
    max age and, per durable, how many messages are pending and unacked.
    """
    asyncio.run(_streams_async(nats_url))


async def _streams_async(nats_url: str):
    """Async implementation of streams."""
    try:
        nc = await nats.connect(nats_url)
        js = nc.jetstream()
        for info in await js.streams_info():
            config = info.config
            click.secho(f"{config.name}", fg='cyan', bold=True)
            click.echo(f"   subjects:  {', '.join(config.subjects or [])}")
            # nats-py отдаёт retention и storage то enum'ом, то строкой — по версии.
            retention = getattr(config.retention, 'value', config.retention)
            storage = getattr(config.storage, 'value', config.storage)
            click.echo(f"   retention: {retention}, storage: {storage}, "
                       f"max_age: {config.max_age}s, duplicate_window: {config.duplicate_window}s")
            click.echo(f"   messages:  {info.state.messages}")
            for consumer in await js.consumers_info(config.name):
                ack_floor = consumer.ack_floor.stream_seq if consumer.ack_floor else 0
                click.echo(f"   durable {consumer.name}: pending {consumer.num_pending}, "
                           f"unacked {consumer.num_ack_pending}, ack floor {ack_floor}")
    except Exception as e:
        click.secho(f"❌ Error: {e}", fg='red')
        sys.exit(1)
    finally:
        if 'nc' in locals():
            await nc.close()


@cli.command()
def check():
    """Check if required tools are installed.

    Verifies that nats CLI is available and that the generated classes pass
    the gate checks: import, generation set and registry.
    """
    click.echo(click.style("🔍 Checking required tools", fg='cyan', bold=True))
    click.echo()

    all_ok = True

    # Check nats
    if _check_tool('nats'):
        version = _get_tool_version('nats', ['--version'])
        click.secho(f"✅ nats:   {version}", fg='green')
    else:
        click.secho("❌ nats:   not found", fg='red')
        click.echo("   Install: go install github.com/nats-io/natscli/nats@latest")
        all_ok = False

    # Проверки сгенерированных классов: импорт, состав генерации и согласие с
    # реестром. Их же гоняет `just nats-tester-check` в `verify`: расхождение
    # не должно существовать в двух версиях — ручной и машинной.
    problems = gate.check()
    if problems:
        click.secho("❌ protobuf: generated classes are out of sync", fg='red')
        for problem in problems:
            click.echo(f"   {problem}")
        click.echo("   See README, «Troubleshooting»")
        all_ok = False
    else:
        click.secho("✅ protobuf: generated classes import and match the bus schemas", fg='green')

    click.echo()
    if all_ok:
        click.secho("✅ All tools installed!", fg='green', bold=True)
    else:
        click.secho("⚠️  Some tools are missing", fg='yellow', bold=True)
        sys.exit(1)


@cli.command()
@click.argument('json_file', type=click.Path(exists=True))
@click.option('--event-type', required=True,
              help='Event type to validate against')
def validate(json_file: str, event_type: str):
    """Validate JSON file against Protobuf schema.

    Attempts to encode the JSON to verify it matches the expected schema.

    \b
    Example:
        nats-tester validate message.json --event-type events.example.happened
    """
    click.echo(f"🔍 Validating {json_file}")
    click.echo(f"   Event type: {event_type}")

    if event_type not in EVENT_TYPES:
        click.secho(f"❌ Unknown event type: {event_type}", fg='red')
        click.echo(f"   Run 'nats-tester list-types' to see all supported types")
        sys.exit(1)

    message_class = EVENT_TYPES[event_type]

    try:
        with open(json_file, 'r', encoding='utf-8') as f:
            json_data = f.read()

        # Use json_format.Parse for validation
        event = json_format.Parse(json_data, message_class())

        # Try to serialize
        event.SerializeToString()

        click.secho("✅ Valid JSON structure!", fg='green')
        click.echo(f"   Message type: {message_class.DESCRIPTOR.name}")

    except json.JSONDecodeError as e:
        click.secho(f"❌ Invalid JSON: {e}", fg='red')
        sys.exit(1)
    except json_format.ParseError as e:
        click.secho(f"❌ JSON doesn't match Protobuf schema: {e}", fg='red')
        sys.exit(1)
    except Exception as e:
        click.secho(f"❌ Error: {e}", fg='red')
        sys.exit(1)


@cli.command(name='gen-id')
def gen_id():
    """Generate a UUIDv7 for use as an entity or operation id (ADR-020).

    \b
    Example:
        nats-tester gen-id
    """
    click.echo(str(uuid7()))


@cli.command()
def list_types():
    """List all supported message types.

    Shows all event and command types that can be published/subscribed.
    """
    click.echo(click.style("📋 Supported message types:", fg='cyan', bold=True))
    click.echo()

    if EVENT_TYPES:
        click.echo(click.style("Events:", fg='blue', bold=True))
        for subject, message_class in EVENT_TYPES.items():
            click.echo(f"  {click.style(subject, fg='green')}")
            click.echo(f"    → {message_class.DESCRIPTOR.name}")
        click.echo()

    if COMMAND_TYPES:
        click.echo(click.style("Commands:", fg='blue', bold=True))
        for subject, message_class in COMMAND_TYPES.items():
            click.echo(f"  {click.style(subject, fg='green')}")
            click.echo(f"    → {message_class.DESCRIPTOR.name}")
        click.echo()

    total = len(EVENT_TYPES) + len(COMMAND_TYPES)
    click.echo(f"Total: {total} message type(s)")
    click.echo()
    click.echo("To add new types, edit EVENT_TYPES or COMMAND_TYPES in registry.py")


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
