# WebSocket Gateway - Local Setup

Инструкция по запуску WebSocket Gateway локально для разработки и тестирования.

## Prerequisites

1. **.NET 8 SDK**
   ```bash
   dotnet --version
   # Должно быть >= 8.0
   ```

2. **NATS Server**

   Запустить через Docker:
   ```bash
   docker run -d --name nats -p 4222:4222 nats:latest
   ```

   Или через Docker Compose (если используется в проекте):
   ```bash
   cd tools/docker
   docker-compose up -d nats
   ```

3. **Опционально: Auction Service**

   Для получения реальных событий нужно запустить Auction Service, который будет публиковать события в NATS.

## Установка зависимостей

```bash
cd services/websocket-gateway
dotnet restore
```

## Сборка

```bash
dotnet build
```

## Запуск тестов

```bash
dotnet test
```

Должны пройти все 3 теста:
- `MapEvent_BidPlacedEvent_ReturnsCorrectDto`
- `MapEvent_UnknownSubject_ReturnsUnknownDto`
- `MapEvent_InvalidProtobuf_ReturnsNull`

## Запуск сервиса

### Вариант 1: dotnet run

```bash
cd src/WebSocketGateway
dotnet run
```

Сервис запустится на `http://localhost:5000`

### Вариант 2: dotnet watch (с hot reload)

```bash
cd src/WebSocketGateway
dotnet watch run
```

### Проверка health check

```bash
curl http://localhost:5000/health
```

Должен вернуть `200 OK`

## Тестирование WebSocket подключения

### Через браузер (Chrome DevTools)

1. Открыть любую страницу (например, `http://localhost:3000`)
2. Открыть Console (F12)
3. Вставить и выполнить:

```javascript
// 1. Подключиться к SignalR Hub
const connection = new signalR.HubConnectionBuilder()
    .withUrl("http://localhost:5000/auctionHub")
    .configureLogging(signalR.LogLevel.Information)
    .build();

// 2. Зарегистрировать обработчик события
connection.on("Event", (event) => {
    console.log("📨 Received event:");
    console.log("  Type:", event.type);
    console.log("  Data:", event.data);
    console.log("  Timestamp:", new Date(event.timestamp * 1000));
});

// 3. Подключиться
await connection.start();
console.log("✅ Connected to WebSocket Gateway");

// 4. Подписаться на live канал
await connection.invoke("SubscribeToAuction");
console.log("✅ Subscribed to auction:live channel");
```

4. Теперь все события из NATS `events.auction.>` будут появляться в консоли

### Отправка тестового события

Используйте NATS Tester для отправки тестового события:

```bash
cd tools/nats-tester
cargo run -- publish bid-placed \
  --event-id "test-123" \
  --lot-id 5 \
  --user-id 100 \
  --amount 1500.0 \
  --lot-title "Test Lot"
```

В консоли браузера должно появиться:
```
📨 Received event:
  Type: bid_placed
  Data: { event_id: "test-123", lot_id: 5, ... }
  Timestamp: ...
```

## Конфигурация

### Environment Variables

Создать файл `src/WebSocketGateway/appsettings.Development.json`:

```json
{
  "Nats": {
    "Url": "nats://localhost:4222"
  },
  "Serilog": {
    "MinimumLevel": {
      "Default": "Debug"
    }
  }
}
```

### Изменение NATS URL

```bash
export NATS__URL=nats://localhost:4222
dotnet run
```

## Логирование

Все логи пишутся в `stdout` в JSON формате.

### Уровни логирования

В Development режиме установлен уровень `Debug`. Для изменения:

```json
{
  "Serilog": {
    "MinimumLevel": {
      "Default": "Information"
    }
  }
}
```

### Просмотр логов

```bash
dotnet run | jq .
```

(требуется установленный `jq` для форматирования JSON)

## Troubleshooting

### Error: Failed to connect to NATS

**Проблема:** Сервис не может подключиться к NATS.

**Решение:**
1. Проверить, что NATS запущен:
   ```bash
   docker ps | grep nats
   ```

2. Проверить логи NATS:
   ```bash
   docker logs nats
   ```

3. Попробовать подключиться вручную:
   ```bash
   telnet localhost 4222
   ```

### Error: SignalR connection failed

**Проблема:** Браузер не может подключиться к SignalR Hub.

**Решение:**
1. Проверить CORS настройки в `Program.cs`
2. Добавить свой origin в список разрешенных:
   ```csharp
   policy.WithOrigins("http://localhost:3000", "http://localhost:5173", "your-origin-here")
   ```

### No events received

**Проблема:** Подключение есть, но события не приходят.

**Решение:**
1. Проверить логи WebSocket Gateway - должны быть сообщения "Event broadcasted to live channel"
2. Проверить, что вызвали `connection.invoke("SubscribeToAuction")`
3. Отправить тестовое событие через NATS Tester
4. Проверить, что EventMapper корректно маппит события

## Hot Reload

При использовании `dotnet watch run` изменения в коде автоматически применяются без перезапуска.

**Что перезагружается:**
- Изменения в `.cs` файлах
- Изменения в `appsettings.json`

**Что требует перезапуска:**
- Изменения в `.csproj`
- Добавление новых NuGet пакетов

## IDE Setup

### Visual Studio Code

Расширения:
- C# Dev Kit
- C# Extensions

### JetBrains Rider

Открыть `WebSocketGateway.sln` в Rider.

## Docker Build (локально)

```bash
cd services/websocket-gateway
docker build -t websocket-gateway:local .
```

### Запуск контейнера

```bash
docker run -it --rm \
  -p 5000:5000 \
  -e Nats__Url=nats://host.docker.internal:4222 \
  websocket-gateway:local
```

**Note:** `host.docker.internal` используется для доступа к NATS на хост-машине из Docker контейнера.

## Полезные команды

```bash
# Очистка сборки
dotnet clean

# Полная пересборка
dotnet clean && dotnet restore && dotnet build

# Запуск только одного теста
dotnet test --filter "FullyQualifiedName~MapEvent_BidPlacedEvent_ReturnsCorrectDto"

# Проверка code coverage
dotnet test /p:CollectCoverage=true

# Форматирование кода
dotnet format
```


