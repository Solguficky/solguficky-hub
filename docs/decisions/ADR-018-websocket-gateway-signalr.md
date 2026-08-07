# ADR-018: WebSocket Gateway на C# + SignalR для MVP

**Дата**: 29.10.2025

**Статус**: Принято

### Контекст

Для поддержки Big Screen App и Admin Panel требуется сервис, который будет проталкивать события из NATS в WebSocket-соединения клиентов в реальном времени.

Изначально в архитектуре планировался `Real-Time Hub` на Elixir + Phoenix, но для MVP это избыточная сложность.

**Требования MVP:**
- Проталкивать события `events.auction.*` из NATS в WebSocket
- Поддержка подписок на конкретный аукцион (роутинг по auction_id)
- Автоматический reconnect на клиенте
- 50+ одновременных соединений

### Рассмотренные варианты

**1. Elixir + Phoenix Channels**
- ✅ Идеально для масштабирования (10k+ соединений)
- ✅ Phoenix.PubSub для distributed pub/sub
- ⚠️ Новый язык в стеке для MVP
- ⚠️ Дополнительная сложность настройки

**2. C# + SignalR**
- ✅ Единообразие стека (все сервисы на C#)
- ✅ SignalR — production-ready (используется в Microsoft Teams)
- ✅ Автоматический reconnect и fallback
- ✅ Быстрый старт
- ⚠️ Требует Redis backplane для horizontal scaling

**3. Raw WebSocket на C#**
- ⚠️ Нужно вручную реализовать reconnect, heartbeat
- ⚠️ Нет ready-made роутинга (groups)
- ⚠️ Больше кода, больше багов

### Решение

**Используем C# + ASP.NET Core + SignalR для MVP.**

**Переименование:** `Real-Time Hub` → `WebSocket Gateway` (более точное название).

### Обоснование

#### Почему C# + SignalR для MVP?

1. **Единообразие стека:**
   - Все сервисы уже на C#
   - Один набор инструментов, один язык
   - Проще онбординг разработчиков

2. **SignalR — production-ready:**
   - Используется в Microsoft Teams, Azure DevOps
   - Автоматический reconnect из коробки
   - Fallback на long-polling если WebSocket недоступен
   - Typed hubs с строгими контрактами

3. **SignalR Groups для роутинга:**
   - Клиент подписывается на `auction:123`
   - События проталкиваются только в нужную группу
   - Не нужно писать роутинг вручную

4. **Быстрый старт:**
   - `dotnet new webapi` → добавить SignalR → готово
   - Не нужно изучать Elixir/Phoenix для MVP

#### Почему не Elixir сразу?

- Для MVP ожидается 50-100 одновременных соединений
- C# + SignalR легко справляется с такой нагрузкой
- Нет смысла вводить новый язык пока нет проблем с масштабированием

### Архитектура

**Компоненты:**
```
WebSocketGateway/
├── Hubs/
│   └── AuctionHub.cs          # SignalR Hub (клиентский API)
├── Services/
│   ├── NatsEventListener.cs   # Подписка на events.auction.*
│   └── EventBroadcaster.cs    # Роутинг в SignalR Groups
└── Program.cs
```

**Поток данных:**
1. `Auction Service` публикует `BidPlacedEvent` → NATS
2. `NatsEventListener` получает событие
3. `EventBroadcaster` извлекает `auction_id` из события
4. `EventBroadcaster` отправляет в SignalR Group `auction:{id}`
5. `Big Screen App` (подписан на group) → получает JSON event
6. Frontend обновляет UI

**Роутинг через SignalR Groups:**
```csharp
await _hubContext.Clients
    .Group($"auction:{auctionId}")
    .SendAsync("AuctionEvent", eventData, ct);
```

### Последствия

#### Позитивные

- ✅ **Быстрый старт** — знакомый стек, нет learning curve
- ✅ **SignalR автоматизирует сложности** — reconnect, fallback, heartbeat
- ✅ **Groups из коробки** — не нужно писать роутинг
- ✅ **Единообразие** — все сервисы на C#, одни инструменты
- ✅ **TypeScript клиент** — официальная библиотека `@microsoft/signalr`
- ✅ **Достаточно для MVP** — 50-100 соединений не проблема

#### Негативные

- ⚠️ **Масштабирование** — для >1000 соединений нужен Redis backplane
- ⚠️ **Memory footprint** — C# тяжелее Elixir (~200MB vs ~50MB)
- ⚠️ **Horizontal scaling сложнее** — нужен Redis или sticky sessions

#### Миграционный путь

**Промежуточный этап (1000+ соединений):**
```csharp
services.AddSignalR()
    .AddStackExchangeRedis("redis:6379");
```
Позволяет horizontal scaling C# сервиса.

**Финальный этап (10k+ соединений):**
- Миграция на Elixir + Phoenix Channels
- Архитектура остается той же (NATS → WebSocket)
- Backend контракты (Protobuf) не меняются
- Клиенты обновляют JS библиотеку (SignalR → Phoenix)

### Итоговое решение

**Для MVP используем C# + SignalR** с последующей миграцией на Elixir при необходимости.

**Переименование:** `Real-Time Hub` → `WebSocket Gateway` (точнее описывает роль).

**Технологии:**
- C# 12 / .NET 8
- ASP.NET Core SignalR
- NATS.Client для подписки на события
- Serilog для логирования

**Критерии миграции на Elixir:**
- >1000 одновременных WebSocket соединений
- Проблемы с memory footprint
- Нужен distributed pub/sub без Redis

### Связанные решения

- **ADR-011**: Разделение Notifications Service и WebSocket Gateway
- **ADR-007**: Полиглотная модель (каждый язык под свою задачу)
- **ADR-001**: Микросервисная архитектура с хореографией

---
