# Справочник: Темы (Subjects) в NATS

Единый источник правды для именования тем и форматов сообщений в NATS.

## Формат сериализации

Все сообщения в NATS сериализуются в **Protobuf**. Схемы — в `contracts/proto/`, подход **Protobuf-in-Git** (ADR-014): кодогенерация на этапе сборки каждого сервиса, внешний Schema Registry не используется. JSON в шине запрещён (ADR-012).

## Принципы именования

Иерархическая структура: `<тип>.<домен>.<действие>` в snake_case.

*   **Тип:** `commands` (намерения), `events` (свершившиеся факты).
*   **Домен:** `auction`, `telegram`, в будущем `meetup`, `notifications`.

## Актуальные темы

### Команды

| Тема | Proto | Отправитель | Получатель |
|---|---|---|---|
| `commands.auction.start` | `StartAuctionCommand` | Telegram Gateway / админ-инструменты | Auction Service |
| `commands.auction.place_bid` | `PlaceBidCommand` | Telegram Gateway | Auction Service |
| `commands.auction.set_proxy_bid` | `SetProxyBidCommand` | Telegram Gateway | Auction Service |
| `commands.auction.end_open_bidding` | `EndOpenBiddingCommand` | админ-инструменты | Auction Service |
| `commands.auction.start_final_phase` | `StartFinalPhaseCommand` | админ-инструменты | Auction Service |
| `commands.telegram.send_message` | `SendMessageCommand` | Notifications Service | Telegram Gateway |

### События

| Тема | Proto | Отправитель | Получатели |
|---|---|---|---|
| `events.auction.started` | `AuctionStartedEvent` | Auction Service | WebSocket Gateway, Notifications |
| `events.auction.bid_placed` | `BidPlacedEvent` | Auction Service | Notifications, WebSocket Gateway, Telegram Gateway |
| `events.auction.phase_transitioned` | `PhaseTransitionedEvent` | Auction Service | WebSocket Gateway, Notifications |

### Планируемые (не реализованы)

*   `commands.meetup.create` / `events.meetup.created` — после появления Meetups Service (roadmap P1).
*   `events.auction.lot_sold`, `events.auction.finished` — при доработке аукциона (P3).

## Правила изменения

При изменении контракта следуй скиллу `.claude/skills/contract-change/` — обнови все сервисы-потребители, `nats-tester` и этот документ в одном изменении.

## Известные расхождения (техдолг, roadmap P0)

*   `telegram-gateway/src/app/event_listener.rs` парсит `BidPlacedEvent` и `SendMessageCommand` как JSON — должен использовать Protobuf из `generated/`.
*   `websocket-gateway` подписан на `events.*` (одноуровневый wildcard) и не получает `events.auction.*` — нужен `events.>`.
*   Поле `op_id` в командах зарезервировано под идемпотентность, но консьюмерами пока не проверяется.
