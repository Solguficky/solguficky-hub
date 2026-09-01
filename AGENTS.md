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

- `apps/` — деплоимые компоненты платформы. Сейчас здесь Identity на Go (скелет gRPC с заглушкой `ResolveIdentity` и миграции PostgreSQL) и скелет Telegram Bot на TypeScript + grammY; исполняемых Meetups и Mini App ещё нет. Что сюда попадает — в [apps/README.md](apps/README.md).
- `contracts/proto/` — канонические Protobuf-контракты NATS и gRPC, разложенные по домену-владельцу и major-версии; код генерируется потребителями при сборке.
- `shared/dotnet/` — общий код .NET-сервисов; сейчас это ServiceDefaults. `shared/` содержит только подкаталоги по языкам и никогда не получает языконезависимый общий модуль.
- `infra/apphost/` — локальная оркестрация .NET Aspire.
- `infra/observability/` — конфигурация Loki, Promtail и Grafana для локального стека логов.
- `tools/git-hooks/` — POSIX sh скрипты проверок. Сейчас это `check-commit-message.sh`, его вызывает только локальный хук `commit-msg`.
- `tools/skillshare/` — проверка закоммиченных Skillshare-таргетов; её вызывают `just check-agent-tools` и CI.
- `tools/nats-tester/` — Python CLI для ручной проверки NATS-сообщений.
- `justfile` — единая точка входа для команд репозитория; новый компонент добавляет туда свои рецепты и свою проверку в `verify` в том же коммите, что и сборку.

## Команды

Собраны в корневом `justfile` (`just --list`). Ниже — то же самое напрямую, если `just` не установлен.

```bash
# Git-хуки — один раз после клонирования, из корня
lefthook install

# Скиллы, которых нет в Git — один раз после клонирования
skillshare sync -p

# Проверка из хука (можно запускать вручную); в CI не дублируется
sh tools/git-hooks/check-commit-message.sh <файл-с-сообщением>

# Скиллы: раскладка по таргетам после правок в .skillshare/skills/
skillshare sync -p

# Команды: отдельная раскладка, обычный sync их не трогает
skillshare sync extras -p

# Проверка закоммиченных skills, agents и commands после sync
just check-agent-tools

# Механический гейт перед сдачей: agent tooling, Identity, Telegram Bot и тесты
just verify

# Локальная оркестрация — из infra/apphost/
aspire run

# Профили топологии
TOPOLOGY__PROFILE=infra aspire run
TOPOLOGY__PROFILE=full aspire run

# Режим компонента: Local | Container | Off
TOPOLOGY__AUCTIONSERVICE=Container aspire run

# Identity — инструменты, кодогенерация, сборка, тесты и линт
just identity-tools
just identity-proto
just identity-build
just identity-test
just identity-lint
just identity-run
# IDENTITY_DATABASE_URL обязателен для identity-run; интеграционные тесты схемы требуют PostgreSQL

# Telegram Bot — зависимости, кодогенерация, сборка, тесты, линт и запуск
just telegram-bot-tools
just telegram-bot-proto
just telegram-bot-build
just telegram-bot-typecheck
just telegram-bot-test
just telegram-bot-lint
just telegram-bot-run

# .NET — из папки проекта
dotnet build
dotnet test

# nats-tester — из tools/nats-tester/
python generate_proto.py
pip install -e .
nats-tester --help
```

Часть проверок запускается без команды: PostToolUse-хуки в `.claude/settings.json` прогоняют `just check-agent-tools` после правки `.skillshare/**` и `just identity-proto && just telegram-bot-proto` после правки `contracts/proto/**`. Хук видит правку через Edit и Write; изменение тех же файлов через Bash он не ловит, поэтому `just verify` перед сдачей нужен в любом случае.

`aspire run` ещё не подтверждён живым прогоном. Aspire — единственный способ локальной оркестрации: compose-файлы удалены вместе с сервисами предыдущего поколения. Не объявляй Aspire проверенным, пока не выполнен gate из [руководства](docs/development/local-development.md).

## Критические правила

- Продуктовые и архитектурные решения принимает владелец. Агент исследует, оппонирует и реализует утверждённый срез.
- Не создавай новый сервис, ADR или межсервисный контракт без явного запроса.
- Для нетривиального принятого решения используй skill `proj-record-decision`; ADR хранится отдельным файлом в `docs/decisions/`.
- Любое изменение `contracts/proto/` требует skill `proj-change-contract`, обновления всех потребителей и каталога [integration.md](docs/architecture/integration.md).
- Внутри контура задачи, открытого владельцем на конкретную задачу Linear, доводи работу до pull request сам. Вне контура закончил правки — покажи `git status --short` и остановись. Границы контура, чекпоинты и стоп-триггеры — [agent-execution-loop.md](docs/development/agent-execution-loop.md).
- Текущая ветка `feature/PER-N` означает открытый контур на задачу `PER-N`. Признак читается из репозитория, поэтому переживает `/compact` и рестарт сессии; проверяй его по `git branch --show-current`, а не по памяти о разговоре. Открывает контур команда `/proj-take-task PER-N` (skill `proj-start-task`), закрывает — skill `proj-deliver-task` открытым pull request.
- Открывай контур скиллом `proj-start-task`, только когда владелец назвал `PER-N` и явно попросил начать или взять задачу; команда `/proj-take-task PER-N` выражает это намерение и подкладывает состояние git. Простое упоминание задачи в запросе на чтение, обсуждение или ревью контуром не является и рабочее дерево не меняет.
- В локальном контуре самостоятельно создавай ветку задачи `feature/PER-N` от `develop`; одна задача — один pull request, `main` не трогай. Норматив — [branching.md](docs/standards/git/branching.md).
- Сообщение коммита — одна строка Conventional Commits с заглавной буквы после двоеточия; норматив и workflow — [commit-messages.md](docs/standards/git/commit-messages.md) и skill `proj-write-commit`.
- Перед сдачей прогоняй `just verify`: механический гейт из agent tooling, Identity, Telegram Bot и тестов. Скилл `verify-this` решает другую задачу — проверяет отдельное утверждение экспериментом и гейт не заменяет.
- Формат сообщения проверяет локальный хук `commit-msg` (lefthook); скрипт проверки — в `tools/git-hooks/`. В CI формат не проверяется намеренно.
- Стандарт сообщений распространяется на обычные коммиты. Заголовки PR, merge- и squash-коммиты под него не подпадают и в CI не проверяются.
- NATS и gRPC используют Protobuf. JSON в шине запрещён.
- Не считай Core NATS надёжной доставкой: JetStream, durable consumers и идемпотентность требуют согласованного решения.
- Новый язык или стек обновляет корневой `.gitignore` в том же коммите, что и первая сборка на нём; правила секций — в шапке файла. Секцию для стека, которого в репозитории нет, не заводят.
- Документация меняется вместе с кодом. При конфликте кода и документации выясни временной слой и зрелость решения, а не выбирай источник молча.
- Срез затронул технологию, которой нет в реестре [docs/learning/README.md](docs/learning/README.md), или существенно расширил разобранную тему — запусти skill `proj-record-learning`. Для C#, F#, .NET, Aspire, Markdown, YAML, sh, justfile и Python-тулинга разбор не пишется: ими владелец владеет. Сомневаешься — спроси одной строкой до запуска.
- Аукцион не входит в MVP и будет проектироваться с нуля. Доменная модель, actor/event-логика, тест-кейсы, каталог дефектов и непроверенные гипотезы прежней реализации извлечены в [архив](docs/archive/services/auction-domain-and-lessons.md); самого кода в репозитории нет.
- Соблюдай тишину и ненавязчивость бота, privacy by design, минимизацию данных и минимальные Telegram-права. Способ взаимодействия определяется сценарием, а не глобальным правилом.

## Стандарты и локальные правила

Нормативные правила качества находятся в [docs/standards/](docs/standards/README.md). Не копируй их целиком сюда или в skills. Skill задаёт последовательность работы и ссылается на стандарт; вложенный `AGENTS.md` добавляет только специфику конкретного сервиса или языка.

Источник правды по скиллам — `.skillshare/skills/`; `.claude/skills/` и `.agents/skills/` собираются из него командой `skillshare sync -p` и руками не правятся. Раскладка источника: `proj/` — свои скиллы репозитория, `golang/_golang/` и `mattpocock/_skills/` — tracked-клоны [samber/cc-skills-golang](https://github.com/samber/cc-skills-golang) и [mattpocock/skills](https://github.com/mattpocock/skills) (обновляются `skillshare update golang/_golang -p` и `skillshare update mattpocock/_skills -p` — путь с группой обязателен, по одному имени `_golang` skillshare 0.20.25 клон не находит; сами клоны в `.gitignore`), остальные внешние скиллы лежат в корне. Оба таргета используют `target_naming: standard`, поэтому имена каталогов в таргетах остаются плоскими независимо от групп.

Tracked-клон приносит репозиторий целиком, поэтому лишнее гасится в `.skillignore`: из 46 скиллов пака Go включены 23, остальные выключены как ненужные этому репозиторию, а не как конфликтующие с нормативом. Клон в Git не лежит, и таргеты пака тоже: `.claude/skills/.gitignore` и `.agents/skills/.gitignore` гасят `golang-*/`, поэтому после клонирования их раскладывает `skillshare sync -p`. Свои `proj-`скиллы и внешние скиллы в таргетах закоммичены намеренно — по ним джоба `repo-hygiene` сверяет таргет с источником и ловит правку скилла без `sync`; погасив таргеты целиком, эту проверку в CI потеряли бы. Закоммиченные таргеты помечены в `.gitattributes` атрибутами `-diff` и `linguist-generated=true`: первый убирает их из локального `git diff`, второй прячет содержимое в review на GitHub. Счётчик строк в шапке pull request не убирает ни один — GitHub считает строки независимо от атрибутов, поэтому объём режется тем, чего в коммите нет. Посмотреть правку скилла в таргете можно флагом `git diff --text`.

Скиллы ставятся командой `skillshare install <url>`. `npx skills find` служит поиском по каталогу и ничего не устанавливает: установка мимо skillshare кладёт скилл в обход источника правды, и следующий `sync` его снесёт.

Внешний скилл берётся только если адаптируется через существующий шов — `docs/standards/`, `docs/agents/` и вложенные `AGENTS.md`. Скилл, который несёт свой шаблон задачи, свою таксономию меток или свой формат ADR внутри `SKILL.md`, спорит с нормативом и выключается в `.skillshare/skills/.skillignore`; править tracked-клон бессмысленно, `skillshare update` его перезапишет. По этой причине выключен `retro`: он несёт свои категории улучшений, опирается на `CODING_STANDARDS.md`, которого в репозитории нет, и не знает про журнал наблюдений; нужная функция вынесена в свой `proj-record-observation`. Вторая причина выключить внешний скилл — занятое имя: скиллы, команды и встроенные команды Claude Code делят одно пространство `/`, и вендоренный скилл перекрывает одноимённую встроенную команду молча. Так выключен `code-review`: имя вернулось встроенной команде, а нужная функция вынесена в свой `proj-review-change`. Список выключенного — в самом `.skillignore`, снимается командой `skillshare enable <имя> -p`. Если функция нужна по существу, дешевле написать свой `proj-`скилл поверх норматива, чем чинить чужой.

Команды лежат в `.claude/commands/`; их источник `.skillshare/extras/commands/`, раскладывает их `skillshare sync extras -p`. Свои скиллы и команды носят префикс `proj-`, чтобы отличаться от внешних, персональных и плагинных. Имя называет действие: скиллы `proj-record-decision`, `proj-change-contract`, `proj-create-task`, `proj-record-learning`, `proj-record-observation`, `proj-write-commit`, `proj-start-task`, `proj-deliver-task`, `proj-review-change`, `proj-write-typescript`, `proj-write-grammy-bot`; команды `proj-draft-commit-message`, `proj-take-task`.

Плагины включаются полем `enabledPlugins` в `.claude/settings.json` и действуют на весь проект. Сейчас включён `codex@openai-codex`: он приносит скиллы с префиксом `codex:` и агента `codex-rescue`, которые делегируют работу локальному Codex CLI. Плагин приходит мимо `.skillshare/` — `skillshare sync` его не раскладывает, `just check-agent-tools` его не проверяет, а без установленного Codex CLI его скиллы бесполезны.

Скилл, который агент не должен запускать сам, помечается `disable-model-invocation: true` — сейчас это только `proj-record-observation`: журнал наблюдений ведёт владелец, и агент не решает за него, что стоит записи. У `proj-record-learning` пометка снята: понять, что срез задел незнакомую технологию, агент может по самому диффу, а границы применимости заданы в описании скилла и в критических правилах выше.

Перед изменением сервиса проверь наличие его локального `AGENTS.md`. Если стандарта ещё нет, следуй существующему коду и тестам; устойчивое повторяемое правило оформляй отдельно только после согласования.

## Agent skills

### Issue tracker

Задачи живут в Linear; GitHub несёт только код и review. См. [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

### Domain docs

Single-context: словарь домена в ADR, решения — в `docs/decisions/`. См. [docs/agents/domain.md](docs/agents/domain.md).
