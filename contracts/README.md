# Контракты платформы Solguficky

Этот каталог содержит все Protobuf схемы для асинхронной (NATS) и синхронной (gRPC) коммуникации между сервисами.

## Структура

```
contracts/
├── proto/
│   ├── common/               # Общие типы, переиспользуемые везде
│   │   └── types.proto       # UUID, Money, Timestamp и т.д.
│   ├── nats/                 # Контракты для NATS сообщений
│   │   ├── commands/         # Команды (намерения изменить состояние)
│   │   │   └── auction_commands.proto
│   │   └── events/           # События (факты о произошедших изменениях)
│   │       └── auction_events.proto
│   └── grpc/                 # gRPC сервисные контракты
│       └── (будет добавлено позже)
└── README.md                 # Этот файл
```

## Принципы именования

### NATS контракты

#### Команды (Commands)
- **Формат:** `<Действие><Сущность>Command`
- **Примеры:** `PlaceBidCommand`, `CreateEventCommand`, `UpdateUserCommand`
- **Пакет:** `nats.commands`
- **Файлы:** Группируются по доменам (`auction_commands.proto`, `event_commands.proto`)

#### События (Events)
- **Формат:** `<Сущность><Действие>Event` (прошедшее время)
- **Примеры:** `BidPlacedEvent`, `EventCreatedEvent`, `UserUpdatedEvent`
- **Пакет:** `nats.events`
- **Файлы:** Группируются по доменам (`auction_events.proto`, `event_events.proto`)

### gRPC контракты

- **Формат:** `<Домен>Service`
- **Примеры:** `AuctionService`, `EventsService`, `UsersService`
- **Пакет:** `grpc.<домен>`
- **Файлы:** Один файл на сервис (`auction_service.proto`)

## Правила работы со схемами

### Добавление новой схемы

1. Создать `.proto` файл в соответствующей папке
2. Использовать `syntax = "proto3";`
3. Указать правильный пакет (`nats.commands`, `nats.events`, `grpc.<домен>`)
4. Добавить комментарии к полям
5. Зарегистрировать схему в Apicurio Registry (автоматически при старте сервиса)

### Изменение существующей схемы

**Правила обратной совместимости:**

✅ **Можно:**
- Добавлять новые поля (используя новые номера)
- Помечать поля как `optional`
- Добавлять новые сообщения
- Добавлять новые enum значения

❌ **Нельзя:**
- Удалять или переименовывать поля
- Изменять номера полей
- Изменять типы полей
- Изменять `repeated` на не-`repeated` и наоборот

### Версионирование

- **Git** - единый источник правды для схем
- **Apicurio Registry** - управление версиями в рантайме
- При breaking changes создавать новый файл с суффиксом версии (`_v2.proto`)

## Кодогенерация

Каждый сервис генерирует код из `.proto` файлов при компиляции:

### Rust (prost)
```rust
// build.rs
prost_build::compile_protos(
    &["../../contracts/proto/nats/commands/auction_commands.proto"],
    &["../../contracts/proto"],
)?;
```

### C# (Grpc.Tools)
```xml
<Protobuf Include="..\..\contracts\proto\grpc\auction_service.proto" />
```

### Scala (ScalaPB)
```scala
PB.targets in Compile := Seq(
  scalapb.gen() -> (sourceManaged in Compile).value
)
```

### Elixir (protobuf-elixir)
```elixir
defmodule Contracts.MixProject do
  use Mix.Project

  def project do
    [
      app: :contracts,
      elixirc_paths: ["lib", "gen"]
    ]
  end
end
```

## Регистрация в Apicurio

Схемы автоматически регистрируются при старте сервиса:

```rust
apicurio.register_schema(
    "nats-commands",              // group_id
    "PlaceBidCommand",            // artifact_id
    include_str!("path/to/file"), // schema content
).await?;
```

**Группы (Groups):**
- `nats-commands` - NATS команды
- `nats-events` - NATS события
- `grpc-services` - gRPC сервисы

**Артефакты (Artifacts):** Имя сообщения (например, `PlaceBidCommand`)

## Примеры использования

### NATS Command

```protobuf
message PlaceBidCommand {
  string op_id = 1;        // UUID для идемпотентности
  string event_id = 2;     // ID сходки
  uint32 lot_id = 3;       // ID лота
  int64 user_id = 4;       // Telegram user ID
  double amount = 5;       // Сумма ставки в рублях
}
```

**Subject:** `commands.auction.place-bid`
**Headers:** `schema-id: <globalId из Apicurio>`

### NATS Event

```protobuf
message BidPlacedEvent {
  string event_id = 1;
  uint32 lot_id = 2;
  int64 user_id = 3;
  double amount = 4;
  optional int64 previous_leader_id = 5;
  int64 current_leader_id = 6;
}
```

**Subject:** `events.auction.bid-placed`
**Headers:** `schema-id: <globalId из Apicurio>`

## Дополнительные ресурсы

- [Protocol Buffers Language Guide](https://protobuf.dev/programming-guides/proto3/)
- [Apicurio Registry Documentation](https://www.apicur.io/registry/docs/)
- [Архитектура платформы](../docs/01_ARCHITECTURE/architechture.md)
- [NATS Subjects](../docs/03_CONTRACTS/nats_subjects.md)

