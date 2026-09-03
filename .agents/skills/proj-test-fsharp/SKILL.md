---
name: proj-test-fsharp
description: Писать и ревьюить F#-тесты: xUnit v3, Unquote, FsCheck, Moq на .NET-границах, Testcontainers и выбор минимального уровня. Использовать при правках F# test projects, тестов домена/workflow/mapping или интеграционных тестов F#-компонента.
---

# Тестировать F#-код

Общий выбор уровня задаёт [testing-strategy.md](../../../docs/standards/testing/testing-strategy.md), F#-инструменты и свойства тестов — [testing/fsharp.md](../../../docs/standards/testing/fsharp.md). Языковые правила дополняет `proj-write-fsharp`.

## 1. Выбери минимальный честный уровень

Сначала сформулируй наблюдаемое свойство и выбери самый дешёвый уровень, который способен его опровергнуть. Доменный переход, expected error и mapping не поднимай в Aspire/E2E; SQL, Protobuf и transport не объявляй проверенными mock-тестом.

Прочитай `.fsproj`, package management и `--help` настроенного xUnit v3 runner до копирования команды фильтрации. Не подменяй существующий test host рецептом xUnit v2 или VSTest.

## 2. Собери детерминированный сценарий

Передай время, UUID, random seed и ответы зависимостей явно. Arrange описывает значимые факты, act вызывает один публичный workflow или функцию, assert проверяет возвращённый результат и состояние через Unquote.

Покрой happy path, каждый затронутый case error DU, пограничное значение и безопасный повтор изменяющей команды. Не проверяй private function напрямую, если то же свойство видно через публичную сигнатуру.

## 3. Используй подходящий double

Порядок выбора: чистая функция, record of functions, маленький handwritten fake, затем Moq для неудобной .NET-interface boundary. Не мокай F# domain record или DU и не воспроизводи implementation sequence цепочкой `Verify`.

Реальную PostgreSQL или другую инфраструктуру поднимай Testcontainers только для свойства самой границы. Контейнер получает уникальные данные, readiness check и гарантированный disposal; production endpoint запрещён.

## 4. Добавь property там, где это инвариант

Используй FsCheck для пространства значений, а не как замену примерам. Разделяй generators валидного домена и невалидных boundary primitives. Полезный shrunk counterexample сохраняй отдельным regression example.

## 5. Проверь тест

Сначала запусти узкий проект или class filter, затем общий one-shot test command компонента. Повтори тест, если он затрагивает concurrency, время или инфраструктуру. Убедись, что failure действительно красный при нарушении проверяемого свойства и что все поднятые ресурсы освобождаются.
