# Solguficky Hub

> Единая точка входа для AI-агентов. `CLAUDE.md` только импортирует этот файл — не редактируй его. Вложенные `AGENTS.md` содержат локальные правила сервисов, и рядом с каждым лежит `CLAUDE.md` из одной строки `@AGENTS.md`: вложенную память Claude Code подхватывает только по имени `CLAUDE.md`, файл `AGENTS.md` сам по себе он не читает.

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

- `apps/` — деплоимые компоненты платформы. Что сюда попадает — в [apps/README.md](apps/README.md).
- `apps/identity/` — Identity на Go: gRPC-сервер с `ResolveIdentity` поверх PostgreSQL.
- `apps/telegram-bot/` — скелет Telegram Bot на TypeScript + grammY.
- `apps/community-site-api/` — serverless-функции сайта сообщества на TypeScript; сейчас одна: `/api/notes` держит заметки страницы «Аукцион 2026» в Netlify Blobs, с ревизиями и откатом к зафиксированной версии.
- `apps/meetups/` — Meetups на F#: доменное ядро среза в `Domain/`, шесть команд записи и три запроса чтения в `Slices/`, доступ к PostgreSQL в `Infrastructure/`, gRPC-сервер, C#-проект кодогенерации, миграции состояния сходки и журнала событий и два тестовых проекта; состояние и событие пишутся одной транзакцией, а два продуктовых запроса идут через единый viewer-aware reader.
- `contracts/proto/` — канонические Protobuf-контракты NATS и gRPC, разложенные по домену-владельцу и major-версии; код генерируется потребителями при сборке.
- `shared/dotnet/` — общий код .NET-сервисов; сейчас это ServiceDefaults, его потребляет Meetups. `shared/` содержит только подкаталоги по языкам и никогда не получает языконезависимый общий модуль.
- `infra/apphost/` — локальная оркестрация .NET Aspire.
- `infra/observability/` — конфигурация Loki, Promtail и Grafana для локального стека логов.
- `tools/git-hooks/` — POSIX sh скрипты проверок. Сейчас это `check-commit-message.sh`, его вызывает только локальный хук `commit-msg`.
- `tools/skillshare/` — два скрипта: `check-frontmatter.sh` разбирает YAML-frontmatter каждого `SKILL.md`, `install.sh` ставит внешние скиллы и падает, если install переписал объявление зависимостей. Первый вызывают `just check-agent-tools` и CI, второй — `just skillshare-install`.
- `tools/meetups/` — проверки Meetups. Сейчас это `check-contracts-generated.sh`: он держит контрактный C#-проект generated-only. Его вызывают `just meetups-contracts-check` и CI.
- `tools/community-site/` — проверки публикуемых страниц. Сейчас это `check-published-pages.sh`: он держит раскладку `docs/published/` картой адресов сайта и проверяет, что корневые ссылки разрешаются. Его вызывают `just check-published-pages`, CI и деплой-workflow.
- `tools/docs/` — проверка номеров ADR и RFC. Сейчас это `check-document-numbers.sh`: номер встречается ровно один раз, и у каждого файла есть строка в индексе своего каталога. Его вызывают `just check-document-numbers` и джоба `document-numbers` в CI.
- `.skillshare/` — источник правды по agent tooling: скиллы в `.skillshare/skills/`, роли подагентов в `.skillshare/agents/`. Из них `skillshare sync --all -p` раскладывает `.claude/skills/`, `.agents/skills/`, `.claude/agents/` и `.opencode/agents/`. В Git лежит только источник, таргеты собираются на каждой машине.
- `.rulesync/` — источник правды по MCP-серверам и командам агента: `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, `.vscode/mcp.json` и `opencode.jsonc` генерируются из `.rulesync/mcp.jsonc`, а `.claude/commands/` и `.opencode/commands/` — из `.rulesync/commands/`.
- `tools/nats-tester/` — Python CLI для ручной проверки NATS-сообщений.
- `justfile` — единая точка входа для команд репозитория; новый компонент добавляет туда свои рецепты, свою проверку в `verify` и установку своего тулинга в `tools` в том же коммите, что и сборку.

## Команды

Собраны в корневом `justfile` (`just --list`). Ниже — то же самое напрямую, если `just` не установлен.

```bash
# Git-хуки — один раз после клонирования, из корня
lefthook install

# Скиллы и роли подагентов — один раз после клонирования или создания
# рабочего дерева. В Git лежит только источник .skillshare/; таргеты
# .claude/skills/, .agents/skills/ и .claude/agents/ собирает sync, и до
# него у агента нет ни своих proj-скиллов, ни ролей. Флаг --all обязателен:
# без него sync раскладывает одни скиллы и молча оставляет роли пустыми.
# Внешние скиллы ставит install по config.yaml, и только он ходит в сеть:
# без неё запускают один sync и получают свои proj-скиллы и роли.
just skillshare-install
skillshare sync --all -p

# Тулинг компонентов — один раз после клонирования или создания рабочего
# дерева, до первого `just verify`. Дерево от `git worktree add` получает
# хуки и скиллы, но не node_modules, Go-плагины и dotnet tools: без них гейт
# красный по окружению, а не по правке, и гоняет он все компоненты, даже
# когда правка только в docs/.
just tools

# Проверка из хука (можно запускать вручную); в CI не дублируется
sh tools/git-hooks/check-commit-message.sh <файл-с-сообщением>

# Скиллы и роли: раскладка по таргетам после правок в .skillshare/
skillshare sync --all -p

# Frontmatter скиллов после sync
just check-agent-tools

# MCP и команды: раскладка по агентам после правок в .rulesync/
just sync-mcp
just sync-commands

# Конфигурация MCP и команды каждого агента совпадают с источником
just check-mcp
just check-commands

# Раскладка docs/published совпадает с адресами сайта, а ссылки разрешаются
just check-published-pages

# Номер ADR и RFC встречается один раз, у каждого файла есть строка в индексе
just check-document-numbers

# Механический гейт перед сдачей: agent tooling, MCP, публикуемые страницы, номера ADR/RFC, Identity, Telegram Bot, API сайта, AppHost, Meetups, формат F# и тесты
just verify

# Локальная оркестрация — из infra/apphost/
aspire run

# Профили топологии — данные в Topology:Profiles (infra/apphost/appsettings.json)
TOPOLOGY__PROFILE=infra aspire run
aspire run -- --profile hub

# Срез внутри профиля
aspire run -- --profile hub --run-services identity

# Identity — инструменты, кодогенерация, сборка, тесты и линт
just identity-tools
just identity-proto
just identity-build
just identity-test
just identity-lint
just identity-run
# IDENTITY_DATABASE_URL обязателен для identity-run; интеграционные тесты схемы требуют PostgreSQL

# Community site API — зависимости, typecheck, линт и тесты
just community-site-api-tools
just community-site-api-typecheck
just community-site-api-lint
just community-site-api-test
# Сборки нет: функцию бандлит Netlify CLI при деплое сайта

# Telegram Bot — зависимости, кодогенерация, сборка, тесты, линт и запуск
just telegram-bot-tools
just telegram-bot-proto
just telegram-bot-build
just telegram-bot-typecheck
just telegram-bot-test
just telegram-bot-lint
just telegram-bot-run

# Meetups — кодогенерация C#, сборка gRPC-сервиса, тесты и формат
just meetups-build
just meetups-test
just meetups-contracts-check
just meetups-run
just meetups-format
just meetups-format-check
# Fantomas берётся из .config/dotnet-tools.json; `just dotnet-tools` восстанавливает его

# .NET — из папки проекта
dotnet build
dotnet test

# nats-tester — из tools/nats-tester/
python generate_proto.py
pip install -e .
nats-tester --help
```

Часть проверок запускается без команды: PostToolUse-хуки в `.claude/settings.json` прогоняют `just check-agent-tools` после правки `.skillshare/**`, `just identity-proto && just telegram-bot-proto` после правки `contracts/proto/**` и `just sync-mcp && just sync-commands` после правки `.rulesync/**`. Хук видит правку через Edit и Write; изменение тех же файлов через Bash он не ловит, поэтому `just verify` перед сдачей нужен в любом случае.

Профили `infra`, `identity`, `meetups` и срез `hub` без Telegram Bot подтверждены живым прогоном на Aspire 13.5.3, включая Meetups с PostgreSQL и применением миграций при старте; профиль `hub` с Telegram Bot после объединения графов ещё не проверен. Aspire — единственный способ локальной оркестрации: compose-файлы удалены вместе с сервисами предыдущего поколения. Production-like `aspire publish` и production-топология не подтверждены; граница и повторяемый gate описаны в [руководстве](docs/development/local-development.md).

CodeRabbit не ревьюит pull request автоматически; запуск — комментарием `@coderabbitai review`. Активную конфигурацию показывает `@coderabbitai configuration`. Его находки помогают владельцу при ревью, но не становятся гейтом мержа.

## Критические правила

- Продуктовые и архитектурные решения принимает владелец. Агент исследует, оппонирует и реализует утверждённый срез.
- Не создавай новый сервис, ADR или межсервисный контракт без явного запроса.
- Для нетривиального принятого решения используй skill `proj-record-decision`; ADR хранится отдельным файлом в `docs/decisions/`.
- Любое изменение `contracts/proto/` требует skill `proj-change-contract`, обновления всех потребителей и каталога [integration.md](docs/architecture/integration.md).
- Внутри контура задачи доводи работу до pull request сам. Вне контура закончил правки — покажи `git status --short` и остановись. Шаги контура, чекпоинты, ручной гейт и таблица сред — [agent-execution-loop.md](docs/development/agent-execution-loop.md); они читаются оттуда целиком, без скиллов.
- Контур открывают два равноправных входа: владелец назвал `PER-N` и попросил начать, либо задача делегирована в Linear. Простое упоминание задачи в запросе на чтение, обсуждение или ревью контуром не является и рабочее дерево не меняет. В Claude Code вход выражает команда `/proj-take-task PER-N` (skill `proj-start-task`), закрывает контур skill `proj-deliver-task` открытым pull request.
- До создания ветки проверь, не занята ли задача: `delegate`, статус и открытый PR. Занята — не начинай и скажи, какой сигнал сработал.
- Занята ли задача — глобальное состояние, оно живёт в Linear. Ветка `feature/PER-N` отвечает только на локальный вопрос «над чем работает это дерево»; проверяй её по `git branch --show-current`, а не по памяти о разговоре. Ветки чужих инструментов (`cursor/`, `claude/`) признаком не являются.
- Ветку задачи создавай сам от `origin/develop`; одна задача — один pull request, `main` не трогай. Параллельная задача берёт отдельное дерево, поставляет его харнесс — норматив и предел параллелизма в [branching.md](docs/standards/git/branching.md).
- Слит или закрыт pull request — в тот же день снимай рабочее дерево задачи: `git worktree remove <дерево>`, затем `git worktree prune`. Признак завершённости — судьба pull request, а не расхождение ветки с `develop`: после squash ветка остаётся впереди и выглядит незаконченной. Порядок, деревья чужих инструментов и обход `Filename too long` на Windows — в [branching.md](docs/standards/git/branching.md).
- Остановился на вопросе, а ответ в этой сессии не дойдёт — не жди на незакоммиченной правке: зафиксируй остановку переносимо по разделу «Как фиксируется остановка».
- Сообщение коммита — одна строка Conventional Commits с заглавной буквы после двоеточия; норматив и workflow — [commit-messages.md](docs/standards/git/commit-messages.md) и skill `proj-write-commit`.
- Заголовок PR задачи — `[PER-N] Название задачи из Linear` дословно: без перевода, без своей формулировки, без типа впереди и без `(PER-N)` в хвосте. PR без задачи берёт форму коммита `type: Subject` на английском. Тело — на русском и ровно три раздела: `## Что и зачем`, `## Отклонения от плана`, `## Осталось открытым`. Встроенный шаблон инструмента (`Motivation`, `Description`, `Testing`) их не заменяет, и послабление для имён чужих веток на PR не распространяется. Формат и примеры — [branching.md](docs/standards/git/branching.md).
- Перед сдачей прогоняй `just verify`: механический гейт из agent tooling, MCP, публикуемых страниц, номеров ADR/RFC, Identity, Telegram Bot, API сайта сообщества, AppHost, Meetups, форматирования F# и тестов. Скилл `verify-this` решает другую задачу — проверяет отдельное утверждение экспериментом и гейт не заменяет.
- Формат сообщения проверяет локальный хук `commit-msg` (lefthook); скрипт проверки — в `tools/git-hooks/`. В CI формат не проверяется намеренно.
- Стандарт сообщений распространяется на обычные коммиты. Заголовки PR, merge- и squash-коммиты под него не подпадают и в CI не проверяются.
- NATS и gRPC используют Protobuf. JSON в шине запрещён.
- Не считай Core NATS надёжной доставкой: JetStream, durable consumers и идемпотентность требуют согласованного решения.
- Новый язык или стек обновляет корневой `.gitignore` в том же коммите, что и первая сборка на нём; правила секций — в шапке файла. Секцию для стека, которого в репозитории нет, не заводят.
- Документация меняется вместе с кодом. При конфликте кода и документации выясни временной слой и зрелость решения, а не выбирай источник молча.
- Перед итогом содержательной сессии, обсуждения, ревью, диагностики, изменения или контура запусти skill `proj-reflect-work`. Он предлагает только подтверждённые кандидаты для `proj-record-learning` и `proj-record-observation`, ничего не записывает и не выводит пустой блок. Простой ответ, промежуточный шаг и механическая правка без нового знания или сбоя процесса отдельной рефлексии не требуют. Запись начинается только после выбора владельца.
- Аукцион не входит в MVP и будет проектироваться с нуля. Доменная модель, actor/event-логика, тест-кейсы, каталог дефектов и непроверенные гипотезы прежней реализации извлечены в [архив](docs/archive/services/auction-domain-and-lessons.md); самого кода в репозитории нет.
- Соблюдай тишину и ненавязчивость бота, privacy by design, минимизацию данных и минимальные Telegram-права. Способ взаимодействия определяется сценарием, а не глобальным правилом.

## Стандарты и локальные правила

Нормативные правила качества находятся в [docs/standards/](docs/standards/README.md). Не копируй их целиком сюда или в skills. Skill задаёт последовательность работы и ссылается на стандарт; вложенный `AGENTS.md` добавляет только специфику конкретного сервиса или языка.

Источник правды по MCP-серверам — `.rulesync/mcp.jsonc`; `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, `.vscode/mcp.json` и `opencode.jsonc` генерируются из него командой `just sync-mcp`, и сгенерированный ключ `mcp` руками не правится. Остальные ключи `opencode.jsonc` генерация не трогает: они переживают `sync-mcp` и не считаются расхождением в `check-mcp`, поэтому проектные настройки OpenCode (`permission` и подобные), которых rulesync не умеет, живут в том же файле. Здесь не копирование, а перевод: Claude Code и Cursor читают JSON с ключом `mcpServers`, VS Code — JSON с ключом `servers`, OpenCode — JSONC с ключом `mcp`, а Codex — TOML с таблицами `mcp_servers`. Версия rulesync закреплена в `justfile`; `just check-mcp` возвращает 1 при расхождении таргета с источником и входит в `verify`. В источник попадают только серверы, от которых зависит контур исполнения; какие подключать сверх Linear и Aspire — решение владельца, а кандидаты и ограничения разобраны в [mcp-servers.md](docs/development/mcp-servers.md).

Граница с skillshare проведена по фичам: rulesync умеет ещё skills, subagents и hooks, но закреплены только `mcp` и `commands` — рецептами `sync-mcp`/`check-mcp` и `sync-commands`/`check-commands`, поэтому внешние скиллы продолжает собирать только skillshare. Zed не входит в `RULESYNC_MCP_TARGETS`, потому что rulesync владеет `.zed/settings.json` целиком. Проектные настройки Codex в его конфигурации не добавляют вручную; `opencode.jsonc` — исключение, там rulesync владеет только ключом `mcp`.

Источник правды по скиллам — `.skillshare/skills/`; `.claude/skills/` и `.agents/skills/` собираются из него командой `skillshare sync --all -p`, в Git не хранятся и руками не правятся. Раскладка источника: `proj/` — свои скиллы репозитория, `golang/_golang/` и `mattpocock/_skills/` — tracked-клоны [samber/cc-skills-golang](https://github.com/samber/cc-skills-golang) и [mattpocock/skills](https://github.com/mattpocock/skills) (обновляются `skillshare update golang/_golang -p` и `skillshare update mattpocock/_skills -p` — путь с группой обязателен, по одному имени `_golang` skillshare 0.20.25 клон не находит; сами клоны в `.gitignore`), остальные внешние скиллы лежат в корне. Оба таргета используют `target_naming: standard`, поэтому имена каталогов в таргетах остаются плоскими независимо от групп.

Tracked-клон приносит репозиторий целиком, поэтому лишнее гасится в `.skillignore`: из 46 скиллов пака Go включены 23, остальные выключены как ненужные этому репозиторию, а не как конфликтующие с нормативом. Таргеты — сгенерированный артефакт и в Git не лежат ([ADR-041](docs/decisions/ADR-041-skillshare-targets-not-committed.md)): оба каталога погашены в корневом `.gitignore`, а собирает их `skillshare sync --all -p` на каждой машине. Поэтому свежий клон, дерево от `git worktree add` и дерево от приложения получают один и тот же состав, а `sync` в дереве без внешних источников больше не может признать закоммиченную копию осиротевшей и удалить её — раньше одна команда так вычищала 46 записей манифеста на таргет. Цена: репозиторий не хранит запись о том, какой текст скилла агент фактически исполнял, и воспроизводимость держится на поле `version` в `.skillshare/skills/.metadata.json`, которого у tracked-клонов нет — у них только `branch: main`. Правку `proj-`скилла без `sync` ловить больше не нужно: копии, с которой её сверяли, нет, а сама правка читается в диффе источника один раз вместо трёх. Скилл со сломанным frontmatter ловится по-прежнему — `check-frontmatter.sh` разбирает источники напрямую, а не запись в манифесте, ради которой манифест и держали в Git. Объявление зависимостей — `.skillshare/config.yaml` и `.skillshare/skills/.metadata.json` — остаётся в Git, и правит его сам `skillshare install`: скилл, который блокирует его security audit, он вычёркивает из объявления молча (источник, который просто не клонируется, он оставляет на месте и печатает отказ). Поэтому install запускается через `just skillshare-install`: обёртка завершается ненулевым кодом, если объявление изменилось, и называет изменённый файл. Она же ставит `aspire-orchestration` отдельной командой с `--force` — аудит блокирует его ложным срабатыванием на строке чужого руководства, запрещающей агенту врать про сборку, а уже установленный скилл bulk-прогон не переаудирует и объявление не трогает.

Скиллы ставятся командой `skillshare install <url>`. `npx skills find` служит поиском по каталогу и ничего не устанавливает: установка мимо skillshare кладёт скилл в обход источника правды, и следующий `sync` его снесёт.

Внешний скилл берётся только если адаптируется через существующий шов — `docs/standards/`, `docs/agents/` и вложенные `AGENTS.md`. Скилл, который несёт свой шаблон задачи, свою таксономию меток или свой формат ADR внутри `SKILL.md`, спорит с нормативом и выключается в `.skillshare/skills/.skillignore`; править tracked-клон бессмысленно, `skillshare update` его перезапишет. По этой причине выключен `retro`: он несёт свои категории улучшений, опирается на `CODING_STANDARDS.md`, которого в репозитории нет, и не знает про журнал наблюдений; нужная функция вынесена в свой `proj-record-observation`. Вторая причина выключить внешний скилл — занятое имя: скиллы, команды и встроенные команды Claude Code делят одно пространство `/`, и вендоренный скилл перекрывает одноимённую встроенную команду молча. Так выключен `code-review`: имя вернулось встроенной команде, а нужная функция вынесена в свой `proj-review-change`. Список выключенного — в самом `.skillignore`, снимается командой `skillshare enable <имя> -p`. Если функция нужна по существу, дешевле написать свой `proj-`скилл поверх норматива, чем чинить чужой.

Источник правды по ролям подагентов — `.skillshare/agents/`; тот же sync раскладывает из него `.claude/agents/` и `.opencode/agents/`. В Git они не лежат по [ADR-041](docs/decisions/ADR-041-skillshare-targets-not-committed.md): решение говорит про таргеты skillshare, и каталоги ролей — такие же таргеты, что записано в `.gitignore` рядом с самим правилом. Набор ролей закреплённый и харнесс-независимый: файл несёт `name`, `description`, инструменты на чтение и тело с заданием, но **не несёт поля `model`**. Модель выбирает вызывающая сторона параметром вызова, беря уровень из таблицы «Маршрутизация по модели» в [agent-execution-cost.md](docs/development/agent-execution-cost.md); вызывающая сторона фактическую модель подагента не видит, поэтому отчёт называет две — запрошенную параметром вызова и ту, что подагент назвал о себе сам первой строкой ответа. Расхождение между ними и есть пойманная подмена заблокированной модели: без этой пары она проходит молча. Без поля `model` один и тот же файл копируется в оба таргета дословно, без перевода под диалект харнесса, а выбор модели остаётся на стороне вызова. Планирование и ревью логической корректности ролей не получают намеренно: они идут на модели сессии. Флаг `--all` в `skillshare sync --all -p` обязателен — `skillshare sync -p` раскладывает одни скиллы и оставляет роли неразложенными молча, а `just verify` этого не видит: вызов такой роли падает уже в сессии, с неизвестным `subagent_type`.

Упавший вызов роли сначала повторяют: реестр ролей в живой сессии обновляется не мгновенно, и роль, разложенная минуту назад, доступна не сразу. Падает и на повторе — проверяют раскладку тем же `sync --all -p`. Работу это не останавливает ни в одном случае: вызывающая сторона запускает подагента без роли, вставив задание из её тела в промпт, и передаёт ту же модель — отсутствие роли её не отменяет. Подмена и её причина называются в отчёте. Скиллы ссылаются на это правило, а не переписывают его.

Команды агента — источник правды `.rulesync/commands/`; `.claude/commands/` и `.opencode/commands/` генерируются из него командой `just sync-commands` и руками не правятся (`just check-commands` возвращает 1 при расхождении и входит в `verify`). Тело команды пишется в universal-синтаксисе rulesync — `$ARGUMENTS` и вставка вывода `` !`cmd` `` — а генератор переводит его в форму таргета, поэтому в теле не остаётся ни позиционных `$1`, ни путей вида `.claude/`. Таргетов два, а не пять, как у MCP: Codex CLI читает промпты только из домашнего каталога `~/.codex/prompts`, а Cursor и Copilot не раскрывают ни аргументы, ни вставки вывода команд — там тело доехало бы до модели текстом с `$ARGUMENTS` внутри. Расширить список — строка `RULESYNC_COMMAND_TARGETS` в `justfile`; сузить, когда команда нужна одному харнесу, — поле `targets` в её файле. Ключи, которых у других харнесов нет (`argument-hint`, `allowed-tools`), живут в блоке `claudecode:` frontmatter и в чужие таргеты не попадают. Свои скиллы, команды и роли подагентов носят префикс `proj-`, чтобы отличаться от внешних, персональных и плагинных: скиллы и команды делят одно пространство `/`, а роли — одно пространство `subagent_type` с плагинными вроде `codex-rescue`. Имя называет действие: скиллы `proj-record-decision`, `proj-change-contract`, `proj-create-task`, `proj-reflect-work`, `proj-record-learning`, `proj-record-observation`, `proj-write-commit`, `proj-start-task`, `proj-deliver-task`, `proj-review-change`, `proj-write-typescript`, `proj-write-grammy-bot`, `proj-write-aspire-apphost`, `proj-write-fsharp`, `proj-test-fsharp`, `proj-write-fsharp-vsa`; команды `proj-draft-commit-message`, `proj-take-task`; роли `proj-recon`, `proj-review-standards`, `proj-review-spec`.

F#-инструментарий намеренно разделён по контекстам: `proj-write-fsharp` отвечает за язык и interop, `proj-test-fsharp` — за xUnit v3, Unquote, FsCheck, Moq и Testcontainers, `proj-write-fsharp-vsa` — за выбранные в ADR-033 функциональные vertical slices и Oxpecker boundary. Основа синтезирована из общего `managedcode/dotnet-skills:fsharp` и проверенных практик `pampadu.kasko`, а не установлена пакетом: исходные skills не знают локальных ADR и несут либо слишком общий scaffolding, либо чужие архитектурные допущения. `ECC:fsharp-testing` не установлен отдельно, потому что его полезный стек закреплён проектным standard, а FsUnit и NSubstitute не вводятся вторым способом утверждений и mocking. Пакеты `majiayu` исключены из-за Giraffe/Fable/SQLite и заранее заданной структуры приложения; Akka-specific skill из `pampadu.kasko` к Meetups не применяется, потому что ADR-024 прямо оставляет actor runtime за границей сервиса.

Плагины включаются полем `enabledPlugins` в `.claude/settings.json` и действуют на весь проект. Сейчас включён `codex@openai-codex`: он приносит скиллы с префиксом `codex:` и агента `codex-rescue`, которые делегируют работу локальному Codex CLI. Плагин приходит мимо `.skillshare/` — `skillshare sync` его не раскладывает, `just check-agent-tools` его не проверяет, а без установленного Codex CLI его скиллы бесполезны.

Скилл, который агент не должен запускать сам, помечается `disable-model-invocation: true`. Так помечены `proj-record-learning` и `proj-record-observation`: агент сам находит кандидаты через `proj-reflect-work`, но владелец решает, что стоит записи. Детектор отделён от пишущих скиллов, чтобы инициатива агента не превращала гипотезу или разовый сбой в долговечный документ.

Перед изменением сервиса проверь наличие его локального `AGENTS.md`. Если стандарта ещё нет, следуй существующему коду и тестам; устойчивое повторяемое правило оформляй отдельно только после согласования.

## Agent skills

### Issue tracker

Задачи живут в Linear; GitHub несёт только код и review. См. [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

### Domain docs

Single-context: словарь домена в ADR, решения — в `docs/decisions/`. См. [docs/agents/domain.md](docs/agents/domain.md).
