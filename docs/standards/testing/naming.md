# Standard: именование тестов

> **Статус:** Active  
> **Применимость:** автоматические тесты Go, TypeScript, F# и C#-компонентов  
> **Связанные документы:** [testing-strategy.md](testing-strategy.md), [fsharp.md](fsharp.md), service-local `AGENTS.md`

Имя теста является спецификацией: из него понятно, что проверяется и какой результат ожидается, без чтения тела. Standard фиксирует форму имени теста, файла и группы для каждого языка репозитория.

## Общие правила

- Имя называет проверяемое свойство и ожидаемый исход. Имя без сценария или без ожидания (`Test1`, `TestMap`, `works correctly`) ревью не проходит.
- Одна форма имени на файл; в TypeScript — на `describe`-блок. Соседние тесты одного набора не чередуют форму.
- Один тест — одно наблюдаемое поведение. Несколько утверждений допустимы, если все они описывают это же поведение.
- Имя описывает наблюдаемое свойство, а не последовательность вызовов реализации. Имя, которое перестанет быть верным после разрешённого рефакторинга — упоминает приватную функцию, порядок вызовов или имя мока, — переписывается на свойство.
- Имя пишется по-английски во всех стеках, включая табличные подтесты и `describe`.
- Уровень теста выражается расположением и суффиксом файла, а не словами `unit`, `integration` или `e2e` внутри имени теста.
- Новый язык добавляет свою секцию в этот standard в том же коммите, что и первый тест на нём.

## Go

- Имя функции: `Test<SUT><Поведение>` в CamelCase без подчёркиваний. Первым идёт тестируемая функция, метод или RPC, дальше наблюдаемый исход: `TestOpenCapsPool`, `TestApplyIsIdempotent`, `TestResolveIdentityDoesNotRestoreRevokedAdmin`, `TestUnaryChainLogsInternalWithoutLeakingCause`.
- Глагол в третьем лице настоящего времени. Отрицательный случай формулируется как наблюдаемое поведение (`DoesNotRestoreRevokedAdmin`, `HidesStorageErrors`), а не как `Fails` или `Error`.
- Поле `name` табличного подтеста — короткая фраза в нижнем регистре, называющая случай: `invalid argument`, `request id wins`, `empty value falls through`, `header case is normalised`. Ожидание в имя подтеста не дублируется, если оно уже выражено полями таблицы.
- Файл `<unit>_test.go` лежит рядом с исходником. Тест, требующий PostgreSQL, выносится в `<unit>_integration_test.go`.
- Суффикс `_internal_test.go` разводит внутренний и внешний тест одного unit, когда существуют оба: `server_test.go` в пакете `server_test` и `server_internal_test.go` в пакете `server`.

## TypeScript

- `describe` называет SUT: экспортируемую функцию ровно как в коде (`parseUpdate`, `createShutdown`) либо роль модуля строчными буквами (`dispatcher`, `identity client`, `presentation adapter`).
- `it` грамматически продолжает `describe`: глагол в третьем лице настоящего времени, со строчной буквы, без `should` и без повторения имени SUT — `returns unavailable when the rpc never completes`, `renders the start response without telegram types`.
- Отрицательный случай называет наблюдаемое бездействие: `does not resolve identity for unrelated text`, `ignores /start outside a private chat`.
- Файл `<module>.test.ts` лежит рядом с исходником; отдельного дерева тестов нет.

## F#

- Имя — предложение в обратных кавычках, описывающее проверяемое свойство, со строчной буквы: ``service exposes exactly the six slice operations``.
- Форма по умолчанию — декларативный инвариант. Форма ``When … expect …`` допустима там, где есть явный стимул и исход: команда домена, обработка события, workflow. Одна форма на файл.
- Property-тест называет само свойство без церемоний: ``proto round trip preserves the input``, ``applying a decided event bumps version exactly once``.
- Файл `<Модуль>Tests.fs` лежит в тестовом проекте `<Компонент>.Tests`. Файл без тестов — фикстура, генератор, хелпер — суффикс `Tests` не носит.

## C#

C#-тестов в репозитории пока нет; раздел рекомендован заранее, чтобы первый тест не выбирал форму заново. Стек — [testing-strategy.md](testing-strategy.md).

- `<Метод>_<Сценарий>_<ОжидаемоеПоведение>` — форма по умолчанию для unit-теста, где виден конкретный метод SUT: `Map_RequestHasNoDrivers_MapsToUnlimitedDrivers`. Имя метода первым даёт группировку и поиск по SUT.
- `When_<условие>_Should_<ожидание>` — форма для поведенческого и E2E-теста, где метод SUT не выделяется: `When_MeetupPublished_Should_NotifySubscribers`.
- Одна форма на класс. Файл `<SUT>Tests.cs`, класс `<SUT>Tests`.

## Пример

| Язык | Так | Не так |
|---|---|---|
| Go | `TestDuplicateTelegramUserIDIsRejected` | `TestInsert2`, `TestDuplicateWorks` |
| Go, подтест | `{name: "empty value falls through"}` | `{name: "case3"}` |
| TypeScript | `describe("parseUpdate")` + `it("treats garbage as malformed")` | `describe("tests")` + `it("should work")` |
| F# | ``every operation carries the viewer as field one`` | ``test mapping``, ``Mapping works`` |
| C# | `Map_RequestHasNoDrivers_MapsToUnlimitedDrivers` | `MapTest`, `TestMapping2` |

## Проверка

- Механической проверки имени нет: ни `golangci-lint`, ни Biome, ни `just verify` форму имени не контролируют. Правило проверяется на review и в `proj-review-change`.
- Для изменённого набора тестов проверь три вещи: имя читается как предложение о поведении, форма внутри файла одна, имя останется верным после рефакторинга реализации.
