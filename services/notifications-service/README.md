# Notifications Service

Централизованный обработчик бизнес-событий для отправки уведомлений пользователям платформы Solguficky.

## Технологический стек

- **C# 12** / **.NET 8**
- **ASP.NET Core** - Minimal API для health checks
- **NATS.Client 1.1.8** - подписка на события и публикация команд
- **Google.Protobuf** - сериализация сообщений
- **Serilog** - структурированное JSON логирование
- **xUnit + Moq** - unit тестирование

## Ответственность (MVP)

Сервис обрабатывает событие `events.auction.bid-placed` и отправляет уведомления пользователям, чьи ставки были перебиты.

**Flow:**
1. Подписывается на `events.auction.bid-placed` в NATS
2. Декодирует Protobuf событие `BidPlacedEvent`
3. Проверяет наличие `previous_leader_id`
4. Формирует текст уведомления через шаблон
5. Публикует команду `commands.telegram.send_message` в NATS

## Архитектура

```
Domain/           - Interfaces (INatsPublisher)
Application/      - Handlers, Services, Templates
  ├── Handlers/       - BidPlacedHandler
  ├── Services/       - NatsPublisher, NatsEventListener
  └── Templates/      - NotificationTemplates
Program.cs        - DI, Serilog, Health checks
```

### Hardcoded Rules (MVP)

- **Правило:** Если `previous_leader_id != null` → отправить уведомление
- **Шаблон:** "❗ Ваша ставка в {previous_amount} рублей на лот '{lot_title}' была перебита..."

### Background Service

`NatsEventListener` - IHostedService, который:
- Создает NATS подписку при старте
- Обрабатывает события асинхронно
- Gracefully завершается при `CancellationToken`

## Контракты NATS

### Входящие события

**Subject:** `events.auction.bid-placed`

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

### Исходящие команды

**Subject:** `commands.telegram.send_message`

**Payload (Protobuf):**
```protobuf
message SendMessageCommand {
  int64 chat_id = 1;
  string text = 2;
  string parse_mode = 3;
}
```

## Конфигурация

### appsettings.json

```json
{
  "Nats": {
    "Url": "nats://localhost:4222",
    "Subjects": {
      "BidPlaced": "events.auction.bid-placed",
      "SendMessage": "commands.telegram.send_message"
    }
  }
}
```

### Environment Variables

```bash
NATS__URL=nats://nats:4222
NATS__SUBJECTS__BIDPLACED=events.auction.bid-placed
SERILOG__MINIMUMLEVEL__DEFAULT=Information
```

## Запуск

### Локально

См. [LOCAL_SETUP.md](LOCAL_SETUP.md)

### Docker

```bash
docker build -t notifications-service .
docker run -e NATS__URL=nats://host.docker.internal:4222 notifications-service
```

## Health Checks

- `GET /health` - проверка работоспособности
- `GET /` - возвращает "Notifications Service"

## Логирование

Все логи выводятся в `stdout` в JSON формате (Compact JSON Formatter):

```json
{
  "@t": "2025-10-29T12:00:00.000Z",
  "@l": "Information",
  "@mt": "Outbid notification sent to {UserId} for lot {LotId}",
  "UserId": 123,
  "LotId": 42
}
```

## Тестирование

```bash
dotnet test
```

## Будущее (post-MVP)

- ❌ PostgreSQL для хранения `notification_preferences`
- ❌ Отложенные уведомления (Hangfire/Quartz)
- ❌ gRPC клиент для Users Service
- ❌ Настройки уведомлений (enable/disable)
- ❌ Дополнительные события (`lot-sold`, `auction-finished`)

## Лицензия

См. [../../LICENSE](../../LICENSE)

