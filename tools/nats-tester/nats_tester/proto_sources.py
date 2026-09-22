"""Схемы, из которых собираются классы сообщений шины.

Subject живёт в реестре (`registry.py`), а схема объявляет полезную нагрузку:
у gRPC-схемы subject не бывает, и классы её инструменту не нужны. Список
ведётся вместе с реестром — принятый subject добавляет запись в оба места.

Замыкание по импортам обязательно: `protoc` пишет в сгенерированный модуль
импорт зависимости, и без её класса модуль не импортируется. Так
`notifications.proto` тянет `meetups.proto` — файл значений домена, а не
вторую шинную схему.
"""

from __future__ import annotations

import re
from pathlib import Path

NATS_PROTO_FILES: tuple[str, ...] = (
    "meetups/v1/meetups_events.proto",
    "notifications/v1/notifications.proto",
)

_IMPORT = re.compile(r'^import\s+(?:public\s+|weak\s+)?"([^"]+)";', re.MULTILINE)

# Well-known types приносит рантайм protobuf: своих модулей у них нет.
_RUNTIME_PREFIXES = ("google/protobuf/",)


def resolve_generation_set(proto_dir: Path) -> list[str]:
    """Шинные схемы и всё, что они импортируют, — пути от корня buf-модуля."""
    pending = list(NATS_PROTO_FILES)
    resolved: set[str] = set()

    while pending:
        relative = pending.pop()
        if relative in resolved or relative.startswith(_RUNTIME_PREFIXES):
            continue

        source = proto_dir / relative
        if not source.is_file():
            raise FileNotFoundError(
                f"schema {relative} is named by NATS_PROTO_FILES or imported by "
                f"a bus schema, but does not exist under {proto_dir}"
            )

        resolved.add(relative)
        pending.extend(_IMPORT.findall(source.read_text(encoding="utf-8")))

    return sorted(resolved)


def bus_schema_files() -> frozenset[str]:
    """Схемы, которые сами объявляют subject, а не только полезную нагрузку.

    Уже, чем `resolve_generation_set`: файл, попавший в набор генерации
    только как импорт (`meetups.proto` у `notifications.proto`), subject не
    объявляет и в этот набор не входит — иначе реестр принял бы `subject` из
    класса чужого домена.
    """
    return frozenset(NATS_PROTO_FILES)


def generated_modules(proto_files: list[str]) -> list[str]:
    """Пути `*_pb2.py` относительно каталога generated для набора схем."""
    return sorted(
        Path(proto_file).with_name(Path(proto_file).stem + "_pb2.py").as_posix()
        for proto_file in proto_files
    )
