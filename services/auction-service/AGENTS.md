# Auction Service (C# + Akka.NET)

Stateful-сервис аукционов: Event Sourcing + CQRS на Akka.Persistence (PostgreSQL). Статус: **Legacy**, сервис не входит в MVP сходок. Не наращивай фичи без явного запроса; пока код остаётся в active tree, сохраняй сборку и тесты.

Этот файл содержит только service-specific delta. Общие требования к тестированию, контрактам и логированию наследуются из [docs/standards](../../docs/standards/README.md).

## Структура

- `Actors/AuctionRegistry.cs` — роутер: находит/создаёт `AuctionActor` по UUIDv7 (ADR-020).
- `Actors/Auction/` — агрегат аукциона: фазы `NotStarted → OpenBidding → Idle → Final → Finished`. Файлы: `AuctionActor.cs`, `Commands.cs`, `Events.cs`, `State.cs`, `Responses.cs`, `Types.cs`.
- `Actors/Lot/` — дочерний актор лота: ставки, proxy-bids. PersistenceId: `auction-{uuid}` / `lot-{id}`.
- `Handlers/NatsCommandHandler.cs` — подписки на `commands.auction.*` (Protobuf → доменные команды → registry).
- `Handlers/AkkaPersistenceQueryListener.cs` — читает журнал по тегу `auction` (EventsByTag), публикует события в NATS.
- `Infrastructure/` — NatsPublisher, AuctionEventTagger (тегирует события для Persistence.Query), EF Core (`AuctionDbContext`, `LotEntity`) для CRUD лотов.
- `Services/` — gRPC (queries + CRUD лотов), `LotRepository`.

## Правила

- Паттерн актора: `Command → Validate → Persist(Event) → Apply → Reply`. Изменение состояния ТОЛЬКО в Apply-методах (они же используются в Recover).
- Новое событие ⇒ добавь его в `event-adapter-bindings` в `Program.cs`, иначе оно не попадёт в тег `auction` и не уйдёт в NATS.
- NATS-темы — только через константы `Constants/NatsSubjects.cs`.
- Деньги пока `double` — известный техдолг, не копируй этот подход в новые контракты.

## Запуск

```bash
# Предпочтительно: профиль infra из infra/apphost; compose остаётся fallback
dotnet run --project src/AuctionService
dotnet test
```
