"""Проверки инструмента: импорт классов, состав генерации, согласие с реестром.

Их гоняет `just nats-tester-check` в `just verify` и джоба `nats-tester` в CI.
Команда `nats-tester check` зовёт их же: ручная и машинная проверка не должны
существовать в двух версиях.

Проверка не ходит в сеть и не требует protoc: закоммиченные классы читаются
как есть, а состав генерации выводится из схем (`proto_sources`). Расхождение
со схемой ловит перегенерация в CI — здесь проверяется то, что видно без
компилятора.
"""

from __future__ import annotations

import importlib
from pathlib import Path

from nats_tester.proto_sources import (
    bus_schema_files,
    generated_modules,
    resolve_generation_set,
)

GENERATED_DIR = Path(__file__).resolve().parent / "generated"
PROTO_DIR = Path(__file__).resolve().parents[3] / "contracts" / "proto"


def broken_imports() -> list[str]:
    """Модули, которые не импортируются, — со сжатым сообщением об ошибке."""
    package = f"{__package__}.generated"
    problems = []
    for module_file in sorted(GENERATED_DIR.rglob("*_pb2.py")):
        relative = module_file.relative_to(GENERATED_DIR).with_suffix("")
        module = f"{package}.{'.'.join(relative.parts)}"
        try:
            importlib.import_module(module)
        except Exception as error:
            problems.append(f"{module}: {type(error).__name__}: {error}")
    return problems


def generation_set_problems() -> list[str]:
    """Состав generated/ совпадает с замыканием шинных схем."""
    expected = set(generated_modules(resolve_generation_set(PROTO_DIR)))
    actual = {
        path.relative_to(GENERATED_DIR).as_posix()
        for path in GENERATED_DIR.rglob("*_pb2.py")
    }

    problems = [
        f"missing generated module: {name}" for name in sorted(expected - actual)
    ]
    problems += [
        f"stale generated module: {name} (not in the generation set)"
        for name in sorted(actual - expected)
    ]
    return problems


def registry_problems() -> list[str]:
    """Каждый subject зарегистрирован из схемы, которая сама объявляет subject.

    Проверка идёт по `bus_schema_files()`, а не по всему набору генерации:
    последний включает и файлы, попавшие в него только как чужой импорт
    (`meetups.proto` у `notifications.proto`) — у них есть класс, но subject
    не бывает, и регистрация из такого файла должна проваливать гейт.
    """
    # Импорт отложен: без сгенерированных классов реестр не импортируется, и
    # падение должно попасть в отчёт, а не уронить сам модуль проверок.
    from nats_tester import registry

    expected = bus_schema_files()
    return [
        f"subject {subject}: {message.DESCRIPTOR.file.name} is not a bus schema"
        for subject, message in registry.ALL_MESSAGE_TYPES.items()
        if message.DESCRIPTOR.file.name not in expected
    ]


def check() -> list[str]:
    """Пустой список — инструмент согласован; иначе строки для отчёта."""
    problems = broken_imports()

    try:
        problems += generation_set_problems()
    except FileNotFoundError as error:
        problems.append(str(error))
        return problems

    try:
        problems += registry_problems()
    except Exception as error:
        problems.append(f"registry: {type(error).__name__}: {error}")

    return problems


def main() -> int:
    problems = check()
    if problems:
        print("nats-tester: generated classes are out of sync with the schemas")
        for problem in problems:
            print(f"  - {problem}")
        print("  see README, «Troubleshooting»")
        return 1

    print("nats-tester: generated classes import and match the bus schemas")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
