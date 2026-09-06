# Standard: стратегия тестирования

> **Статус:** Active  
> **Применимость:** все product services и инструменты  
> **Связанные документы:** service-local README и nested `AGENTS.md`

Выбирай минимальный уровень, на котором ошибка воспроизводится надёжно и наблюдаемо.

## Уровни

| Уровень | Что проверяет | Текущие инструменты |
|---|---|---|
| Unit | чистая доменная логика, FSM, UI builders, mapping, error branches | Identity: Go tests; Telegram Bot: Vitest; F# xUnit v3 + Unquote, FsCheck для properties |
| Actor | command/event/state transitions, recovery и actor infrastructure | Akka.TestKit.Xunit2; сначала тестируй чистую логику, если она отделена |
| Integration | реальный boundary одного сервиса: PostgreSQL, NATS, gRPC, SignalR | service-specific test host или локальная инфраструктура |
| Contract | producer и consumer одинаково понимают Protobuf и subject | сборка всех потребителей, сериализационные тесты, `nats-tester` |
| E2E | пользовательский вертикальный срез через несколько компонентов | Aspire и наблюдаемый ответ внешнему клиенту |

## Правила

- Не проверяй бизнес-инвариант через E2E, если его можно детерминированно проверить unit-тестом.
- Для Event Sourcing отдельно проверяй решение команды, применение события и recovery.
- Фиксируй время, UUID, random seed и внешние ответы; тест не должен зависеть от часов машины или порядка соседних тестов.
- Не обращайся к production-сервисам из автоматического теста.
- Ошибочный, пограничный и повторный запрос являются частью набора сценариев, если сервис меняет состояние.
- Изменение Protobuf требует contract-level проверки всех consumers.
- Новый стек тестирования не вводится только ради единообразия с другим языком.

## Стек C#

C#-тестов в репозитории пока нет: на C# написаны AppHost, ServiceDefaults и проект кодогенерации Meetups. Стек ниже рекомендован заранее, чтобы первый тест не выбирал его заново, и перенесён из проверенной практики `pampadu.kasko`. Форму имени задаёт [naming.md](naming.md).

| Назначение | Пакет |
|---|---|
| Test framework и runner | xUnit v3 на Microsoft.Testing.Platform; тест-проект собирается как executable |
| Утверждения | Shouldly по умолчанию; AwesomeAssertions допустим |
| Моки | Moq |
| Тестовые данные | AutoFixture (+ AutoMoq), Bogus с фиксированным seed |
| EF queryables | MockQueryable.Moq |
| `ILogger` в вывод теста | MartinCostello.Logging.XUnit.v3 |

- Раннер Microsoft.Testing.Platform уже включён репозиторием в корневом `global.json`; тест-проект добавляет `OutputType=Exe` и `UseMicrosoftTestingPlatformRunner=true` и не тянет `Microsoft.NET.Test.Sdk`.
- NUnit не вводится: test framework в репозитории один.
- FluentAssertions не вводится: у пакета коммерческая лицензия начиная с v8. AwesomeAssertions — другой пакет и допустим как альтернатива Shouldly.
- Порядок выбора test double тот же, что в [F#](fsharp.md): чистая функция, запись функций, маленький handwritten fake, и только затем Moq. AutoFixture и Bogus дают данные, а не заменяют этот порядок.
- Список фиксирует выбор, а не версии: они закрепляются существующим способом репозитория при создании первого тест-проекта.

## Текущие команды

```bash
# Identity (Go) — из корня репозитория
just identity-test
just identity-lint
# интеграционные тесты схемы требуют PostgreSQL; в CI поднимается сервис postgres:16-alpine

# Telegram Bot (TypeScript) — из корня репозитория
just telegram-bot-test
just telegram-bot-lint
just telegram-bot-typecheck
# unit и component tests без Telegram credentials; coverage — npm run coverage без порога

# .NET — из папки проекта
dotnet build && dotnet test
```

Команды и библиотеки конкретного сервиса уточняются в его README/AGENTS. Для F# действует [отдельный standard](fsharp.md), именование тестов во всех стеках задаёт [naming.md](naming.md). Kotlin- и Scala-сервисы получают стек после создания.
