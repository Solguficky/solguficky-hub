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
├── Attributes/
│   ├── HandlesSubjectAttribute.cs   # Маркировка хендлеров для subjects
│   └── NatsSubjectAttribute.cs      # Маркировка команд для subjects (опционально)
├── Handlers/
│   ├── IEventHandler.cs             # Интерфейс обработчика событий
│   └── BidPlacedHandler.cs          # Обработчик события bid_placed
├── Services/
│   ├── INatsPublisher.cs            # Интерфейс публикации в NATS
│   ├── NatsPublisher.cs             # Реализация публикации
│   ├── NatsEventListener.cs         # IHostedService для подписки на NATS
│   └── EventDispatcher.cs           # Диспетчер событий к хендлерам
├── Templates/
│   └── NotificationTemplates.cs     # Шаблоны уведомлений
└── Program.cs
```

### 3.2. Правила обработки (Hardcoded для MVP)

**Правило 1: Уведомление о перебитии ставки**
- **Триггер:** `events.auction.bid_placed` где `previous_leader_id != null`
- **Получатель:** `previous_leader_id` (пользователь, чью ставку перебили)
- **Шаблон:** "❗ Ваша ставка в {previous_amount} рублей на лот '{lot_title}' была перебита. Текущая максимальная ставка теперь составляет {amount} рублей."

### 3.3. Flow обработки

```
1. NatsEventListener подписывается на "events.auction.>" (поддержка wildcards)
2. Получает Msg (subject + raw bytes) из NATS
3. Передает Msg в EventDispatcher
4. EventDispatcher:
   - Получает все зарегистрированные IEventHandler из Scoped DI
   - Вызывает handler.CanHandle(msg) для каждого:
     * Хендлер проверяет subject (fast path - без парсинга)
     * Парсит Protobuf если subject подходит
     * Проверяет бизнес-логику (previous_leader_id != null)
     * Кеширует распарсенное событие в поле класса
   - Для тех, кто вернул true, вызывает handler.HandleAsync(msg)
   - Собирает все команды
   - Публикует команды через INatsPublisher (маппинг типа → subject)
5. BidPlacedHandler (с атрибутом [HandlesSubject] для документации):
   - CanHandle проверяет subject == "events.auction.bid_placed"
   - Парсит и кеширует событие
   - HandleAsync использует кешированное событие (или парсит заново)
   - Рендерит шаблон с данными события
   - Возвращает SendMessageCommand
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
│       ├── Attributes/
│       │   ├── HandlesSubjectAttribute.cs
│       │   └── NatsSubjectAttribute.cs
│       ├── Handlers/
│       │   ├── IEventHandler.cs
│       │   └── BidPlacedHandler.cs
│       ├── Services/
│       │   ├── INatsPublisher.cs
│       │   ├── NatsPublisher.cs
│       │   ├── NatsEventListener.cs
│       │   └── EventDispatcher.cs
│       ├── Templates/
│       │   └── NotificationTemplates.cs
│       ├── obj/
│       │   └── Debug/net8.0/
│       │       └── nats/               # Protobuf generated code
│       │           ├── commands/
│       │           │   └── TelegramCommands.cs
│       │           └── events/
│       │               └── AuctionEvents.cs
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

## 9. Known Limitations (MVP)

### ChatId vs UserId
Currently, `SendMessageCommand` uses `user_id` directly as `chat_id`. This is a temporary MVP solution that assumes every user has a Telegram chat with the bot and their user_id equals the Telegram chat_id.

**Future improvement:**
- Create `NotifyUserCommand` with only `user_id` and notification content
- Separate service (or integration with Identity Service) to resolve `chat_id` from `user_id`
- Support multiple notification channels (Telegram, Email, Push notifications)
- User preferences for notification delivery methods

**Affected components:**
- `BidPlacedHandler.cs` - currently uses `evt.PreviousLeaderId` as `ChatId` directly
- `SendMessageCommand` proto contract - designed for Telegram-specific delivery

## 10. Roadmap (после MVP)

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

## 11. Архитектурные решения

### Event-Driven Architecture

**Проблема:** Сервис должен обрабатывать разные типы событий из разных subjects.

**Решение:** Handler-based архитектура с явной проверкой:
- `IEventHandler` работает с `Msg` (subject + raw bytes)
- `[HandlesSubject("events.auction.bid_placed")]` - атрибут для документации (не используется в runtime)
- `EventDispatcher` вызывает все зарегистрированные хендлеры
- Каждый хендлер сам проверяет subject в `CanHandle()`
- Scoped DI для кеширования распарсенных событий

**Преимущества:**
- Легко добавить новый хендлер для нового типа события
- Хендлер сам решает, парсить ли событие (fail-fast на проверке subject)
- Подписка на wildcard `events.auction.>` - получаем все события
- Каждый хендлер изолирован, ошибки не влияют друг на друга
- Нет рефлексии - все явно и прозрачно
- Хендлер может обрабатывать несколько subjects если нужно

### Кеширование в Scoped DI

**Проблема:** Protobuf парсинг может быть дважды (CanHandle + HandleAsync).

**Решение:**
- Хендлер создается через Scoped DI per message
- `_cachedEvent` - поле класса для кеширования
- `CanHandle` парсит и кеширует
- `HandleAsync` использует кеш или парсит заново (если CanHandle не вызывался)

**Trade-off:** Небольшая утечка состояния в хендлере, но значительное улучшение производительности.

### Command Publishing

**Проблема:** Хендлер не должен знать про NATS и subject mapping.

**Решение:**
- Хендлер возвращает `IEnumerable<IMessage>` (Protobuf команды)
- `EventDispatcher` сам публикует через `INatsPublisher`
- Маппинг типа команды → subject через `appsettings.json`

**Преимущества:**
- Хендлеры тестируются без NATS
- Централизованная логика публикации с ретраями/логированием
- Можно легко добавить батчинг/дедупликацию

### Multi-Subject Subscription

**Проблема:** Сервис может обрабатывать события из разных subjects.

**Решение:**
- `NatsEventListener` поддерживает массив subjects в конфиге
- Создает отдельную подписку для каждого subject
- Все события идут в один `EventDispatcher`

**Конфигурация:**
```json
"Subjects": {
  "Events": "events.auction.>" // Wildcard для всех событий аукциона
}
```

## 12. Метрики успеха

- **Latency:** < 100ms от получения события до отправки команды
- **Throughput:** 100+ событий/сек (достаточно для MVP)
- **Reliability:** 99.9% успешной доставки команд в NATS
- **Observability:** Все события логируются с metadata (user_id, lot_id)

