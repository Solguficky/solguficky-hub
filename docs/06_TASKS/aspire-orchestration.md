# ТЗ: локальная оркестрация на Aspire (вместо трёх docker-compose)

> Статус: **утверждено к работе** (решение владельца 2026-07-18). Оценка: 4–5 итераций по 1–2 ч. Заменяет пункт P0 «единый docker-compose.yml».

## Мотивация

Сейчас три рукописных compose-файла (корневой + auction-service + websocket-gateway), топология «что поднять для этой задачи» собирается руками. Aspire (с v13 — полиглотный, текущая 13.5) даёт:

- **один AppHost** = вся топология кодом: контейнеры (NATS, PostgreSQL), C#-проекты, Rust через `AddExecutable`/community `AddRustApp`;
- **dashboard** из коробки: логи всех сервисов в одном месте, OTel-трейсы, health;
- service discovery: строки подключения/env инжектятся автоматически, а не копипастятся по compose-файлам;
- `aspire publish`: docker-compose и Kubernetes-манифесты становятся **генерируемыми артефактами** топологии (пригодится для деплоя на k3s — см. ROADMAP «Хостинг/деплой»).

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
