# ТЗ: Notifications Service (C# Implementation)

## 1. Ответственность

Сервис является **централизованным обработчиком бизнес-событий** для информирования пользователей через Telegram.

**Основная задача (MVP):** Обрабатывать событие `events.auction.bid_placed` и уведомлять пользователей, чьи ставки были перебиты.

Сервис инкапсулирует логику уведомлений:
1. **Формирование контента:** Преобразует событие `BidPlacedEvent` в человекочитаемое сообщение через шаблоны
2. **Определение получателей:** На основе `previous_leader_id` определяет, кому отправить уведомление
3. **Публикация команд:** Отправляет готовую команду `commands.telegram.send_message` в NATS

## 2. Технологии

**MVP Stack:**
- **Язык:** C# 12 (.NET 8)
- **Фреймворк:** ASP.NET Core (Minimal API для health checks)
- **NATS клиент:** NATS.Client 2.x (официальный .NET клиент)
- **Protobuf:** Google.Protobuf с protobuf-net для кодогенерации
- **Шаблоны:** Встроенные string templates или Scriban (легковесный)
- **Логирование:** Serilog с JSON formatter
- **Hosted Service:** IHostedService для NATS подписки

## 3. Архитектура

### 3.1. Компоненты

```
NotificationsService/
├── Domain/
│   ├── Events/           # Protobuf generated (BidPlacedEvent)
│   └── Commands/         # Protobuf generated (SendMessageCommand)
├── Application/
│   ├── Handlers/
│   │   └── BidPlacedHandler.cs    # Бизнес-логика обработки события
│   ├── Templates/
│   │   └── NotificationTemplates.cs  # Шаблоны уведомлений
│   └── Services/
│       ├── NatsEventListener.cs   # IHostedService для подписки на события
│       └── NatsPublisher.cs       # Публикация команд в NATS
├── Infrastructure/
│   └── Logging/
│       └── SerilogConfiguration.cs
└── Program.cs
```

### 3.2. Правила обработки (Hardcoded для MVP)

**Правило 1: Уведомление о перебитии ставки**
- **Триггер:** `events.auction.bid_placed` где `previous_leader_id != null`
- **Получатель:** `previous_leader_id` (пользователь, чью ставку перебили)
- **Шаблон:** "❗ Ваша ставка в {previous_amount} рублей на лот '{lot_title}' была перебита. Текущая максимальная ставка теперь составляет {amount} рублей."

### 3.3. Flow обработки

```
1. NatsEventListener подписывается на "events.auction.>"
2. Получает BidPlacedEvent из NATS
3. Декодирует Protobuf → BidPlacedEvent DTO
4. Передает в BidPlacedHandler
5. Handler:
   - Проверяет previous_leader_id != null
   - Рендерит шаблон с данными события
   - Формирует SendMessageCommand
6. NatsPublisher отправляет команду в "commands.telegram.send_message"
```

## 4. Внешние контракты (NATS)

### 4.1. Подписка на события (входящие)

**Subject:** `events.auction.bid_placed`

**Payload (Protobuf):**
```protobuf
message BidPlacedEvent {
  string event_id = 1;
  uint32 lot_id = 2;
  int64 user_id = 3;
  double amount = 4;
  optional int64 previous_leader_id = 5;
  int64 current_leader_id = 6;
  string lot_title = 7;
  double previous_amount = 8;
}
```

### 4.2. Публикуемые команды (исходящие)

**Subject:** `commands.telegram.send_message`

**Payload (Protobuf):**
```protobuf
message SendMessageCommand {
  int64 chat_id = 1;
  string text = 2;
  string parse_mode = 3;  // "" (plain text) или "HTML"
}
```

## 5. Конфигурация

### 5.1. appsettings.json

```json
{
  "Nats": {
    "Url": "nats://localhost:4222",
    "Subjects": {
      "BidPlaced": "events.auction.bid_placed",
      "SendMessage": "commands.telegram.send_message"
    }
  },
  "Serilog": {
    "MinimumLevel": {
      "Default": "Information"
    }
  }
}
```

### 5.2. Переменные окружения

```bash
# Обязательные
NATS__URL=nats://nats:4222

# Опциональные
LOG_LEVEL=Information
ASPNETCORE_ENVIRONMENT=Production
```

## 6. Структура проекта

```
services/notifications-service/
├── NotificationsService.sln
├── src/
│   └── NotificationsService/
│       ├── Application/
│       │   ├── Handlers/
│       │   │   └── BidPlacedHandler.cs
│       │   ├── Services/
│       │   │   ├── NatsEventListener.cs
│       │   │   └── NatsPublisher.cs
│       │   └── Templates/
│       │       └── NotificationTemplates.cs
│       ├── Domain/
│       │   ├── Generated/              # Protobuf generated code
│       │   │   ├── BidPlacedEvent.cs
│       │   │   └── SendMessageCommand.cs
│       │   └── INatsPublisher.cs       # Interface
│       ├── Infrastructure/
│       │   └── Logging/
│       │       └── SerilogConfig.cs
│       ├── appsettings.json
│       ├── appsettings.Development.json
│       ├── NotificationsService.csproj
│       ├── Program.cs
│       └── Protos/                     # Symlinks to contracts/
│           ├── nats/
│           │   ├── events/
│           │   │   └── auction_events.proto
│           │   └── commands/
│           │       └── telegram_commands.proto
├── tests/
│   └── NotificationsService.Tests/
│       ├── Handlers/
│       │   └── BidPlacedHandlerTests.cs
│       └── NotificationsService.Tests.csproj
├── Dockerfile
├── README.md
└── LOCAL_SETUP.md
```

## 7. Зависимости (NuGet)

```xml
<ItemGroup>
  <!-- NATS -->
  <PackageReference Include="NATS.Client" Version="2.0.0" />

  <!-- Protobuf -->
  <PackageReference Include="Google.Protobuf" Version="3.25.0" />
  <PackageReference Include="Grpc.Tools" Version="2.60.0" PrivateAssets="All" />

  <!-- Logging -->
  <PackageReference Include="Serilog.AspNetCore" Version="8.0.0" />
  <PackageReference Include="Serilog.Sinks.Console" Version="5.0.1" />
  <PackageReference Include="Serilog.Formatting.Compact" Version="2.0.0" />

  <!-- Testing -->
  <PackageReference Include="xunit" Version="2.6.0" />
  <PackageReference Include="xunit.runner.visualstudio" Version="2.5.0" />
  <PackageReference Include="Moq" Version="4.20.0" />
</ItemGroup>
```

## 8. Отличия от других CRUD сервисов

В отличие от Meetups Service / Identity Service, этот сервис:
- ❌ **Не имеет gRPC API** - только NATS consumer
- ❌ **Не имеет PostgreSQL** - нет персистентного состояния для MVP
- ✅ **Имеет IHostedService** - для long-running NATS подписки
- ✅ **Minimal API** - только для health checks (`/health`, `/ready`)

## 9. Roadmap (после MVP)

### Фаза 2: Расширение функционала
- [ ] Добавить уведомление "Вы выиграли лот" (`events.auction.lot_sold`)
- [ ] Добавить уведомление "Аукцион завершен" (`events.auction.finished`)

### Фаза 3: Настройки пользователей
- [ ] Добавить PostgreSQL для хранения `notification_preferences`
- [ ] gRPC endpoint для управления подписками
- [ ] Интеграция с Identity Service

### Фаза 4: Отложенные уведомления
- [ ] Добавить Hangfire / Quartz.NET для планирования
- [ ] Уведомления "Напоминание о начале аукциона за N часов"

### Фаза 5: Расширенные шаблоны
- [ ] Хранение шаблонов в БД
- [ ] Admin UI для редактирования шаблонов
- [ ] Поддержка локализации (RU/EN)

## 10. Метрики успеха

- **Latency:** < 100ms от получения события до отправки команды
- **Throughput:** 100+ событий/сек (достаточно для MVP)
- **Reliability:** 99.9% успешной доставки команд в NATS
- **Observability:** Все события логируются с metadata (user_id, lot_id)

