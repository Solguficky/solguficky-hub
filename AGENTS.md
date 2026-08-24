# Solguficky Hub

> Единая точка входа для AI-агентов. `CLAUDE.md` только импортирует этот файл — не редактируй его. Вложенные `AGENTS.md` содержат локальные правила сервисов.

Платформа для организации сходок Telegram-сообщества. Проект одновременно решает продуктовую задачу и служит полигоном для Event Sourcing, акторов и распределённых систем. При конфликте приоритетов выигрывает работающий продукт.

## Сначала прочитай

- [Документация](docs/README.md) — карта источников правды и статусов документов.
- [Продукт](docs/product/overview.md) — цель, принципы и границы MVP.
- [Архитектура](docs/architecture/overview.md) — Current / MVP / Future и общие границы.
- [Сервисы](docs/services/README.md) — ответственность и открытые вопросы компонентов.
- [Архитектурные решения](docs/decisions/README.md) — индекс ADR и их применимость.
- [Стандарты](docs/standards/README.md) — нормативные инженерные соглашения.
- [Процесс проектирования](docs/development/design-process.md) — human-owned design loop и граница роли агента.
- [Локальная разработка](docs/development/local-development.md) — Aspire, профили и известные ограничения.

Milestones, приоритеты, задачи и прогресс ведутся в Linear. Правила их ведения — [standards/backlog/linear.md](docs/standards/backlog/linear.md); задача не заводится и не переписывается в обход этого норматива. В Git хранятся устойчивый контекст, требования, решения и технические руководства; отдельного roadmap-файла нет.

## Карта репозитория

- `apps/` — деплоимые компоненты платформы. Сейчас здесь контур кодогенерации Identity; исполняемых Meetups, Identity, Mini App и Telegram Bot ещё нет. Что сюда попадает — в [apps/README.md](apps/README.md).
- `contracts/proto/` — канонические Protobuf-контракты NATS и gRPC, разложенные по домену-владельцу и major-версии; код генерируется потребителями при сборке.
- `shared/dotnet/` — общий код .NET-сервисов; сейчас это ServiceDefaults. `shared/` содержит только подкаталоги по языкам и никогда не получает языконезависимый общий модуль.
- `infra/apphost/` — локальная оркестрация .NET Aspire.
- `infra/observability/` — конфигурация Loki, Promtail и Grafana для локального стека логов.
- `tools/git-hooks/` — POSIX sh скрипты проверок. `check-skills-mirror.sh` вызывают и хук `pre-commit`, и джоба `repo-hygiene` в CI; `check-commit-message.sh` — только локальный хук.
- `tools/nats-tester/` — Python CLI для ручной проверки NATS-сообщений.
- `justfile` — единая точка входа для команд репозитория; новый компонент добавляет свои рецепты туда вместе со сборкой.

## Команды

Собраны в корневом `justfile` (`just --list`). Ниже — то же самое напрямую, если `just` не установлен.

```bash
# Git-хуки — один раз после клонирования, из корня
lefthook install

# Проверки из хуков (можно запускать вручную); в CI из них идёт только skills-mirror
sh tools/git-hooks/check-commit-message.sh <файл-с-сообщением>
sh tools/git-hooks/check-skills-mirror.sh

# Локальная оркестрация — из infra/apphost/
aspire run

# Профили топологии
TOPOLOGY__PROFILE=infra aspire run
TOPOLOGY__PROFILE=full aspire run

# Режим компонента: Local | Container | Off
TOPOLOGY__AUCTIONSERVICE=Container aspire run

# Identity — кодогенерация и проверка контракта
just identity-proto
just identity-build
just identity-test

# .NET — из папки проекта
dotnet build
dotnet test

# nats-tester — из tools/nats-tester/
python generate_proto.py
pip install -e .
nats-tester --help
```

`aspire run` ещё не подтверждён живым прогоном. Aspire — единственный способ локальной оркестрации: compose-файлы удалены вместе с сервисами предыдущего поколения. Не объявляй Aspire проверенным, пока не выполнен gate из [руководства](docs/development/local-development.md).

## Критические правила

- Продуктовые и архитектурные решения принимает владелец. Агент исследует, оппонирует и реализует утверждённый срез.
- Не создавай новый сервис, ADR или межсервисный контракт без явного запроса.
- Для нетривиального принятого решения используй skill `sgh-record-decision`; ADR хранится отдельным файлом в `docs/decisions/`.
- Любое изменение `contracts/proto/` требует skill `sgh-change-contract`, обновления всех потребителей и каталога [integration.md](docs/architecture/integration.md).
- Не коммить без явной просьбы. Закончил правки — покажи `git status --short` и остановись. Push и PR — тоже отдельные явные решения владельца.
- Сообщение коммита — одна строка Conventional Commits с заглавной буквы после двоеточия; норматив и workflow — [commit-messages.md](docs/standards/git/commit-messages.md) и skill `sgh-write-commit`.
- Формат сообщения проверяет локальный хук `commit-msg` (lefthook), синхронность скиллов — хук `pre-commit` и джоба `repo-hygiene` в CI. Скрипты проверок — в `tools/git-hooks/`.
- Стандарт сообщений распространяется на обычные коммиты. Заголовки PR, merge- и squash-коммиты под него не подпадают и в CI не проверяются.
- NATS и gRPC используют Protobuf. JSON в шине запрещён.
- Не считай Core NATS надёжной доставкой: JetStream, durable consumers и идемпотентность требуют согласованного решения.
- Новый язык или стек обновляет корневой `.gitignore` в том же коммите, что и первая сборка на нём; правила секций — в шапке файла. Секцию для стека, которого в репозитории нет, не заводят.
- Документация меняется вместе с кодом. При конфликте кода и документации выясни временной слой и зрелость решения, а не выбирай источник молча.
- Аукцион не входит в MVP и будет проектироваться с нуля. Доменная модель, actor/event-логика, тест-кейсы, каталог дефектов и непроверенные гипотезы прежней реализации извлечены в [архив](docs/archive/services/auction-domain-and-lessons.md); самого кода в репозитории нет.
- Соблюдай тишину и ненавязчивость бота, privacy by design, минимизацию данных и минимальные Telegram-права. Способ взаимодействия определяется сценарием, а не глобальным правилом.

## Стандарты и локальные правила

Нормативные правила качества находятся в [docs/standards/](docs/standards/README.md). Не копируй их целиком сюда или в skills. Skill задаёт последовательность работы и ссылается на стандарт; вложенный `AGENTS.md` добавляет только специфику конкретного сервиса или языка.

Скиллы репозитория лежат в `.claude/skills/`. Общие зеркалятся в `.agents/skills/` побайтово; специфичные для возможностей Claude Code живут только в `.claude/skills/` и перечислены в `CLAUDE_ONLY` скрипта `check-skills-mirror.sh` — сейчас это `sgh-delegate-subtask`. Команды — в `.claude/commands/`. Все они носят префикс `sgh-`, чтобы отличаться от персональных и плагинных. Имя скилла называет действие: `sgh-record-decision`, `sgh-change-contract`, `sgh-create-task`, `sgh-delegate-subtask`, `sgh-write-commit`, `sgh-draft-commit-message`.

Перед изменением сервиса проверь наличие его локального `AGENTS.md`. Если стандарта ещё нет, следуй существующему коду и тестам; устойчивое повторяемое правило оформляй отдельно только после согласования.
