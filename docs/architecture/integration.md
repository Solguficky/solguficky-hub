# Межсервисное взаимодействие

> **Статус:** Canonical для Current/Legacy-интеграций и принятых MVP-контрактов.

Wire-схемы находятся в `contracts/proto/`. Этот документ описывает transport boundaries и имена NATS subjects, которые не являются частью `.proto`.

## Базовое разделение

- Асинхронные команды и события передаются через NATS.
- Синхронные queries и CRUD-вызовы могут использовать gRPC.
- Конкретный выбор делается по failure semantics сценария, а не только по признаку read/write; перегруженный ADR-016 переведён в `Legacy scope` и новые решения принимаются отдельными ADR.
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

| Transport / operation | Proto | Caller | Provider | Semantics |
|---|---|---|---|---|
| gRPC `solguficky.identity.v1.IdentityService/ResolveIdentity` | `ResolveIdentityRequest`, `ResolveIdentityResponse` | Telegram Gateway | Identity | По Telegram user id и optional-нику устанавливает identity для `/start` и возвращает канонический UUIDv7 и общие роли. |

Вызов `ResolveIdentity` синхронный; при недоступности Identity операция завершается fail-closed. Контракт не передаёт статус допуска, whitelist, инвайты или service authentication. Wire-схемы gRPC API для Meetups, остальных операций Identity, нового Telegram Gateway и reminders ещё не приняты. Примеры вроде `commands.meetup.create` не являются зарезервированным контрактом до human-led сценариев, требований и явного contract design.

Notifications публикует наружу не команду каналу, а факт «человеку положено такое уведомление»: явный получатель во внутреннем идентификаторе, тип уведомления со структурированными данными — типизированным `oneof`, а не строковым кодом со свободным словарём. Готового текста и `chat_id` в сообщении нет, обратных событий о доставке нет. Legacy-команда `commands.telegram.send_message` формой будущего контракта не является: она несёт `chat_id` и готовый текст, то есть ровно то, от чего [ADR-028](../decisions/ADR-028-notifications-subscriptions-replica-and-delivery-boundary.md) отказался. Словарь кодов типов уведомлений становится межсервисным контрактом и меняется согласованно с потребителями.

Identity публикует события о регистрации и смене статуса допуска: их потребляет Notifications, который ведёт по ним собственную реплику ([ADR-028](../decisions/ADR-028-notifications-subscriptions-replica-and-delivery-boundary.md)). Gateway устанавливает Telegram identity после проверки secret token вебхука, Identity разрешает Telegram user id во внутренний id, статус доступа и глобальные роли, а Meetups принимает доменные authorization-решения. Authentication material через Identity не проходит.

## Выбор sync и async

Правило «команды к stateful aggregates через NATS, CRUD и queries через gRPC» остаётся отправной точкой, но не применяется механически. Для каждой операции нужно определить:

- требуется ли немедленный ответ пользователю;
- кто владеет состоянием;
- допустима ли eventual consistency;
- что происходит при timeout;
- как клиент узнаёт итог асинхронной команды;
- нужна ли durable delivery;
- как обеспечивается idempotency.

ADR-016 объединяет transport, RBAC и Gateway-specific решения и имеет applicability `Legacy scope`: часть про роли заменена [ADR-026](../decisions/ADR-026-identity-mvp-model-and-access.md), остальное описывает аукционный Gateway. Правило выбора transport из него используется как отправная точка, а не как действующее решение для MVP.

## Contract governance

До расширения набора MVP-контрактов нужно закрыть оставшиеся вопросы:

- правила совместимости;
- ownership;
- codegen matrix для TypeScript и выбранного backend stack;
- CI breaking checks;
- правила удаления Legacy auction contracts;
- границу отдельного контрактного изменения, когда оно затрагивает несколько потребителей.

Schema Registry — не одно бинарное решение:

| Задача | Ближайший разумный уровень |
|---|---|
| Source control схем | Git остаётся источником |
| Breaking-change detection | Compatibility check в CI, например Buf |
| Code generation | Единые команды и версии generators |
| Distribution/discovery | Оценивать при независимых lifecycle или repositories |
| Runtime schema resolution | Не вводить без реального сценария |
| Учебная эксплуатация Registry | Отдельная итерация после product slice |

Возврат Schema Registry остаётся Open. Сначала формулируется проблема, которую он должен решить.

## Delivery semantics

- В коде используются обычные NATS subscriptions; наличие JetStream в локальной конфигурации не делает consumers durable автоматически.
- Durable consumers, redelivery, deduplication и idempotency должны проектироваться совместно.
- Наличие `op_id` в части команд само по себе не обеспечивает идемпотентность: consumer должен сохранять или проверять обработанные операции.
- Требования к допустимой потере, повтору и порядку задаются отдельно для каждого сценария.

Перед использованием durable delivery в продуктовом потоке совместно проектируются:

- stream и retention policy;
- durable consumer;
- ack/retry policy;
- idempotency key и проверка `op_id`;
- consumer inbox/dedup storage;
- идемпотентность внешнего Telegram side effect;
- dead-letter либо операционный способ разбирать необрабатываемые сообщения;
- метрики lag, redelivery и failed delivery.

Read model вводится, когда query-нагрузка, UX или изоляция stateful aggregate делает прямые обращения неудобными, а не как обязательный CQRS-ритуал.

## Observability baseline MVP

- структурные логи без персональных данных и Telegram authentication material;
- correlation/operation id через межсервисный путь;
- health и readiness checks;
- метрики ошибок, latency и delivery attempts;
- trace первого вертикального среза Gateway → Identity → Meetups;
- операторский способ увидеть и повторить неуспешное действие без ручной правки БД.

Loki/Grafana и Aspire dashboard являются заделом. Наличие конфигурации не подтверждает работающую наблюдаемость.

## Изменение

При изменении `.proto` следуй [Protobuf standard](../standards/contracts/protobuf.md) и skill `sgh-change-contract`. При изменении subject обновляй producer, consumers, тестовый инструмент и этот каталог в одном изменении.

## Технические источники

- [Buf breaking change detection](https://buf.build/docs/breaking/)
- [Apicurio Registry compatibility modes](https://www.apicur.io/registry/docs/apicurio-registry/3.3.x/getting-started/assembly-registry-compatibility-modes.html)
