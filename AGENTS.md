# Solguficky Hub

> Этот файл — единый контекст для всех AI-агентов (Claude Code, Codex, Cursor читают `AGENTS.md`; `CLAUDE.md` — просто импорт этого файла, не редактируй его). Вложенные `AGENTS.md` лежат в папках сервисов. Чеклисты в `.claude/skills/*/SKILL.md` — обычный markdown: Claude Code подхватывает их как скиллы, из других агентов открывай и следуй вручную.

Полиглотная микросервисная платформа для организации сходок (локальных мероприятий) Telegram-сообщества. Пет-проект: одновременно продукт для комьюнити и площадка для обучения (Event Sourcing, акторы, распределённые системы).

## Карта репозитория

- `contracts/proto/` — Protobuf-контракты (единственный источник правды): `nats/commands`, `nats/events`, `grpc`. Кодогенерация — на этапе сборки каждого сервиса.
- `services/telegram-gateway/` — **Current/Legacy:** Rust + Teloxide, преимущественно UI старого аукциона. **MVP:** новая реализация на TypeScript + grammY после ADR.
- `services/auction-service/` — **Legacy:** C# + Akka.NET, Event Sourcing/CQRS. Не входит в MVP и не развивается без явного запроса.
- `services/notifications-service/` — **Current:** C#-каркас с аукционным handler. **MVP:** кандидат для напоминаний, дизайн ещё не принят.
- `services/websocket-gateway/` — **Legacy/Frozen:** C# + SignalR, обслуживает только аукцион. Пока остаётся в сборке.
- `meetups` и `identity` — **MVP:** ещё не реализованы; Identity остаётся отдельным сервисом, языки backend пока не выбраны.
- `tools/nats-tester/` — Python CLI для ручного тестирования NATS-сообщений.
- `docs/PROJECT_CONTEXT.md` — основной контекст Current / MVP / Future / Legacy на время синхронизации документации.
- `docs/` — vision, архитектура, ADR (`docs/04_DECISIONS/decisions.md`), контракты и сервисные документы.
- `frontend/admin-app/` — заглушка под Telegram Mini App (не начато).

## Команды

```bash
# Локальная оркестрация — единая точка входа (infra/apphost/, ADR-021)
cd infra/apphost && aspire run                      # профиль по умолчанию — core
TOPOLOGY__PROFILE=infra aspire run                   # только NATS + PostgreSQL
TOPOLOGY__PROFILE=full aspire run                     # весь стек
TOPOLOGY__AUCTIONSERVICE=Container aspire run         # переопределить режим одного компонента

# auction-service / notifications-service / websocket-gateway (из папки сервиса)
dotnet build && dotnet test

# telegram-gateway (из services/telegram-gateway)
cargo build && cargo test
cargo clippy -- -D warnings && cargo fmt --check

# nats-tester (из tools/nats-tester)
python generate_proto.py && pip install -e . && nats-tester --help
```

**Профили топологии** (`infra/apphost/`, детали — [ТЗ по Aspire](docs/06_TASKS/aspire-orchestration.md), [ADR-021](docs/04_DECISIONS/decisions.md)):

| Профиль | Состав | Замена чего |
|---|---|---|
| `infra` | только NATS + PostgreSQL (контейнеры) | `docker-compose up -d postgres nats`, остальное запускаешь сам из IDE |
| `core` (по умолчанию) | infra + auction-service + telegram-gateway (Local) | повседневная разработка |
| `full` | все сервисы | end-to-end проверка перед PR |

Режим отдельного компонента — `Local` (из исходников) / `Container` (образ) / `Off` (не поднимать) — переопределяется без правки кода AppHost: `TOPOLOGY__<SERVICE>=Container|Local|Off` (например, `TOPOLOGY__NOTIFICATIONSSERVICE=Local`) или в `infra/apphost/appsettings.json`.

> Рукописные `docker-compose.yml` (корневой и пер-сервисные) пока не удалены — миграция на Aspire в процессе (итерации 0–2 из ТЗ выполнены, `aspire run` не проверен вживую из-за сетевых ограничений сессии, где писался код; итерации 3–4 — режимы/профили и генерация compose — тоже не подтверждены запуском). Не полагайся на эту таблицу как на единственный источник правды, пока кто-то не прогонит `aspire run` и не уберёт это предупреждение.

## Архитектурные правила (кратко, детали в ADR)

- **Асинхронно через NATS** — команды к stateful-агрегатам (`commands.auction.place_bid`) и события (`events.auction.bid_placed`). **Синхронно через gRPC** — CRUD и queries. Критерии выбора — ADR-016.
- **Сериализация в NATS и gRPC — только Protobuf** (ADR-012). JSON в шине запрещён. При изменении `.proto` обнови ВСЕХ потребителей и `docs/03_CONTRACTS/nats_subjects.md` (есть скилл `contract-change`).
- Именование NATS-тем: `<commands|events>.<домен>.<действие>`, snake_case.
- ID аукционов/сходок — UUIDv7 канонической строкой (36 символов, lowercase, с дефисами) в контрактах (ADR-020).
- Stateful-логика (аукцион) — акторы + Event Sourcing (ADR-002, ADR-009); CRUD-сервисы — обычный ASP.NET Core + EF Core, без ES.

## Процесс разработки

- Итеративно: маленькие шаги, обсуждение архитектурного решения до кода (ADR-013).
- Нетривиальные технические решения фиксируются как ADR в `docs/04_DECISIONS/decisions.md` (есть скилл `adr`).
- Документация обновляется в том же изменении, что и код. Если код противоречит докам — почини доки или скажи об этом явно.
- Milestones, приоритеты, задачи и прогресс ведутся в Linear. Репозиторий хранит устойчивый контекст, требования и решения; отдельного Git-roadmap нет.
- Аукционный модуль не входит в MVP. Перед удалением legacy-кода нужно извлечь доменную модель, actor/event-логику, полезные тест-кейсы и непроверенные гипотезы.
- Продуктовые и архитектурные решения принимает владелец. Агент исследует, оппонирует и реализует утверждённый срез; не создаёт новый сервис, ADR или межсервисный контракт без явного запроса.

## Конвенции по языкам

- **C#**: records для Commands/Events/State; nullable reference types; switch expressions; Serilog со структурными логами. В Akka: `Command<T>`/`Recover<T>`-роутинг, `Persist → Apply → Reply`, PersistenceId = `<тип>-<id>`.
- **Rust (только текущий legacy gateway)**: без `unwrap()`/`expect()` на внешних данных; `thiserror` в `domain`/`infra`, `anyhow` в `app`; хендлеры возвращают `BotAction` (не дёргают Bot API напрямую), FSM и UI-билдеры — чистые функции (ADR-016).
- В боте: соблюдай тишину, ненавязчивость, privacy by design и минимальные Telegram-права. Конкретный способ взаимодействия (`editMessageText`, silent messages, команды, личка, закреп) определяется требованиями сценария, а не глобальной конвенцией.
