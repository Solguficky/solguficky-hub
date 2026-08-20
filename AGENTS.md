# Solguficky Hub

> Единая точка входа для AI-агентов. `CLAUDE.md` только импортирует этот файл — не редактируй его. Вложенные `AGENTS.md` содержат локальные правила сервисов.

Платформа для организации сходок Telegram-сообщества. Проект одновременно решает продуктовую задачу и служит полигоном для Event Sourcing, акторов и распределённых систем. При конфликте приоритетов выигрывает работающий продукт.

## Сначала прочитай

- [Документация](docs/README.md) — карта источников правды и статусов документов.
- [Продукт](docs/product/overview.md) — цель, принципы и границы MVP.
- [Архитектура](docs/architecture/overview.md) — Current / MVP / Future / Legacy и общие границы.
- [Сервисы](docs/services/README.md) — ответственность и открытые вопросы компонентов.
- [Архитектурные решения](docs/decisions/README.md) — индекс ADR и их применимость.
- [Стандарты](docs/standards/README.md) — нормативные инженерные соглашения.
- [Процесс проектирования](docs/development/design-process.md) — human-owned design loop и граница роли агента.
- [Локальная разработка](docs/development/local-development.md) — Aspire, профили и известные ограничения.

Milestones, приоритеты, задачи и прогресс ведутся в Linear. В Git хранятся устойчивый контекст, требования, решения и технические руководства; отдельного roadmap-файла нет.

## Карта репозитория

- `contracts/proto/` — канонические Protobuf-контракты NATS и gRPC; код генерируется потребителями при сборке.
- `services/telegram-gateway/` — Current/Legacy: Rust + Teloxide, преимущественно UI старого аукциона. MVP-направление: новая реализация на TypeScript + grammY после ADR.
- `services/auction-service/` — Legacy: C# + Akka.NET, CQRS/Event Sourcing. Не входит в MVP и не развивается без явного запроса.
- `services/notifications-service/` — Current: C#-каркас с аукционным обработчиком. Возможная роль в MVP ещё проектируется.
- `services/websocket-gateway/` — Legacy/Frozen: C# + SignalR только для аукциона; пока остаётся в сборке.
- `meetups` и `identity` — MVP-сервисы, ещё не реализованы. Identity остаётся отдельной границей; языки backend не выбраны.
- `frontend/admin-app/` — заглушка будущего Telegram Mini App.
- `tools/nats-tester/` — Python CLI для ручной проверки NATS-сообщений.
- `infra/apphost/` — локальная оркестрация .NET Aspire.

## Команды

```bash
# Локальная оркестрация — из infra/apphost/
aspire run

# Профили топологии
TOPOLOGY__PROFILE=infra aspire run
TOPOLOGY__PROFILE=full aspire run

# Режим компонента: Local | Container | Off
TOPOLOGY__AUCTIONSERVICE=Container aspire run

# C#-сервисы — из папки сервиса
dotnet build
dotnet test

# Текущий legacy gateway — из services/telegram-gateway/
cargo build
cargo test
cargo clippy -- -D warnings
cargo fmt --check

# nats-tester — из tools/nats-tester/
python generate_proto.py
pip install -e .
nats-tester --help
```

`aspire run` и часть профилей ещё не подтверждены живым прогоном после миграции. Не удаляй compose-файлы и не объявляй Aspire полностью проверенным, пока не выполнен gate из [руководства](docs/development/local-development.md).

## Критические правила

- Продуктовые и архитектурные решения принимает владелец. Агент исследует, оппонирует и реализует утверждённый срез.
- Не создавай новый сервис, ADR или межсервисный контракт без явного запроса.
- Для нетривиального принятого решения используй skill `sgh-record-decision`; ADR хранится отдельным файлом в `docs/decisions/`.
- Любое изменение `contracts/proto/` требует skill `sgh-change-contract`, обновления всех потребителей и каталога [integration.md](docs/architecture/integration.md).
- Не коммить без явной просьбы. Закончил правки — покажи `git status --short` и остановись. Push и PR — тоже отдельные явные решения владельца.
- Сообщение коммита — одна строка Conventional Commits с заглавной буквы после двоеточия; норматив и workflow — [commit-messages.md](docs/standards/git/commit-messages.md) и skill `sgh-write-commit`.
- NATS и gRPC используют Protobuf. JSON в шине запрещён.
- Не считай Core NATS надёжной доставкой: JetStream, durable consumers и идемпотентность требуют согласованного решения.
- Документация меняется вместе с кодом. При конфликте кода и документации выясни временной слой и зрелость решения, а не выбирай источник молча.
- Аукцион не входит в MVP. До удаления legacy-кода нужно извлечь доменную модель, actor/event-логику, полезные тест-кейсы и непроверенные гипотезы.
- Соблюдай тишину и ненавязчивость бота, privacy by design, минимизацию данных и минимальные Telegram-права. Способ взаимодействия определяется сценарием, а не глобальным правилом.

## Стандарты и локальные правила

Нормативные правила качества находятся в [docs/standards/](docs/standards/README.md). Не копируй их целиком сюда или в skills. Skill задаёт последовательность работы и ссылается на стандарт; вложенный `AGENTS.md` добавляет только специфику конкретного сервиса или языка.

Скиллы репозитория лежат в `.claude/skills/` и зеркалятся в `.agents/skills/`; команды — в `.claude/commands/`. Все они носят префикс `sgh-`, чтобы отличаться от персональных и плагинных. Имя скилла называет действие: `sgh-record-decision`, `sgh-change-contract`, `sgh-delegate-subtask`, `sgh-write-commit`, `sgh-draft-commit-message`.

Перед изменением сервиса проверь наличие его локального `AGENTS.md`. Если стандарта ещё нет, следуй существующему коду и тестам; устойчивое повторяемое правило оформляй отдельно только после согласования.
