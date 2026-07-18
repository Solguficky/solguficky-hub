# ТЗ: миграция ULID → UUIDv7

> Статус: **выполнено** (18.07.2026, ветка `claude/uuidv7-migration-0e4bee`). ADR-020, все итерации закрыты, e2e через nats-tester проверен. Попутно обнаружено: в auction-service нет EF-миграций — таблица `lots` не создаётся на чистой БД (вынесено в отдельную задачу).

## Мотивация

Нужное свойство ID: генерация на стороне сервиса (без похода в БД) + сортируемость по времени (локальность индекса, естественный порядок в ES). ULID это даёт, но требует стороннюю библиотеку в каждом языке, а проект полиглотный (C#, Rust, Python, дальше Go/Kotlin/Ruby/Elixir). UUIDv7 (RFC 9562) даёт то же свойство и нативен почти везде: `Guid.CreateVersion7()` в .NET 9+, `uuid` crate (`v7`) в Rust, `uuid.uuid7()` в Python 3.14+ / пакет `uuid6`, `uuidv7()` в PostgreSQL 18+. В контрактах ID остаётся `string`, боевых данных нет — миграция дешёвая, дальше будет дороже.

## Скоуп

- Замена типа/генерации/парсинга ID аукциона (и будущих сходок) во всех сервисах.
- Новый ADR, заменяющий ADR-019; обновление доков.

**Не-скоуп:** смена типа колонок в PostgreSQL на нативный `uuid` (ID хранится строкой; отдельный пункт техдолга — можно сделать при появлении Meetups Service), миграция исторических данных (dev-журнал допустимо очистить).

## Инвентаризация (проверить и дополнить при выполнении)

| Место | Что сейчас |
|---|---|
| `services/auction-service/src/AuctionService/AuctionService.csproj` | пакет `Ulid` 1.3.4; TFM `net8.0` — **`Guid.CreateVersion7()` требует .NET 9+** |
| `Actors/Auction/{Commands,Events,State,Responses}.cs`, `AuctionActor.cs`, `AuctionRegistry.cs` | тип `Ulid` в командах/событиях/состоянии; PersistenceId `auction-{ulid}` |
| `Handlers/NatsCommandHandler.cs` (5 мест), `Services/AuctionGrpcService.cs` | `Ulid.Parse(command.AuctionId)` — бросает исключение на мусоре |
| `Handlers/AkkaPersistenceQueryListener.cs` | `Ulid.Empty` |
| `services/telegram-gateway/src/constants.rs` | захардкоженный ULID тестового аукциона |
| `tools/nats-tester` | генерация тестовых ID (проверить) |
| Доки: `AGENTS.md` (root), ADR-019, `docs/03_CONTRACTS/nats_subjects.md` (примеры) | упоминания ULID |

## Итерации

**Итерация 0 — ADR + апгрейд TFM.**
1. ADR: «UUIDv7 вместо ULID», supersedes ADR-019 (скилл `adr`). Зафиксировать: контрактный формат — канонический строковый UUID (36 символов, lowercase, с дефисами).
2. Поднять три C#-сервиса `net8.0 → net10.0` (текущий LTS): правка TFM, `dotnet build && dotnet test` зелёные. Отдельный коммит — это самостоятельная ценность.

**Итерация 1 — auction-service.**
1. Убрать пакет `Ulid`, тип `Ulid → Guid` во всех командах/событиях/состоянии/акторах.
2. Генерация новых ID — только `Guid.CreateVersion7()`.
3. Парсинг входа из NATS/gRPC: `Guid.TryParse` + reply с ошибкой вместо необработанного исключения (заодно закрывает известную хрупкость `Ulid.Parse` на мусорных сообщениях).
4. PersistenceId остаётся `auction-{id}` со строковым представлением Guid. Dev-журнал в PostgreSQL очистить (там ID в старом формате) — **согласовано этим ТЗ**.
5. `dotnet test` + e2e через nats-tester: `start_auction`/`place_bid` с UUIDv7-строкой.

**Итерация 2 — gateway, тулинг, доки.**
1. Rust: `uuid = { version = "1", features = ["v7"] }`; заменить константу в `constants.rs`; на входе внешних данных — без `unwrap()` (правило репо).
2. nats-tester: `uuid6`/`uuid_utils` или stdlib при Python 3.14.
3. Обновить AGENTS.md (строка про ULID/ADR-019), nats_subjects.md, README при упоминаниях.

## Критерии приёмки

- `grep -ri ulid` по `services/ tools/ contracts/` — ноль вхождений (кроме архива/ADR-истории).
- Все сборки и тесты зелёные (CI), e2e-ставка через nats-tester проходит.
- Мусорный `auction_id` в команде NATS не роняет хендлер — ошибка логируется/отвечается.
- Доки и ADR согласованы с кодом.

## Риски

- Смешение старых ULID и новых UUID в одном dev-журнале — лечится очисткой БД (см. Итерацию 1.4).
- Апгрейд на net10 может подтянуть несовместимости пакетов (Akka.NET, Grpc) — потому он вынесен в отдельную итерацию с зелёными тестами до любых замен ID.
