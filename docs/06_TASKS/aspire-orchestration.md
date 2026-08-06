# ТЗ: локальная оркестрация на Aspire (вместо трёх docker-compose)

> Статус: **утверждено к работе** (решение владельца 2026-07-18). Оценка: 4–5 итераций по 1–2 ч. Заменяет пункт P0 «единый docker-compose.yml».

## Статус выполнения (обновлено 2026-07-18, AI-агентом в sandbox-сессии без сети)

Код по итерациям 0–3 написан, но **не подтверждён запуском** — сессия, в которой он писался, полностью лишена исходящего сетевого доступа (TLS-хендшейк рвётся ко всем внешним хостам: `api.nuget.org`, `github.com`, `google.com` — не только к NuGet, проверено `curl`/`dotnet restore`/с обходом sandbox-обвязки инструмента). `dotnet restore` для `infra/apphost` падает на двух пакетах, которых нет в локальном NuGet-кэше: `Aspire.Hosting.PostgreSQL`, `Aspire.Hosting.Nats`.

Что удалось проверить офлайн (что было в локальном кэше NuGet):
- [x] `infra/servicedefaults/` (ServiceDefaults: OTel + health checks) — **компилируется**.
- [x] `services/auction-service` с подключённым ServiceDefaults — **компилируется**.
- [x] `services/notifications-service`, `services/websocket-gateway` — **компилируются** (без изменений в самом коде).
- [x] Восстановление зависимостей (`dotnet restore`) для `infra/apphost` доходит до этапа "4 из 5 проектов восстановлено" — граф `ProjectReference` на все три C#-сервиса корректен; падает только на двух пакетах выше.
- [ ] **Не проверено вообще**: `infra/apphost/Program.cs` и `Topology.cs` (сам AppHost) — ни разу не скомпилированы, т.к. restore падает раньше. Синтаксис Aspire API (`WithEnvironment(resource)`, `AddDockerfile`, `WithHttpEndpoint`, `AddNats`/`WithJetStream`) не подтверждён.
- [ ] Критерий приёмки итерации 0 (`aspire run` → дашборд, оба контейнера живы) — **не выполнен**.
- [ ] Итерация 2 (Rust): Windows-риск `AddExecutable("cargo", "run", ...)`, явно отмеченный в ADR-021 как «проверить раньше остального» — не проверен.
- [ ] Итерация 4 (генерация compose, удаление рукописных файлов) — сознательно не начата: удалять рабочие compose-файлы до подтверждения замены нельзя.

**Что нужно, чтобы снять статус «не подтверждено»:** прогнать `cd infra/apphost && dotnet restore && aspire run` в среде с доступом к NuGet и сообщить результат (первую ошибку компиляции/восстановления, если будет). Дальнейшая автоматическая работа над этим ТЗ без этого шага рискует наращивать код поверх непроверенного фундамента.

## Мотивация

Сейчас три рукописных compose-файла (корневой + auction-service + websocket-gateway), топология «что поднять для этой задачи» собирается руками. Aspire (с v13 — полиглотный, текущая 13.5) даёт:

- **один AppHost** = вся топология кодом: контейнеры (NATS, PostgreSQL), C#-проекты, Rust через `AddExecutable`/community `AddRustApp`;
- **dashboard** из коробки: логи всех сервисов в одном месте, OTel-трейсы, health;
- service discovery: строки подключения/env инжектятся автоматически, а не копипастятся по compose-файлам;
- `aspire publish`: docker-compose и Kubernetes-манифесты становятся **генерируемыми артефактами** топологии; возможное применение для production-like k3s описано в [контексте проекта](../PROJECT_CONTEXT.md#12-инфраструктура-и-hosting).

## Требование: гибкая топология

Каждый компонент запускается в одном из режимов, без правки AppHost-кода:

- `Local` — из исходников (`dotnet run`-эквивалент через `AddProject`, `cargo run` через executable) с hot-context для разработки;
- `Container` — собранный образ (как в compose сейчас);
- `Off` — не поднимать (я запущу его сам из IDE/терминала — сценарий отладки).

Реализация: параметры Aspire (`appsettings.json` AppHost'а / env `TOPOLOGY__<SERVICE>`), поверх них 3 пресета-профиля:

| Профиль | Состав |
|---|---|
| `infra` | только NATS + PostgreSQL (замена сегодняшнего `docker-compose up -d postgres nats`) |
| `core` | infra + auction-service + telegram-gateway (Local) |
| `full` | всё, включая notifications, websocket-gateway, Loki/Grafana |

Инфраструктура (NATS, PostgreSQL) — всегда контейнеры.

## Скоуп / не-скоуп

Скоуп: AppHost-проект, режимы/профили, перенос всех сервисов, генерация compose-артефакта, обновление доков (AGENTS.md «Команды», README, сервисные AGENTS.md «Запуск»).

**Не-скоуп:** деплой и прод (k3s — отдельное решение/ADR), OTel-инструментирование Rust-gateway (C#-сервисам ServiceDefaults добавляем, Rust — задел на потом), удаление docker-compose из привычек CI (CI собирает без оркестратора, ему всё равно).

## Итерации

**Итерация 0 — ADR + скелет.**
1. ADR: «Aspire для локальной оркестрации» — альтернативы (status quo compose, Tilt, k3d), решение, границы (только dev-окружение).
2. `aspire` CLI, AppHost-проект в `infra/apphost/` (C# — родной для владельца). NATS (с JetStream-флагом, как в текущем compose) + PostgreSQL c volume + init-скриптами из текущего корневого compose. Проверка: `aspire run` → dashboard, оба контейнера живы.

**Итерация 1 — C#-сервисы.**
1. `AddProject` для auction-service, notifications-service, websocket-gateway; пробросить строки подключения NATS/PostgreSQL через env (инвентаризация: какие ключи ждёт каждый сервис в appsettings — выписать и унифицировать имена).
2. Подключить ServiceDefaults (OTel) хотя бы auction-service — увидеть логи+трейсы в dashboard.

**Итерация 2 — Rust gateway.**
1. `AddRustApp` (CommunityToolkit.Aspire.Hosting.Rust) или `AddExecutable("cargo", "run")` с `WorkingDirectory`; env `APP_*` (figment) — из тех же ресурсов, что у C#. Токен бота — параметр-secret Aspire (user secrets), не в репо.
2. e2e: ставка через бота при `aspire run` (профиль core).

**Итерация 3 — режимы и профили.**
1. Параметры `Local|Container|Off` на компонент + три пресета; `Container`-режим требует Dockerfile-ы (уже есть) через `AddDockerfile`.
2. Документация: таблица «как поднять X» в AGENTS.md, обновить «Запуск» в сервисных AGENTS.md.

**Итерация 4 — генерация compose, чистка.**
1. `aspire publish` (docker-compose publisher) → сгенерированный compose в `infra/publish/` как замена рукописных; удалить пер-сервисные compose-файлы, корневой оставить или заменить сгенерированным (решить по результату).
2. Финальная сверка доков.

## Критерии приёмки

- `aspire run` с профилем `full`: все сервисы стартуют, e2e-ставка проходит, логи C#-сервисов видны в dashboard.
- Профиль `infra` воспроизводит старый сценарий: сервисы запускаются руками из IDE/терминала и цепляются к контейнерам.
- Смена режима компонента — правка конфига/env, не кода AppHost.
- Рукописные пер-сервисные compose удалены, доки не упоминают их.

## Риски

- Windows: пути/интеграция cargo-executable — проверить на итерации 2 раньше остального полировочного.
- Скорость итераций Aspire (обновления ломают минорно) — фиксировать версию CLI/SDK в ADR.
- Соблазн тащить Aspire в деплой раньше времени — прод-топология решается ADR «Хостинг» отдельно.
