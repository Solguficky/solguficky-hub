# ТЗ (Живой документ): Auction Service

## 1. Ответственность

Сервис полностью отвечает за **проведение торгов** в рамках одной сходки. Он является "владельцем" всей бизнес-логики, связанной с аукционами.

## 2. Технологии

*   **Язык:** C# 12 (.NET 8)
*   **Фреймворк:** Akka.NET 1.5.x (Classic API) с Akka.Persistence
*   **База данных:** PostgreSQL (Event Store для Akka.Persistence)
*   **Build Tool:** dotnet CLI
*   **Коммуникация:**
    *   **Асинхронная:** NATS JetStream через `NATS.Client` (официальный .NET клиент)
    *   **Синхронная:** gRPC через `Grpc.AspNetCore`
*   **Сериализация:** Protobuf (схемы хранятся в `contracts/proto/`, кодогенерация через `Grpc.Tools`)
*   **Тестирование:** xUnit + Akka.TestKit.Xunit2
*   **Логирование:** Serilog с JSON-форматом, централизованный сбор через Loki
*   **Конфигурация:** appsettings.json + Akka HOCON

## 3. Архитектура проекта

Сервис построен по принципам **Domain-Driven Design (DDD)** с четким разделением слоев:

### 3.1. Структура пакетов

```
src/AuctionService/
├── Program.cs                          (namespace AuctionService)
├── Domain/                             (namespace AuctionService.Domain)
│   ├── Session/                        ← агрегат "Сессия аукциона"
│   │   ├── AuctionSessionActor.cs      (ReceivePersistentActor)
│   │   ├── Commands.cs                 (abstract record Command)
│   │   ├── Events.cs                   (abstract record Event)
│   │   └── State.cs                    (sealed record State)
│   ├── Lot/                            ← агрегат "Лот"
│   │   ├── LotActor.cs                 (ReceivePersistentActor)
│   │   ├── Commands.cs
│   │   ├── Events.cs
│   │   └── State.cs
│   └── AuctionRegistry.cs              ← корневой актор (роутер к сессиям)
├── Application/                        (namespace AuctionService.Application)
│   ├── GrpcService.cs                  ← gRPC API для синхронных запросов
│   └── NatsCommandHandler.cs           ← обработчик команд из NATS
├── Infrastructure/                     (namespace AuctionService.Infrastructure)
│   ├── NatsClient.cs                   ← NATS publisher/subscriber
│   ├── Serialization.cs                ← Protobuf serializers для Akka
│   └── Persistence/
│       └── PersistenceSetup.cs         ← настройка Event Store
├── Protos/                             ← Protobuf контракты (symlink)
│   └── auction_service.proto
└── appsettings.json                    ← конфигурация приложения
```

**Принципы организации:**

*   **Domain/** — чистая бизнес-логика, не зависит от транспорта
*   **Application/** — координация use cases, принимает запросы извне
*   **Infrastructure/** — технические детали (NATS, PostgreSQL, сериализация)

**Namespaces короткие:** используем `AuctionService.Domain.Session` вместо `Solguficky.AuctionService.Domain.Session` — это внутренний микросервис, не публичная библиотека.

## 4. Доменная модель (Акторы)

*   **`AuctionSession` (Агрегат: Аукцион):** Родительский персистентный актор-**координатор**.
    *   **Ответственность:** Управляет глобальными настройками и фазами аукциона для одной сходки. Является источником правды о последовательности событий. Обрабатывает глобальные админ-команды.
    *   **Действия:** Создает и **супервизит** дочерние акторы `Lot` для каждого лота. В финальной фазе активирует их по очереди, гарантируя, что одновременно торгуется только один лот.
    *   **Персистентность:** Сохраняет события верхнего уровня: `AuctionStarted`, `GlobalSettingsUpdated`, `Phase1Ended`, `LotActivated`, `AuctionFinished`.
    *   **Реализация:** `EventSourcedBehavior[Command, Event, State]`
*   **`Lot` (Агрегат: Лот):** Дочерний персистентный актор-**исполнитель**.
    *   **Ответственность:** Реализует всю сложную логику торгов для **одного конкретного лота**. Реализован как машина состояний (FSM).
    *   **Действия:** Обрабатывает ставки (`PlaceBid`), управляет внутренними таймерами (анти-снайп), реализует логику режимов (`Slotted`, `Dutch`, `Vickrey`) и автоставок (`Proxy-bids`). Защищает свои инварианты (например, "Freeze-окно").
    *   **Персистентность:** Сохраняет события, относящиеся только к нему: `BidPlaced`, `ProxyBidUpdated`, `TimerExtended`, `LotSold`.
    *   **Реализация:** `EventSourcedBehavior[Command, Event, State]`

## 4. Детальная механика и функциональность

### 4.1. Режимы Финала (Final Modes)

Логика режимов инкапсулирована внутри `LotActor`. Родительский `AuctionSessionActor` решает, какую реализацию/поведение создать для каждого лота.

*   **`Slotted Online` (Классический онлайн-аукцион):** Лоты торгуются по очереди в выделенные временные слоты. Поддерживает механику **анти-снайпа**.
*   **`Best & Final` (Аукцион Викри / "втемную"):** Участники делают скрытые максимальные ставки. Побеждает максимальная ставка, но оплачивается **вторая по величине ставка + шаг**. В этом режиме `Proxy-bids` принудительно отключаются.
*   **`Dutch Final` (Голландский аукцион):** Аукцион "на понижение". Цена на лот постепенно снижается, пока первый участник не "заберет" его по текущей цене.
*   **`Hybrid Live` (Гибридный режим):** Предназначен для офлайн-мероприятий. Ведущий-человек управляет ходом торгов, а ставки из зала вводятся через **админ-панель**. Онлайн-участники делают ставки через бот. `LotActor` агрегирует ставки из обоих источников.

### 4.2. Основные механики торгов

*   **`Proxy-bids` (Автоставки в стиле eBay):** Пользователь задает свой секретный максимум. Система автоматически торгуется за него с минимально возможным шагом, пока максимум не будет превышен. Эта логика полностью инкапсулирована в `LotActor`.
*   **`Анти-снайп` (Anti-Snipe):** Ставка в последние секунды продлевает таймер лота на N минут (но не более K раз). Параметры N и K настраиваются. `LotActor` управляет своим внутренним таймером и счетчиком продлений.

### 4.3. Гибкая конфигурация

*   **`Overrides per-lot`:** Глобальные настройки аукциона (`final_mode`, `proxy_bids`, `anti_snipe`) могут быть индивидуально переопределены для каждого лота.
*   **`Freeze-окно`:** Как только лот становится активным в финале (`final_active`), его настройки блокируются от изменений для обеспечения честности торгов. Это реализуется машиной состояний в `LotActor`.

### 4.4. Взаимодействие и внешние связи

*   **Админ-инструменты:** Глобальные команды (`/final ...`) обрабатываются `AuctionSessionActor`. Команды для конкретного лота (`/lot <id> ...`) роутятся через `AuctionSessionActor` к нужному дочернему `LotActor`.
*   **Геймификация и "Приколы":** `Auction Service` **не содержит** логики ачивок, досок почета или розыгрышей. Он лишь публикует "факты" (события `BidPlaced`, `LotSold`). Вся геймификация реализуется **внешними сервисами-слушателями** (например, `Achievements Service`), которые реагируют на эти события. Это обеспечивает идеальное разделение ответственности.

## 5. Внешние контракты (API)

*   **Асинхронный (NATS):**
    *   **Принимает команды** на запуск, изменение и завершение аукционов и лотов.
    *   **Публикует события** о ключевых моментах: старт, новая ставка, продажа лота, завершение.
    *   Все сообщения сериализуются в **Protobuf**. Схемы хранятся в `contracts/proto/`.
*   **Синхронный (gRPC):**
    *   Предоставляет API для **получения текущего статуса** аукциона (активный лот, цена, лидер).
    *   Контракты определены в `.proto` файлах.

## 6. Зависимости

*   Зависит от **Meetups Service** для получения и верификации информации о сходке, к которой привязан аукцион.

## 7. Обрабатываемые команды (Примеры)

*   `commands.auction.start { eventId, settings }`
*   `commands.auction.place_bid { eventId, lotId, userId, amount }`
*   `commands.auction.admin.update_settings { eventId, settings }`
*   `commands.auction.admin.close_lot { eventId, lotId }`

## 8. Публикуемые события (Примеры)

*   `events.auction.started { eventId, lots }`
*   `events.auction.bid_placed { eventId, lotId, userId, currentPrice, leaderId }`
*   `events.auction.lot_sold { eventId, lotId, winnerId, finalPrice }`
*   `events.auction.finished { eventId }`

## 9. Синхронное API (gRPC)

*   `GetAuctionStatus(eventId) returns { status, activeLot, currentPrice, leader }`

## 10. Конфигурация

*   `NATS_URL`: Адрес сервера NATS.
*   `POSTGRES_URL`: Строка подключения к PostgreSQL (Event Store).
*   `GRPC_PORT`: Порт для gRPC-сервера.

## 11. Примеры кода

### 11.1. Протокол актора (Commands и Events)

```csharp
namespace AuctionService.Domain.Lot;

public abstract record Command;
public sealed record PlaceBid(long UserId, double Amount, IActorRef ReplyTo) : Command;
public sealed record GetStatus(IActorRef ReplyTo) : Command;

public abstract record Event;
public sealed record BidPlaced(long UserId, double Amount, long Timestamp) : Event;
public sealed record BidRejected(long UserId, double Amount, string Reason) : Event;
public sealed record LotSold(long WinnerId, double FinalPrice) : Event;

public abstract record Response;
public sealed record BidAccepted(double NewPrice) : Response;
public sealed record BidRejected(string Reason) : Response;
public sealed record StatusResponse(double CurrentPrice, long? LeaderId) : Response;
```

### 11.2. State и ReceivePersistentActor

```csharp
namespace AuctionService.Domain.Lot;

public sealed record State(
    int LotId,
    double StartingPrice,
    double MinBidStep,
    double? CurrentPrice,
    long? CurrentLeaderId,
    ImmutableList<BidPlaced> Bids
);

public class LotActor : ReceivePersistentActor
{
    public override string PersistenceId { get; }
    private State _state;

    public LotActor(int lotId, double startingPrice, double minBidStep)
    {
        PersistenceId = $"lot-{lotId}";
        _state = new State(lotId, startingPrice, minBidStep, null, null, ImmutableList<BidPlaced>.Empty);

        Command<PlaceBid>(HandlePlaceBid);
        Command<GetStatus>(HandleGetStatus);

        Recover<BidPlaced>(ApplyBidPlaced);
        Recover<LotSold>(ApplyLotSold);
        Recover<SnapshotOffer>(offer => _state = (State)offer.Snapshot);
    }

    private void HandlePlaceBid(PlaceBid cmd)
    {
        var minRequired = (_state.CurrentPrice ?? _state.StartingPrice) + _state.MinBidStep;
        if (cmd.Amount < minRequired)
        {
            cmd.ReplyTo.Tell(new BidRejected($"Minimum bid: {minRequired}"));
            return;
        }

        var evt = new BidPlaced(cmd.UserId, cmd.Amount, DateTimeOffset.UtcNow.ToUnixTimeSeconds());
        Persist(evt, e =>
        {
            ApplyBidPlaced(e);
            cmd.ReplyTo.Tell(new BidAccepted(cmd.Amount));
        });
    }

    private void HandleGetStatus(GetStatus cmd)
    {
        cmd.ReplyTo.Tell(new StatusResponse(
            _state.CurrentPrice ?? _state.StartingPrice,
            _state.CurrentLeaderId
        ));
    }

    private void ApplyBidPlaced(BidPlaced evt)
    {
        _state = _state with
        {
            CurrentPrice = evt.Amount,
            CurrentLeaderId = evt.UserId,
            Bids = _state.Bids.Add(evt)
        };
    }

    private void ApplyLotSold(LotSold evt)
    {
    }
}
```

### 11.3. gRPC Service с ask pattern

```csharp
namespace AuctionService.Application;

public class AuctionGrpcService : AuctionService.AuctionServiceBase
{
    private readonly IActorRef _registry;
    private readonly TimeSpan _timeout = TimeSpan.FromSeconds(5);

    public AuctionGrpcService(IActorRef registry)
    {
        _registry = registry;
    }

    public override async Task<AuctionStatusResponse> GetAuctionStatus(
        GetAuctionStatusRequest request,
        ServerCallContext context)
    {
        var session = await _registry.Ask<IActorRef>(
            new GetSession(request.EventId),
            _timeout
        );

        if (session == null)
        {
            throw new RpcException(new Status(StatusCode.NotFound, "Auction not found"));
        }

        var status = await session.Ask<StatusResponse>(
            new GetStatus(ActorRefs.NoSender),
            _timeout
        );

        return new AuctionStatusResponse
        {
            Status = "Running",
            CurrentPrice = status.CurrentPrice,
            LeaderId = status.LeaderId ?? 0
        };
    }
}
```

### 11.4. NATS Subscriber

```csharp
namespace AuctionService.Infrastructure;

public class NatsSubscriber
{
    private readonly IConnection _connection;
    private readonly IActorRef _registry;

    public NatsSubscriber(string natsUrl, IActorRef registry)
    {
        var factory = new ConnectionFactory();
        _connection = factory.CreateConnection(natsUrl);
        _registry = registry;
    }

    public void SubscribeToCommands()
    {
        _connection.SubscribeAsync("commands.auction.place_bid", (sender, args) =>
        {
            var command = PlaceBidCommand.Parser.ParseFrom(args.Message.Data);
            _registry.Tell(new RouteCommand(
                command.EventId,
                command.LotId,
                command.UserId,
                command.Amount
            ));
        });

        _connection.SubscribeAsync("commands.auction.start", (sender, args) =>
        {
            var command = StartAuctionCommand.Parser.ParseFrom(args.Message.Data);
            _registry.Tell(new StartSession(command.EventId, command.Settings));
        });
    }
}
```

### 11.5. NATS Publisher

```csharp
namespace AuctionService.Infrastructure;

public class NatsPublisher
{
    private readonly IConnection _connection;

    public NatsPublisher(string natsUrl)
    {
        var factory = new ConnectionFactory();
        _connection = factory.CreateConnection(natsUrl);
    }

    public void Publish<T>(string subject, T message) where T : IMessage<T>
    {
        var bytes = message.ToByteArray();
        _connection.Publish(subject, bytes);
    }

    public void PublishBidPlaced(string eventId, int lotId, long userId, double amount)
    {
        var @event = new BidPlacedEvent
        {
            EventId = eventId,
            LotId = lotId,
            UserId = userId,
            Amount = amount,
            CurrentLeaderId = userId
        };
        Publish("events.auction.bid_placed", @event);
    }
}
```

## 12. Интеграция с другими компонентами

### 12.1. gRPC контракты

Определены в `contracts/proto/grpc/auction_service.proto`:

```protobuf
service AuctionService {
  rpc GetAuctionStatus(GetAuctionStatusRequest) returns (AuctionStatusResponse);
  rpc GetLotDetails(GetLotDetailsRequest) returns (LotDetailsResponse);
}
```

Кодогенерация происходит автоматически через `akka-grpc` plugin при сборке проекта.

### 12.2. NATS контракты

Используют Protobuf схемы из `contracts/proto/nats/`:
- **Команды:** `commands/auction_commands.proto`
- **События:** `events/auction_events.proto`

Пример команды: `PlaceBidCommand` из `auction_commands.proto` десериализуется через ScalaPB.

### 12.3. Маршрутизация команд к акторам

```
NATS → NatsSubscriber → AuctionRegistry → AuctionSession → Lot
                            ↓
                      (роутинг по eventId)
```

`AuctionRegistry` — корневой актор, который:
1. Создает `AuctionSession` для каждого `eventId`
2. Маршрутизирует команды к нужной сессии
3. Управляет жизненным циклом сессий