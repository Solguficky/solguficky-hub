"""Проверки инструмента: импорт классов, состав генерации, согласие с реестром,
имена subjects и общая форма конверта.

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
import re
from pathlib import Path

from google.protobuf.descriptor import FieldDescriptor

from nats_tester.proto_sources import (
    bus_schema_files,
    generated_modules,
    resolve_generation_set,
)

GENERATED_DIR = Path(__file__).resolve().parent / "generated"
PROTO_DIR = Path(__file__).resolve().parents[3] / "contracts" / "proto"

# Сообщение с этим `oneof` — доменный факт, повод которого называет subject.
# Имя выбрано не здесь: так его назвали оба принятых контракта фактов, и оно
# отличает их от продуктового словаря, у которого ветвление называется иначе
# (`oneof type` у уведомления). Поэтому списка доменов-исключений у проверок
# ниже нет: соглашение называет себя само, а список пришлось бы сопровождать
# руками при каждом новом контракте.
OCCASION_ONEOF = "occasion"

# Конверт факта: пять полей, одинаковых у всех доменов по номеру, типу и
# смыслу. `None` у второго поля значит «имя выводится», а не «имя не
# проверяется»: конверт обязан называть субъект факта, и называет он агрегат,
# а не домен. Домен для вывода не годится — пакет `meetups.v1` во
# множественном числе, а поле `meetup_id` в единственном. Имя берётся из типа
# снимка: `MeetupState` даёт `meetup_id`, `IdentityState` — `identity_id`.
# Тип снимка у каждого домена свой, и проверяется только то, что это
# сообщение с таким именем.
ENVELOPE: tuple[tuple[int, str | None, int], ...] = (
    (1, "event_id", FieldDescriptor.TYPE_STRING),
    (2, None, FieldDescriptor.TYPE_STRING),
    (3, "version", FieldDescriptor.TYPE_INT64),
    (4, "occurred_at", FieldDescriptor.TYPE_STRING),
    (5, "state", FieldDescriptor.TYPE_MESSAGE),
)

_SNAPSHOT_SUFFIX = "State"
_CAMEL_BOUNDARY = re.compile(r"(?<!^)(?=[A-Z])")

# Номер снимка выводится из таблицы выше один раз, на импорте: правка ENVELOPE,
# которая оставит конверт без снимка, обязана упасть здесь и сразу, а не
# превратиться в StopIteration внутри отдельной проверки, где её проглотит
# обработчик и выдаст за расхождение реестра.
_SNAPSHOT_NUMBER = next(number for number, name, _ in ENVELOPE if name == "state")

# Номер типа поля читается человеком, который правит схему, а не protobuf:
# «type 5, not 3» заставляет его искать таблицу, «int32, not int64» — нет.
_TYPE_NAMES = {
    value: name[len("TYPE_") :].lower()
    for name, value in vars(FieldDescriptor).items()
    if name.startswith("TYPE_")
}


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


def _bus_event_descriptors() -> list:
    """Сообщения-факты, найденные по схемам шины, а не по реестру.

    Источник здесь решающий. Реестр для этого не годится: домен, у которого в
    нём нет ни одной записи, через него не находится вовсе — и контракт,
    забытый целиком, проезжает зелёным вместе с непроверенным конвертом. Это
    ровно тот случай, ради которого обе проверки ниже и заводились, поэтому
    список доменов берётся из `NATS_PROTO_FILES`, где забытую схему видно.
    """
    descriptors = []
    for schema in sorted(bus_schema_files()):
        relative = Path(schema).with_suffix("")
        module = importlib.import_module(
            f"{__package__}.generated.{'.'.join(relative.parts)}_pb2"
        )
        descriptors += [
            message
            for message in module.DESCRIPTOR.message_types_by_name.values()
            if any(oneof.name == OCCASION_ONEOF for oneof in message.oneofs)
        ]
    return descriptors


def _subject_field_name(descriptor, by_number) -> tuple[str | None, str | None]:
    """Имя поля-субъекта, выведенное из типа снимка, и отказ вывода.

    Конверт называет агрегат, а не домен, поэтому имя берётся из снимка, а не
    из пакета. Вывести его нельзя ровно тогда, когда снимка нет или он назван
    не по соглашению, — и это само по себе расхождение конверта.
    """
    field = by_number.get(_SNAPSHOT_NUMBER)
    if field is None or field.type != FieldDescriptor.TYPE_MESSAGE:
        return None, (
            f"{descriptor.full_name}: field {_SNAPSHOT_NUMBER} is not the snapshot "
            f"message the envelope spends it on"
        )

    name = field.message_type.name
    if not name.endswith(_SNAPSHOT_SUFFIX) or name == _SNAPSHOT_SUFFIX:
        return None, (
            f"{descriptor.full_name}: snapshot type {name} is not named "
            f"<Aggregate>{_SNAPSHOT_SUFFIX}, so the subject field cannot be derived"
        )

    aggregate = name[: -len(_SNAPSHOT_SUFFIX)]
    return f"{_CAMEL_BOUNDARY.sub('_', aggregate).lower()}_id", None


def subject_problems() -> list[str]:
    """Subjects домена фактов выводятся из веток `oneof occasion`.

    До этой проверки реестр сверялся в одну сторону: лишняя запись падала,
    отсутствующая нет, а строка subject'а не сверялась ни с чем — принятый
    контракт мог уехать с опечаткой в имени или вовсе без записи. Соответствие
    «subject = `events.<домен>.` плюс имя ветки» было обещано комментарием
    реестра и каталогом интеграций, но не проверялось ничем.
    """
    from nats_tester import registry

    descriptors = _bus_event_descriptors()
    if not descriptors:
        # Пустой вход неотличим от «всё в порядке»: без этой строки схема,
        # переименовавшая `oneof occasion`, выключила бы проверку молча.
        return [f"no bus schema declares oneof {OCCASION_ONEOF}: nothing to check"]

    problems = []
    for descriptor in descriptors:
        domain = descriptor.file.package.split(".")[0]
        occasion = descriptor.oneofs_by_name[OCCASION_ONEOF]
        expected = {f"events.{domain}.{field.name}" for field in occasion.fields}
        subjects = {
            subject
            for subject, message in registry.ALL_MESSAGE_TYPES.items()
            if message.DESCRIPTOR.full_name == descriptor.full_name
        }

        problems += [
            f"{descriptor.full_name}: occasion "
            f"{subject.rsplit('.', 1)[-1]} has no registered subject {subject}"
            for subject in sorted(expected - subjects)
        ]
        problems += [
            f"{descriptor.full_name}: subject {subject} names no occasion of the message"
            for subject in sorted(subjects - expected)
        ]
    return problems


def envelope_problems() -> list[str]:
    """Конверт факта одинаков во всех доменах.

    Два принятых контракта фактов обязаны совпадать конвертом, но живут в
    разных пакетах и раздельных определениях — ни `buf lint`, ни `buf
    breaking`, ни сборка потребителя не видят их одновременно. Расхождение
    ловилось только глазами на ревью; здесь оно ловится прогоном.
    """
    problems = []
    for descriptor in _bus_event_descriptors():
        by_number = {field.number: field for field in descriptor.fields}
        subject_name, snapshot_problem = _subject_field_name(descriptor, by_number)
        if snapshot_problem is not None:
            problems.append(snapshot_problem)

        for number, name, field_type in ENVELOPE:
            expected_name = subject_name if name is None else name
            field = by_number.get(number)

            if expected_name is None:
                continue
            if field is None:
                problems.append(
                    f"{descriptor.full_name}: the envelope spends field {number} "
                    f"on {expected_name}, and the message has no such field"
                )
                continue
            if field.name != expected_name:
                problems.append(
                    f"{descriptor.full_name}: field {number} is {field.name}, "
                    f"and the envelope spends it on {expected_name}"
                )
            if field.type != field_type:
                problems.append(
                    f"{descriptor.full_name}: envelope field {field.name} is "
                    f"{_TYPE_NAMES.get(field.type, field.type)}, not "
                    f"{_TYPE_NAMES.get(field_type, field_type)}"
                )
            if field.containing_oneof is not None:
                problems.append(
                    f"{descriptor.full_name}: envelope field {field.name} is "
                    f"inside oneof {field.containing_oneof.name}"
                )

        envelope_numbers = {number for number, _, _ in ENVELOPE}
        problems += [
            f"{descriptor.full_name}: field {field.name} is outside "
            f"oneof {OCCASION_ONEOF} and is not part of the envelope"
            for field in descriptor.fields
            if field.containing_oneof is None and field.number not in envelope_numbers
        ]
    return problems


def selftest_problems() -> list[str]:
    """Проверка subjects краснеет, когда домена в реестре нет совсем.

    Первая версия проверки брала домены из реестра и на этой мутации молчала,
    а мутационный прогон автора её не содержал: он портил предмет проверки,
    но не убирал его. Самопроверка по очереди вычёркивает из реестра каждый
    домен фактов целиком и требует, чтобы проверка это назвала.

    Реестр подменяется атрибутом модуля, а не аргументом: мутация обязана
    дойти до любого места гейта, которое реестр читает. Аргумент видела бы
    только сверка subjects, а исходный дефект сидел в том, откуда берётся
    список доменов, и через аргумент самопроверка его не ловила.
    """
    from nats_tester import registry

    original = registry.ALL_MESSAGE_TYPES
    problems = []
    for descriptor in _bus_event_descriptors():
        registry.ALL_MESSAGE_TYPES = {
            subject: message
            for subject, message in original.items()
            if message.DESCRIPTOR.full_name != descriptor.full_name
        }
        try:
            mutant_problems = subject_problems()
        finally:
            registry.ALL_MESSAGE_TYPES = original
        if not mutant_problems:
            problems.append(
                f"selftest: subject check stays green with every subject of "
                f"{descriptor.full_name} removed from the registry"
            )
    return problems


def check() -> list[str]:
    """Пустой список — инструмент согласован; иначе строки для отчёта."""
    problems = broken_imports()

    try:
        problems += generation_set_problems()
    except FileNotFoundError as error:
        problems.append(str(error))
        return problems

    # Каждая проверка идёт в своей обёртке и под своим именем: отказ одной не
    # должен ни выдавать себя за отказ соседней, ни отменять её прогон. Три из
    # четырёх читают реестр, поэтому упавший импорт назовут все три — это дешевле,
    # чем потерять находку из-за чужого падения; сверка конверта реестра не
    # читает и переживает его падение.
    for name, problem_source in (
        ("registry", registry_problems),
        ("subjects", subject_problems),
        ("envelope", envelope_problems),
        ("selftest", selftest_problems),
    ):
        try:
            problems += problem_source()
        except Exception as error:
            problems.append(f"{name}: {type(error).__name__}: {error}")

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
