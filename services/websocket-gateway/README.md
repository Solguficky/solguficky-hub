# WebSocket Gateway

Транспортный шлюз реального времени для трансляции событий аукциона из NATS в WebSocket-соединения Big Screen App и Admin Panel.

## Технологический стек

- **C# 12 / .NET 8**
- **ASP.NET Core SignalR** - WebSocket-соединения
- **NATS.Client 1.1.8** - подписка на события
- **Google.Protobuf** - десериализация событий
- **Serilog** - структурированное JSON логирование

## Ответственность

Сервис НЕ содержит бизнес-логики. Его задача:
1. Подписаться на события `events.auction.*` в NATS
2. Десериализовать Protobuf события
3. Преобразовать в JSON
4. Broadcast в SignalR группу `auction:live`

## Зависимости

- **NATS JetStream** - должен быть запущен на `nats://localhost:4222`
- **Auction Service** - публикует события в NATS

## Запуск локально

### Prerequisites

1. Запустить NATS:
```bash
docker run -p 4222:4222 nats:latest
```

2. Убедиться, что Auction Service запущен и публикует события

### Запуск сервиса

```bash
cd services/websocket-gateway/src/WebSocketGateway
dotnet run
```

Сервис запустится на `http://localhost:5000`

### Health Check

```bash
curl http://localhost:5000/health
```

## Запуск через Docker

### Build

```bash
cd services/websocket-gateway
docker build -t websocket-gateway .
```

### Run

```bash
docker run -p 5000:5000 \
  -e Nats__Url=nats://host.docker.internal:4222 \
  websocket-gateway
```

## Тестирование

### Unit тесты

```bash
cd services/websocket-gateway
dotnet test
```

### Тестирование подключения через браузер

1. Открыть консоль браузера на `http://localhost:3000`
2. Установить SignalR клиент:

```javascript
// Подключение
const connection = new signalR.HubConnectionBuilder()
    .withUrl("http://localhost:5000/auctionHub")
    .build();

// Обработчик событий
connection.on("Event", (event) => {
    console.log("Received event:", event);
    console.log("Type:", event.type);
    console.log("Data:", event.data);
});

// Подключение и подписка
await connection.start();
await connection.invoke("SubscribeToAuction");

console.log("Connected and subscribed to live auction channel");
```

3. Отправить тестовое событие через NATS Tester (см. `tools/nats-tester`)

## Конфигурация

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `Nats__Url` | `nats://localhost:4222` | NATS server URL |
| `ASPNETCORE_URLS` | `http://+:5000` | HTTP listening URLs |
| `ASPNETCORE_ENVIRONMENT` | `Development` | Environment name |

### appsettings.json

```json
{
  "Nats": {
    "Url": "nats://localhost:4222"
  },
  "SignalR": {
    "KeepAliveIntervalSeconds": 15,
    "ClientTimeoutIntervalSeconds": 30
  },
  "Serilog": {
    "MinimumLevel": {
      "Default": "Information"
    }
  }
}
```

## SignalR Hub API

### Эндпоинт

`ws://localhost:5000/auctionHub`

### Методы (Client → Server)

- `SubscribeToAuction()` - подписаться на канал `auction:live`
- `UnsubscribeFromAuction()` - отписаться от канала

### События (Server → Client)

- `Event(event)` - получение события

**Формат события:**
```typescript
{
  type: "bid_placed" | "lot_activated" | "unknown",
  data: {
    // event-specific fields
  },
  timestamp: 1234567890
}
```

**Пример `bid_placed`:**
```json
{
  "type": "bid_placed",
  "data": {
    "event_id": "event-123",
    "lot_id": 5,
    "user_id": 100,
    "amount": 1500.0,
    "previous_leader_id": 99,
    "current_leader_id": 100,
    "lot_title": "Rare Item",
    "previous_amount": 1000.0
  },
  "timestamp": 1730260800
}
```

## Архитектура

```
┌─────────────────┐
│  Big Screen App │
│   (TypeScript)  │
└────────┬────────┘
         │ WebSocket (SignalR)
         ↓
┌─────────────────┐
│ WebSocket       │
│ Gateway (C#)    │
└────────┬────────┘
         │ NATS Subscribe
         ↓
┌─────────────────┐
│ NATS JetStream  │
│ events.auction.*│
└─────────────────┘
```

**Поток данных:**

1. Auction Service → NATS (`events.auction.bid_placed`)
2. WebSocket Gateway слушает NATS → десериализует Protobuf
3. EventMapper → маппинг в JSON DTO
4. Broadcast в SignalR Group `auction:live`
5. Big Screen App получает событие → обновляет UI

## Логирование

Все логи пишутся в `stdout` в JSON формате через Serilog.

**Пример лога:**
```json
{
  "@t": "2025-10-29T10:30:00.123Z",
  "@l": "Information",
  "@mt": "Client connected",
  "ConnectionId": "abc123"
}
```

## MVP Limitations

- Один канал `auction:live` (без роутинга по auction_id)
- Поддержка только `BidPlacedEvent` сейчас
- Без Redis backplane (single instance)

## Roadmap

### Фаза 2
- [ ] Роутинг по auction_id через группы
- [ ] Поддержка дополнительных событий (LotActivated, LotSold)
- [ ] Отдельный Hub для Admin Panel

### Фаза 3
- [ ] Redis backplane для horizontal scaling
- [ ] Метрики активных соединений
- [ ] Dashboard для мониторинга

## Troubleshooting

### NATS connection failed

```
Failed to connect to NATS at nats://localhost:4222
```

**Решение:** Убедитесь, что NATS запущен:
```bash
docker ps | grep nats
```

### SignalR connection timeout

**Решение:** Проверьте CORS настройки в `Program.cs` - origin вашего фронтенда должен быть разрешен.

### No events received

**Решение:**
1. Проверьте, что Auction Service публикует события в NATS
2. Проверьте логи WebSocket Gateway
3. Используйте NATS Tester для отправки тестового события

## License

MIT


