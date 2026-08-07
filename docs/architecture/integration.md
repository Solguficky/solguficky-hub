# Межсервисное взаимодействие

> **Статус:** Canonical для Current/Legacy-интеграций. Контракты MVP ещё не спроектированы.

Wire-схемы находятся в `contracts/proto/`. Этот документ описывает transport boundaries и имена NATS subjects, которые не являются частью `.proto`.

## Базовое разделение

- Асинхронные команды и события передаются через NATS.
- Синхронные queries и CRUD-вызовы могут использовать gRPC.
- Конкретный выбор делается по failure semantics сценария, а не только по признаку read/write; перегруженный ADR-016 требует последующего разделения на более узкие решения.
- NATS и gRPC payload сериализуется только в Protobuf.

## Subjects

Формат: `<commands|events>.<домен>.<действие>` в `snake_case`.

`>` — многоуровневый wildcard. Например, `events.auction.>` получает все события аукциона; одноуровневый `*` не заменяет его.

### Current/Legacy-команды

| Subject | Proto | Producer | Consumer |
|---|---|---|---|
| `commands.auction.start` | `StartAuctionCommand` | `nats-tester` / ручной publisher | Auction Service |
| `commands.auction.place_bid` | `PlaceBidCommand` | Rust Telegram Gateway, `nats-tester` | Auction Service |
| `commands.auction.set_proxy_bid` | `SetProxyBidCommand` | `nats-tester` / ручной publisher | Auction Service |
| `commands.auction.end_open_bidding` | `EndOpenBiddingCommand` | `nats-tester` / ручной publisher | Auction Service |
| `commands.auction.start_final_phase` | `StartFinalPhaseCommand` | `nats-tester` / ручной publisher | Auction Service |
| `commands.telegram.send_message` | `SendMessageCommand` | Notifications Service | Rust Telegram Gateway |

### Current/Legacy-события

| Subject | Proto | Producer | Consumers |
|---|---|---|---|
| `events.auction.started` | `AuctionStartedEvent` | Auction Service | Нет специализированного consumer; wildcard listeners получают subject без доменной обработки |
| `events.auction.bid_placed` | `BidPlacedEvent` | Auction Service | Notifications, WebSocket Gateway, Rust Telegram Gateway |
| `events.auction.phase_transitioned` | `PhaseTransitionedEvent` | Auction Service | Нет специализированного consumer; wildcard listeners получают subject без доменной обработки |

Таблица описывает существующую аукционную ветку, а не обязательный контракт будущего auction v2.

## MVP-контракты

Subjects и gRPC API для Meetups, Identity, нового Telegram Gateway и reminders ещё не приняты. Примеры вроде `commands.meetup.create` не являются зарезервированным контрактом до human-led сценариев, требований и явного contract design.

## Delivery semantics

- В коде используются обычные NATS subscriptions; наличие JetStream в локальной конфигурации не делает consumers durable автоматически.
- Durable consumers, redelivery, deduplication и idempotency должны проектироваться совместно.
- Наличие `op_id` в части команд само по себе не обеспечивает идемпотентность: consumer должен сохранять или проверять обработанные операции.
- Требования к допустимой потере, повтору и порядку задаются отдельно для каждого сценария.

## Изменение

При изменении `.proto` следуй [Protobuf standard](../standards/contracts/protobuf.md) и skill `contract-change`. При изменении subject обновляй producer, consumers, тестовый инструмент и этот каталог в одном изменении.
