# Solguficky Hub

> Этот файл — единый контекст для всех AI-агентов (Claude Code, Codex, Cursor читают `AGENTS.md`; `CLAUDE.md` — просто импорт этого файла, не редактируй его). Вложенные `AGENTS.md` лежат в папках сервисов. Чеклисты в `.claude/skills/*/SKILL.md` — обычный markdown: Claude Code подхватывает их как скиллы, из других агентов открывай и следуй вручную.

Полиглотная микросервисная платформа для организации сходок (локальных мероприятий) Telegram-сообщества. Пет-проект: одновременно продукт для комьюнити и площадка для обучения (Event Sourcing, акторы, распределённые системы).

## Карта репозитория

- `contracts/proto/` — Protobuf-контракты (единственный источник правды): `nats/commands`, `nats/events`, `grpc`. Кодогенерация — на этапе сборки каждого сервиса.
- `services/telegram-gateway/` — Rust + Teloxide. Входная точка для пользователей, UI бота, FSM-диалоги.
- `services/auction-service/` — C# + Akka.NET. Event Sourcing/CQRS, акторы AuctionActor→LotActor, персистентность в PostgreSQL.
- `services/notifications-service/` — C#. Слушает события, генерирует команды на отправку сообщений.
- `services/websocket-gateway/` — C# + SignalR. Проброс событий NATS в WebSocket-клиенты.
- `tools/nats-tester/` — Python CLI для ручного тестирования NATS-сообщений.
- `docs/` — vision, архитектура, ADR (`docs/04_DECISIONS/decisions.md`), roadmap (`docs/ROADMAP.md`).
- `frontend/admin-app/` — заглушка под Telegram Mini App (не начато).

## Команды

```bash
# Инфраструктура (NATS + PostgreSQL)
docker-compose up -d postgres nats

# auction-service / notifications-service / websocket-gateway (из папки сервиса)
dotnet build && dotnet test

# telegram-gateway (из services/telegram-gateway)
cargo build && cargo test
cargo clippy -- -D warnings && cargo fmt --check

# nats-tester (из tools/nats-tester)
python generate_proto.py && pip install -e . && nats-tester --help
```

## Архитектурные правила (кратко, детали в ADR)

- **Асинхронно через NATS** — команды к stateful-агрегатам (`commands.auction.place_bid`) и события (`events.auction.bid_placed`). **Синхронно через gRPC** — CRUD и queries. Критерии выбора — ADR-016.
- **Сериализация в NATS и gRPC — только Protobuf** (ADR-012). JSON в шине запрещён. При изменении `.proto` обнови ВСЕХ потребителей и `docs/03_CONTRACTS/nats_subjects.md` (есть скилл `contract-change`).
- Именование NATS-тем: `<commands|events>.<домен>.<действие>`, snake_case.
- ID аукционов/сходок — ULID строкой в контрактах (ADR-019).
- Stateful-логика (аукцион) — акторы + Event Sourcing (ADR-002, ADR-009); CRUD-сервисы — обычный ASP.NET Core + EF Core, без ES.

## Процесс разработки

- Итеративно: маленькие шаги, обсуждение архитектурного решения до кода (ADR-013).
- Нетривиальные технические решения фиксируются как ADR в `docs/04_DECISIONS/decisions.md` (есть скилл `adr`).
- Документация обновляется в том же изменении, что и код. Если код противоречит докам — почини доки или скажи об этом явно.
- Приоритеты работ — `docs/ROADMAP.md`. Аукционный модуль сейчас отложен (P3), ядро — сходки.

## Конвенции по языкам

- **C#**: records для Commands/Events/State; nullable reference types; switch expressions; Serilog со структурными логами. В Akka: `Command<T>`/`Recover<T>`-роутинг, `Persist → Apply → Reply`, PersistenceId = `<тип>-<id>`.
- **Rust**: без `unwrap()`/`expect()` на внешних данных; `thiserror` в `domain`/`infra`, `anyhow` в `app`; хендлеры возвращают `BotAction` (не дёргают Bot API напрямую), FSM и UI-билдеры — чистые функции (ADR-016).
- В боте: предпочитай `editMessageText` новым сообщениям; сразу отвечай на callback_query; бот в общем чате «тихий».
