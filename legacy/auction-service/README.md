# Auction Service

> **Статус: Legacy/Frozen.** Сервис не входит в MVP и не развивается без явного запроса. Перед удалением из него нужно извлечь полезные доменные решения, actor/event-логику, тест-кейсы и непроверенные гипотезы. Целевое будущее аукциона описано отдельно и не является автоматической миграцией этого кода.

Stateful-прототип для проведения аукционов на платформе Solguficky.

## Описание

Сервис содержит прежнюю реализацию бизнес-логики торгов на **Akka.NET** с использованием **Event Sourcing**. Описание ниже относится к legacy-реализации, а не к архитектуре MVP.

### Основные возможности

- ✅ **Event Sourcing** — полная история всех событий аукциона
- ✅ **Акторная модель** — изоляция состояния каждого лота
- ✅ **Типобезопасность** — C# record types + nullable reference types
- ✅ **gRPC API** — синхронные запросы статуса
- ✅ **NATS интеграция** — обработка команд и публикация событий
- ✅ **Различные режимы торгов** — Slotted, Dutch, Vickrey, Hybrid
- ✅ **Анти-снайп механика** — продление таймера при ставках в конце
- ✅ **Proxy-bids** — автоматические ставки в стиле eBay

## Технологический стек

- **Язык:** C# 12 (.NET 8)
- **Фреймворк:** Akka.NET 1.5.x (Classic API)
- **Event Sourcing:** Akka.Persistence.PostgreSql
- **База данных:** PostgreSQL (Event Store)
- **gRPC:** Grpc.AspNetCore
- **NATS:** NATS.Client (официальный .NET клиент)
- **Тестирование:** xUnit + Akka.TestKit.Xunit2
- **Build Tool:** dotnet CLI

## Структура проекта

```
src/AuctionService/
├── Program.cs                      ← точка входа
├── Domain/                         ← бизнес-логика (Event Sourcing)
│   ├── Session/                    ← агрегат "Сессия аукциона"
│   │   ├── AuctionSessionActor.cs
│   │   ├── Commands.cs
│   │   ├── Events.cs
│   │   └── State.cs
│   ├── Lot/                        ← агрегат "Лот"
│   │   ├── LotActor.cs
│   │   ├── Commands.cs
│   │   ├── Events.cs
│   │   ├── Responses.cs
│   │   └── State.cs
│   └── AuctionRegistry.cs          ← корневой актор (роутер)
├── Application/                    ← use cases / API
│   ├── GrpcService.cs
│   └── NatsCommandHandler.cs
├── Infrastructure/                 ← техническая инфраструктура
│   ├── NatsClient.cs
│   ├── Serialization.cs
│   └── Persistence/
│       └── PersistenceSetup.cs
├── Protos/                         ← Protobuf контракты
│   └── auction_service.proto
└── appsettings.json                ← конфигурация
```

## Быстрый старт

### Предварительные требования

- .NET 8 SDK
- Docker и Docker Compose
- (Опционально) Rider/Visual Studio/VS Code для разработки

### Запуск через Docker

```bash
cd ../..
docker-compose up --build auction-service
```

### Локальная разработка

```bash
cd legacy/auction-service

dotnet restore
dotnet build
dotnet run --project src/AuctionService
```

**Тесты:**
```bash
dotnet test
```

**Hot Reload:**
```bash
dotnet watch run --project src/AuctionService
```

Подробная инструкция по локальной разработке: [LOCAL_SETUP.md](./LOCAL_SETUP.md)

## API

### gRPC (синхронные запросы)

```protobuf
service AuctionService {
  rpc GetAuctionStatus(GetAuctionStatusRequest) returns (AuctionStatusResponse);
  rpc GetLotDetails(GetLotDetailsRequest) returns (LotDetailsResponse);
}
```

**Порт:** 8080 (по умолчанию)

### NATS (асинхронные команды и события)

**Принимаемые команды:**
- `commands.auction.start` — начать аукцион
- `commands.auction.place_bid` — сделать ставку
- `commands.auction.admin.*` — админские команды

**Публикуемые события:**
- `events.auction.started` — аукцион начался
- `events.auction.bid_placed` — сделана ставка
- `events.auction.lot_sold` — лот продан
- `events.auction.finished` — аукцион завершен

## Архитектура

### Domain-Driven Design

Проект организован по принципам DDD:

- **domain/** — чистая бизнес-логика, не зависит от транспорта
- **application/** — координация use cases, обработка внешних запросов
- **infrastructure/** — технические детали (NATS, PostgreSQL, сериализация)

### Event Sourcing

Каждый агрегат (`AuctionSession`, `Lot`) реализован как `EventSourcedBehavior`:

1. **Команда** → валидация → **Событие** → сохранение в Event Store
2. **Событие** → применение к **State** → новое состояние
3. Recovery = replay событий из журнала

### Иерархия акторов

```
AuctionRegistry
    ├── AuctionSession (event-id-1)
    │   ├── Lot (lot-1)
    │   ├── Lot (lot-2)
    │   └── Lot (lot-3)
    └── AuctionSession (event-id-2)
        ├── Lot (lot-1)
        └── Lot (lot-2)
```

- **AuctionRegistry** — корневой актор, роутер к сессиям
- **AuctionSession** — координатор аукциона для одной сходки
- **Lot** — исполнитель логики торгов для одного лота

## Конфигурация

Основная конфигурация в `src/AuctionService/appsettings.json`.

### Переменные окружения

- `Nats__Url` — адрес NATS сервера (например, `nats://localhost:4222`)
- `Akka__Persistence__ConnectionString` — строка подключения к PostgreSQL Event Store
- `Grpc__Port` — порт для gRPC сервера (по умолчанию `8080`)

**Пример:**
```bash
export Nats__Url="nats://prod-nats:4222"
export Akka__Persistence__ConnectionString="Host=prod-db;Database=auction"
dotnet run
```

## Тестирование

```bash
dotnet test
```

**Конкретный тест:**
```bash
dotnet test --filter "FullyQualifiedName~LotActorTests.ShouldAcceptValidBid"
```

**С покрытием:**
```bash
dotnet test --collect:"XPlat Code Coverage"
```

### Типы тестов

- **Unit тесты** — `Akka.TestKit` для персистентных акторов
- **Integration тесты** — с TestContainers (PostgreSQL, NATS)

## Мониторинг и отладка

### Логирование

Все логи выводятся в JSON формате через Logback:

```bash
docker-compose logs -f auction-service
```

Централизованный просмотр через Grafana + Loki:

```bash
# Запуск стека логирования
docker-compose -f docker-compose.logging.yml up -d

# Grafana доступна на http://localhost:3000
```

### NATS мониторинг

```bash
# Подписка на все команды
nats sub "commands.auction.>" --server=localhost:4222

# Подписка на все события
nats sub "events.auction.>" --server=localhost:4222
```

### Event Store

```bash
# Подключение к PostgreSQL
docker exec -it postgres-db psql -U auction -d auction

# Просмотр журнала событий
SELECT * FROM journal ORDER BY sequence_number DESC LIMIT 10;

# Просмотр снапшотов
SELECT * FROM snapshot ORDER BY sequence_number DESC;
```

## Разработка

### Форматирование кода

```bash
dotnet format
```

### Cursor + C# Dev Kit

Проект настроен для работы с OmniSharp/Roslyn:

1. Открыть `AuctionService.sln` в Cursor
2. OmniSharp автоматически загрузит solution
3. Доступны: автокомплит, go to definition, errors, refactoring

### Соглашения

- **Короткие namespaces:** `AuctionService.Domain.Lot` вместо `Solguficky.AuctionService.Domain.Lot`
- **Immutability:** record types с `with`, `ImmutableList`
- **Команды в повелительном наклонении:** `PlaceBid`, `StartAuction`
- **События в прошедшем времени:** `BidPlaced`, `AuctionStarted`

Общие нормативные правила: [инженерные стандарты](../../docs/standards/README.md). Локальные ограничения сервиса: [AGENTS.md](./AGENTS.md).

## Документация

- **Историческая техническая спецификация:** [auction-service-akka-design.md](../../docs/archive/services/auction-service-akka-design.md)
- **ADR технологического стека legacy-сервиса:** [ADR-017](../../docs/decisions/ADR-017-auction-service-stack.md)
- **Будущее направление аукциона:** [auction-v2.md](../../docs/product/future/auction-v2.md)
- **Локальная разработка:** [LOCAL_SETUP.md](./LOCAL_SETUP.md)

## Лицензия

См. [LICENSE](../../LICENSE) в корне проекта.

## Контакты

Вопросы и предложения: открывайте issues в репозитории.

