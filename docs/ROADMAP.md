# Roadmap

> Обновлено: 2026-07-17. Этот документ — актуальный план работ, заменяет разрозненные планы из старых доков.
> Принцип: **ядро продукта — сходки (meetups), аукцион — один из модулей** и сейчас отложен.

## Где мы сейчас

| Компонент | Стек | Состояние |
|---|---|---|
| telegram-gateway | Rust + Teloxide | MVP UI аукциона (просмотр лотов, ставки, FSM создания лота, роли из конфига). Данные — из `MockAuctionService`, реальный gRPC-клиент не подключён |
| auction-service | C# + Akka.NET (ES/CQRS) | Каркас работает: акторы Auction/Lot, персистентность в PostgreSQL, gRPC queries, NATS-команды. Рефакторинг фаз (OpenBidding→Idle→Final) в работе. Таймеры/анти-снайп удалены при рефакторинге — вернуть на этапе «Аукцион v2» |
| notifications-service | C# | Каркас event→command (BidPlaced → SendMessage), диспетчер с handler'ами |
| websocket-gateway | C# + SignalR | Broadcast событий NATS в один канал `auction:live` |
| frontend/admin-app | — | Пустая директория, не начато |
| meetups / identity / achievements / content-feed | — | Не начаты |
| Инфра | NATS, PostgreSQL, docker-compose, Loki/Grafana (конфиги) | JetStream включён на сервере, но сервисы используют core NATS (at-most-once). CI нет |

## P0 — Гигиена (перед любыми фичами)

- [ ] Закоммитить WIP-рефакторинг auction-service (собирается, тесты зелёные).
- [ ] **Починить контрактные разрывы** (см. ревью 2026-07-17):
  - `SendMessageCommand`: notifications публикует Protobuf, gateway парсит JSON (+ поле `chat_id` vs `user_id`) — привести к Protobuf-контракту;
  - `events.auction.bid_placed`: `event_listener.rs` в gateway парсит JSON вместо Protobuf;
  - websocket-gateway подписан на `events.*` (одноуровневый wildcard) — события `events.auction.*` под него не попадают, нужен `events.>` или `events.auction.>`;
  - убрать дублирование отправки outbid-уведомлений (gateway шлёт сам И notifications-service шлёт через `commands.telegram.send_message`) — оставить один путь через notifications-service.
- [x] CI (GitHub Actions): build + test всех сервисов, clippy/fmt для Rust — `.github/workflows/ci.yml` (2026-07-18), path-фильтры по сервисам; проверить первый прогон после пуша на GitHub.
- [ ] Единая локальная оркестрация: **Aspire вместо трёх compose-файлов** — ТЗ [06_TASKS/aspire-orchestration.md](06_TASKS/aspire-orchestration.md) (заменяет прежний пункт «единый docker-compose.yml»).
- [ ] Исправить DI-баг: scoped `LotRepository` инжектится в singleton `NatsCommandHandler`.

## P1 — Ядро продукта: сходки

Цель: бот полезен сообществу без аукциона.

- [ ] **Meetups Service (C#)**: CRUD сходок (название, дата, место, статус, организаторы), gRPC для queries, события `events.meetup.*`. Обычный ASP.NET Core + EF Core, без ES.
- [ ] **Роли/Identity**: минимум — вынести роли из `configuration.yaml` в Identity Service (или таблицу в Meetups на первое время); роли: участник, организатор сходки, админ, owner.
- [ ] **Бот (gateway)**: главное меню вокруг сходок — «Ближайшая сходка», «Календарь», карточка сходки с RSVP «Пойду»; FSM «предложить сходку» с модерацией админом.
- [ ] **Напоминания по RSVP**: за 24 ч и за 2 ч записавшимся (через notifications-service — первый его реальный сценарий вместо аукционного).
- [ ] Подключить gateway к реальным сервисам по gRPC (убрать `MockAuctionService` как паттерн: трейт `AuctionService`/`MeetupsService` + gRPC-реализация, mock — только в тестах).
- [ ] Закреплённое сообщение в чате: авто-обновляемое саммари ближайшей сходки (тихий режим — редактирование, не спам).

## P2 — Вовлечение

- [ ] Content Feed: лента сходки (посты, ссылки, опросы, постеры, отзывы), прикрепление пересланных сообщений с валидацией админа.
- [ ] Notifications: подписки, тихие часы, анти-дублирование; недельный дайджест (полуавто).
- [ ] Achievements: шаблоны ачивок на сходку, выдача, профиль участника; кудос-карма.
- [ ] Пост-ивент: сбор фото/отчёта. (QR-чек-ин, сплит расходов — беклог, по реальной боли.)

## P3 — Аукцион v2 (после ядра)

Продуктовая спека: [auction-module-spec.md](02_SERVICES/auction-module-spec.md) — формат утверждён (неделя онлайн-предаукциона с proxy-bids + классический офлайн-финал с консолью аукциониста, без soft-close).

- [ ] Довести FSM фаз (текущий WIP), вернуть таймеры и анти-снайп как поведение актора (`IWithTimers`, событие `LotTimerExtended`).
- [ ] Модель событий финала: `AskAdvanced`, `BidPlaced(floor|proxy)`, `LeaderChanged`, `ProxyLimitUpdated`, `LotSold`.
- [ ] Консоль аукциониста (Mini App: ↑ask, скан бейджа, «продано») + экран зала (Big Screen через websocket-gateway).
- [ ] Подписки на лоты, уведомления по позиции в очереди, автодоливка proxy-лимита.
- [ ] Оплата «вариант Б»: счёт-инструкция, статусы, авто-напоминания.
- [ ] Идемпотентность команд по `op_id` (сейчас поле есть, но не проверяется).
- [ ] Доп. режимы (slotted / best&final / dutch / raffle) — по спеке, итерациями.

## Mini App и фронтенд (frontend/admin-app)

Дизайн-первый подход: **макеты до кода, делаем через Claude** (design-сессии; макеты сохраняются в `docs/05_DESIGN/` как HTML/скриншоты и утверждаются до вёрстки).

- [ ] Дизайн ключевых экранов: «Сводка сходки», календарь + карточка сходки (RSVP), лента лотов + карточка лота, консоль аукциониста, Big Screen финала.
- [ ] ADR: стек фронтенда (TypeScript + фреймворк) и структура Mini App.
- [ ] Реализация — по мере готовности соответствующих фаз (сводка сходки — P1, консоль аукциониста — P3).

## Cross-cutting (техдолг и обучение)

- [ ] **JetStream**: durable consumers для команд и событий (сейчас at-most-once, сообщения теряются при рестарте подписчика). Хорошее упражнение по надёжности (Release It!, DDIA).
- [ ] Идемпотентность на консьюмерах (op_id + dedup), retry с backoff в NATS-клиентах.
- [ ] Read model для аукциона/сходок (CQRS query-сторона) вместо ask-запросов к акторам.
- [ ] Observability: развернуть Loki/Grafana локально (конфиги уже есть), добавить метрики (Prometheus) и трейсы позже.
- [ ] Money как decimal/минорные единицы вместо `double` в контрактах и коде.
- [ ] **UUIDv7 вместо ULID** — ТЗ [06_TASKS/uuidv7-migration.md](06_TASKS/uuidv7-migration.md) (заменит ADR-019; попутно апгрейд C#-сервисов net8 → net10).
- [ ] **Хостинг/деплой** (решение открыто, нужен ADR): раньше сервис жил на Railway; кандидаты — дешёвый VPS (Hetzner/аналог) или домашний сервер (бот на long polling работает за NAT без белого IP; для webhook/Mini App — Cloudflare Tunnel). Домашний сервер даёт больше обучения (Linux, systemd, мониторинг), VPS — надёжность. План в два этапа: сначала деплой docker compose из GitHub Actions, затем **k3s (single-node) как учебный этап** — манифесты генерируются из Aspire-топологии (`aspire publish`, k8s-publisher), см. ТЗ по Aspire.

## Языки: учебный трек (обновлено 2026-07-17)

Пул интереса владельца: **Kotlin, Go, Ruby, Elixir** (Scala исключена). Правило: один новый язык за раз, под сервис с понятными границами; выбор фиксируется ADR.

| Язык | Кандидат-сервис | Когда |
|---|---|---|
| Go | Scheduler-сервис (таймеры финала, напоминания RSVP, дайджест) или Achievements | P2 — маленький stateless сервис, идеален для первого Go |
| Kotlin | Content Feed (Ktor + Exposed) | P2 |
| Ruby | Внутренняя админ-панель (Rails: CRUD сходок/лотов/ачивок для админов) | P2–P3 — Rails быстрее всего даёт admin UI |
| Elixir | Миграция notifications/websocket-gateway | по критериям нагрузки из ADR-018, не раньше |

Ядро (Meetups, Identity) — на C#: тут важна скорость получения работающего продукта, а не обучение.

## Что осознанно НЕ делаем сейчас

- Schema Registry (ADR-014: Protobuf-in-Git достаточно).
- Вынос бота за пределы Telegram; полноценные платежи/эскроу (оплата аукциона — «вариант Б», см. спеку).
- Scala — исключена из планов (решение 2026-07-17).
