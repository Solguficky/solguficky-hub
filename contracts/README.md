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
5. Сгенерировать код для нужных языков в CI/CD пайплайнах сервисов.

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
- **CI/CD** - автоматическая кодогенерация.
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

## 👑 Принципы управления контрактами

- **Git** - единственный источник правды (Source of Truth) для `.proto` файлов.
- **CI/CD** - автоматическая кодогенерация.

## 🧬 Эволюция контрактов

- **Никогда не удалять поля** существующих сообщений.
- **Никогда не переименовывать поля** существующих сообщений.
- **Никогда не изменять номера тегов** существующих полей.

##  NATS сообщения

### Команды (Commands)

Сообщение **ДОЛЖНО** содержать следующие заголовки:

- **`Content-Type: application/x-protobuf`**

### События (Events)

Сообщение **ДОЛЖНО** содержать следующие заголовки:

- **`Content-Type: application/x-protobuf`**

## Дополнительные ресурсы

- [Protocol Buffers Language Guide](https://protobuf.dev/programming-guides/proto3/)
- [Архитектура платформы](../docs/01_ARCHITECTURE/architechture.md)
- [NATS Subjects](../docs/03_CONTRACTS/nats_subjects.md)

