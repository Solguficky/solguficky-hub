# ТЗ: WebSocket Gateway (C# Implementation)

> **Historical / Legacy.** Описывает замороженный gateway для `auction:live`, который не входит в MVP.

## 1. Ответственность

Сервис является **транспортным шлюзом реального времени** между бэкенд-платформой и фронтенд-клиентами (такими как `Big Screen App` и `Admin Panel`). Его единственная задача — эффективно управлять WebSocket-соединениями и проталкивать в них релевантные события из шины NATS.

**Сервис НЕ должен содержать сложной бизнес-логики.** Он является "глупым", но сверхбыстрым прокси для событий.

**Основная задача (MVP):** Проталкивать события `events.auction.*` из NATS в WebSocket-соединения клиентов, подписанных на конкретный аукцион.

## 2. Технологии

**MVP Stack:**
- **Язык:** C# 12 (.NET 8)
- **Фреймворк:** ASP.NET Core с SignalR
- **NATS клиент:** NATS.Client 2.x (официальный .NET клиент)
- **Protobuf:** Google.Protobuf для десериализации событий
- **Логирование:** Serilog с JSON formatter
- **Hosted Service:** IHostedService для NATS подписки

**Заметка:** Для MVP используется C# + SignalR, что обеспечивает быстрый старт и единообразие стека. В будущем, при необходимости масштабирования до тысяч одновременных соединений, возможна миграция на Elixir + Phoenix.

## 3. Архитектура

### 3.1. Компоненты

```
WebSocketGateway/
├── Hubs/
│   └── AuctionHub.cs                # SignalR Hub для auction events
├── Services/
│   ├── NatsEventListener.cs         # IHostedService для подписки на NATS
│   ├── WebSocketConnectionManager.cs # Управление подписками
│   └── EventBroadcaster.cs          # Роутинг событий в SignalR Groups
├── Models/
│   └── AuctionEvent.cs              # DTO для событий
└── Program.cs
```

### 3.2. Поток данных

```
1. Auction Service публикует BidPlacedEvent → NATS (events.auction.bid_placed)
2. NatsEventListener получает событие → десериализует Protobuf
3. EventBroadcaster извлекает auction_id из события
4. EventBroadcaster отправляет событие в SignalR Group "auction:{auction_id}"
5. Big Screen App (подписан на "auction:123") → получает JSON event
6. Frontend обновляет UI (текущая ставка, лидер)
```

### 3.3. SignalR Hub

```csharp
public class AuctionHub : Hub
{
    public async Task SubscribeToAuction(string auctionId)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, $"auction:{auctionId}");
    }

    public async Task UnsubscribeFromAuction(string auctionId)
    {
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"auction:{auctionId}");
    }
}
```

### 3.4. NATS Event Listener

```csharp
public class NatsEventListener : BackgroundService
{
    private readonly IHubContext<AuctionHub> _hubContext;
    private readonly IConnection _natsConnection;

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var subscription = _natsConnection.SubscribeAsync("events.auction.>");

        await foreach (var msg in subscription.Messages.WithCancellation(ct))
        {
            await ProcessEventAsync(msg, ct);
        }
    }

    private async Task ProcessEventAsync(Msg msg, CancellationToken ct)
    {
        var auctionId = ExtractAuctionId(msg);
        var payload = DeserializeEvent(msg);

        await _hubContext.Clients
            .Group($"auction:{auctionId}")
            .SendAsync("AuctionEvent", payload, ct);
    }
}
```

## 4. Внешние контракты

### 4.1. WebSocket API (SignalR)

**Эндпоинт:** `wss://<host>/auctionHub`

**Client → Server (подписка):**
```typescript
connection.invoke("SubscribeToAuction", "123");
connection.invoke("UnsubscribeFromAuction", "123");
```

**Server → Client (события):**
```typescript
connection.on("AuctionEvent", (event) => {
    console.log(event.type);  // "bid_placed" | "lot_activated" | ...
    console.log(event.data);  // { lot_id, amount, bidder_name, ... }
});
```

### 4.2. Подписка на NATS

**Subject:** `events.auction.>` (многотокенный wildcard для всех событий аукциона; `*` матчит ровно один токен и не подошёл бы)

**События:**
- `events.auction.bid_placed` → `BidPlacedEvent`
- `events.auction.lot_activated` → `LotActivatedEvent`
- `events.auction.lot_sold` → `LotSoldEvent`
- `events.auction.session_started` → `SessionStartedEvent`

**Формат:** Protobuf (десериализуется в зависимости от subject)

## 5. Конфигурация

### 5.1. appsettings.json

```json
{
  "Nats": {
    "Url": "nats://localhost:4222",
    "Subject": "events.auction.>"
  },
  "SignalR": {
    "KeepAliveInterval": "00:00:15",
    "ClientTimeoutInterval": "00:00:30"
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
NATS__URL=nats://nats:4222
ASPNETCORE_URLS=http://+:5000
ASPNETCORE_ENVIRONMENT=Production
```

## 6. Структура проекта

```
services/websocket-gateway/
├── WebSocketGateway.sln
├── src/
│   └── WebSocketGateway/
│       ├── Hubs/
│       │   └── AuctionHub.cs
│       ├── Services/
│       │   ├── NatsEventListener.cs
│       │   ├── EventBroadcaster.cs
│       │   └── WebSocketConnectionManager.cs
│       ├── Models/
│       │   └── AuctionEvent.cs
│       ├── Protos/                    # Symlinks to contracts/
│       │   └── nats/events/
│       │       └── auction_events.proto
│       ├── appsettings.json
│       ├── appsettings.Development.json
│       ├── WebSocketGateway.csproj
│       └── Program.cs
├── tests/
│   └── WebSocketGateway.Tests/
│       ├── Services/
│       │   └── EventBroadcasterTests.cs
│       └── WebSocketGateway.Tests.csproj
├── Dockerfile
├── README.md
└── LOCAL_SETUP.md
```

## 7. Зависимости (NuGet)

```xml
<ItemGroup>
  <!-- SignalR -->
  <PackageReference Include="Microsoft.AspNetCore.SignalR.Core" Version="1.1.0" />

  <!-- NATS -->
  <PackageReference Include="NATS.Client" Version="2.0.0" />

  <!-- Protobuf -->
  <PackageReference Include="Google.Protobuf" Version="3.25.0" />
  <PackageReference Include="Grpc.Tools" Version="2.60.0" PrivateAssets="All" />

  <!-- Logging -->
  <PackageReference Include="Serilog.AspNetCore" Version="8.0.0" />
  <PackageReference Include="Serilog.Sinks.Console" Version="5.0.1" />

  <!-- Testing -->
  <PackageReference Include="xUnit" Version="2.6.0" />
  <PackageReference Include="Moq" Version="4.20.0" />
</ItemGroup>
```

## 8. Отличия от других сервисов

В отличие от Notifications Service:
- ✅ **Двусторонняя коммуникация** - клиенты подписываются через SignalR
- ✅ **Stateful соединения** - нужно управлять WebSocket connections
- ✅ **Нет бизнес-логики** - просто пробрасывает события
- ✅ **SignalR Groups** - для роутинга по auction_id
- ❌ **Не формирует контент** - передает события "как есть"

## 9. Roadmap

### MVP (текущий)
- [x] SignalR Hub для auction events
- [x] Подписка на `events.auction.>` в NATS
- [x] Роутинг по auction_id через SignalR Groups
- [x] Десериализация Protobuf событий

### Фаза 2: Дополнительные каналы
- [ ] Добавить Hub для Admin Panel (`AdminHub`)
- [ ] Поддержка приватных уведомлений (по user_id)
- [ ] Heartbeat для отслеживания активных соединений

### Фаза 3: Мониторинг
- [ ] Метрики количества активных соединений
- [ ] Dashboard для мониторинга WebSocket health
- [ ] Alerts при разрыве соединений

### Будущее: Масштабирование
- [ ] Redis backplane для horizontal scaling
- [ ] Миграция на Elixir + Phoenix при >1000 соединений
- [ ] Distributed pub/sub через Phoenix.PubSub

## 10. Архитектурные решения

### Почему SignalR, а не raw WebSocket?

**Проблема:** Raw WebSocket требует ручного управления reconnect, heartbeat, fallback.

**Решение:** SignalR предоставляет:
- Автоматический reconnect
- Fallback на long-polling если WebSocket недоступен
- Typed hubs с строгими контрактами
- Группы для роутинга

### Почему Groups, а не broadcast всем?

**Проблема:** Не все клиенты интересуются всеми аукционами.

**Решение:** SignalR Groups:
- Клиент подписывается на `auction:123`
- События проталкиваются только в нужную группу
- Экономия трафика и CPU

### Protobuf → JSON конвертация

**Проблема:** NATS использует Protobuf, но JavaScript клиенты ожидают JSON.

**Решение:** Десериализация в C# → отправка JSON через SignalR:
```csharp
var protobufEvent = BidPlacedEvent.Parser.ParseFrom(msg.Data);
var jsonEvent = new {
    type = "bid_placed",
    data = new {
        lot_id = protobufEvent.LotId,
        amount = protobufEvent.Amount,
        bidder_name = protobufEvent.BidderName
    }
};
await _hubContext.Clients.Group(...).SendAsync("AuctionEvent", jsonEvent);
```

## 11. Метрики успеха

- **Latency:** < 200ms от публикации события в NATS до получения клиентом
- **Throughput:** 50+ событий/сек (достаточно для MVP с 1-2 аукционами одновременно)
- **Concurrent connections:** 50+ одновременных WebSocket соединений
- **Reliability:** Автоматический reconnect при разрыве соединения

## 12. Миграционный путь

Когда потребуется масштабирование (>1000 соединений):

1. **Redis Backplane (промежуточный этап):**
   ```csharp
   services.AddSignalR()
       .AddStackExchangeRedis("redis:6379");
   ```
   Позволяет horizontal scaling C# сервиса.

2. **Миграция на Elixir + Phoenix:**
   - Архитектура остается той же (NATS → WebSocket)
   - Протокол SignalR заменяется на Phoenix Channels
   - Клиенты обновляют библиотеку подключения
   - Backend контракты (Protobuf) не меняются

