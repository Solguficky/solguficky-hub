---
name: proj-write-fsharp-vsa
description: Писать и ревьюить F#-приложение функциональными vertical slices: workflow команды/запроса, Functional Core/Imperative Shell, локальные mappings, composition root и Oxpecker boundary. Использовать для apps/meetups и F#-компонентов, где VSA явно выбрана; само наличие F# не делает VSA обязательной.
---

# Писать функциональный вертикальный срез на F#

Для Meetups устройство принято в [ADR-033](../../../docs/decisions/ADR-033-meetups-functional-vertical-slices.md) и раскрыто в [брифе](../../../docs/services/meetups.md). Языковые правила даёт `proj-write-fsharp`, тестовые — `proj-test-fsharp`. Для другого F#-компонента сначала найди явное решение о VSA; без него этот skill не назначает архитектуру.

## 1. Назови срез продуктовым действием

Прочитай ближайший `AGENTS.md`, service brief и ADR сценария. В Meetups дополнительно сверь команду или запрос со словарём [ADR-031](../../../docs/decisions/ADR-031-meetups-domain-vocabulary-and-event-form.md) и технической моделью [ADR-024](../../../docs/decisions/ADR-024-meetups-state-storage-with-domain-event-log.md).

Срез называется командой, запросом или наблюдаемым workflow, а не технологией. Зафиксируй его input, typed success, expected errors, эффекты и транзакционную границу до выбора файлов.

## 2. Положи чистое решение в центр

Отдели функции проверки команды и перехода состояния от загрузки, часов, UUID, SQL, публикации и transport. Чистая функция принимает все факты значениями и возвращает typed decision; императивная оболочка читает зависимости, открывает транзакцию и применяет результат.

Не превращай VSA в обязательные `Domain.fs`, `Handler.fs`, `Service.fs` и `Repository.fs`. Маленький срез остаётся маленьким; файл или модуль выделяется, когда у него появилась отдельная ответственность или второй потребитель.

## 3. Держи отображения рядом с владельцем

Protobuf/C# DTO, Dapper row и Oxpecker request/response заканчиваются в своих adapters. Mapping, уникальный для команды или запроса, живёт в срезе. Общий adapter выделяется после повторного использования и не становится обходным путём к доменному состоянию.

Oxpecker знает HTTP и composition root, но domain/workflow не возвращает HTTP status, route type или framework context. Межсервисный transport Meetups остаётся решением contract design, а не следствием выбранного web framework.

## 4. Собери зависимости в composition root

Workflow принимает узкий record of functions либо функции отдельными аргументами. Composition root разрешает DI, lifetime и concrete clients один раз. Service locator, `IServiceProvider` внутри среза и общий interface на каждый module запрещены.

Обнови порядок `.fsproj` так, чтобы domain types предшествовали workflow, adapters зависели от внутренних контрактов, а composition root был последним потребителем. Цикл между срезами означает неверную границу, а не необходимость общего `Helpers`.

## 5. Докажи срез тестами

Через `proj-test-fsharp` отдельно проверь чистое решение, orchestration workflow и boundary mappings. Integration test нужен для транзакции, SQL, Protobuf или Oxpecker wiring; E2E — только для сквозного пользовательского обещания.

Срез готов, когда один сценарий можно прочитать без обхода горизонтальных слоёв, доменное решение работает без host и I/O, а framework и generated types не пересекли boundary.
