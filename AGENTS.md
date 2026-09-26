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
- `apps/identity/` — Identity на Go: gRPC-сервер с `ResolveIdentity` поверх PostgreSQL и outbox исходящих событий с релеем в JetStream; изменение состояния доступа без события той же транзакции схема не коммитит.
- `apps/telegram-bot/` — скелет Telegram Bot на TypeScript + grammY.
- `apps/community-site-api/` — serverless-функции сайта сообщества на TypeScript; сейчас одна: `/api/notes` держит заметки страницы «Аукцион 2026» в Netlify Blobs, с ревизиями и откатом к зафиксированной версии.
- `apps/meetups/` — Meetups на F#: доменное ядро среза в `Domain/`, команды записи и запросы чтения в `Slices/`, доступ к PostgreSQL в `Infrastructure/`, gRPC-сервер, C#-проект кодогенерации, миграции состояния сходки и журнала событий и тестовые проекты `Meetups.UnitTests`, `Meetups.IntegrationTests` и общий `Meetups.TestKit`; состояние и событие пишутся одной транзакцией, а продуктовые запросы идут через единый viewer-aware reader.
- `apps/notifications/` — Notifications на C# и Orleans. Силос co-hosted с gRPC-сервером, своя база PostgreSQL, миграции при старте одним DbUp — им же применяются вендорные скрипты кластеризации и reminders Orleans, — грин на сходку, материализованное задание напоминания со sweeper'ом и тестовые проекты `Notifications.UnitTests`, `Notifications.IntegrationTests` и общий `Notifications.TestKit`. Grain storage не зарегистрирован намеренно: источник истины остаётся в PostgreSQL, и отсутствие провайдера делает это правило исполнимым, а не пунктом на review. Reminders, наоборот, зарегистрированы, и правила они не ослабляют: reminder будит грин к моменту срабатывания, но момент лежит строкой в `reminder_task`, а пропущенный за время простоя тик подбирает sweeper по той же таблице. Подписки и gRPC — PER-71, реплика чужих фактов — PER-215, адресный факт о новой сходке с релеем outbox в шину — PER-216, факты изменения, материала и снятия с публикации — PER-218, канал доставки — PER-217.
- `apps/auction/` — Auction на Scala 3 и Apache Pekko: пока языковой контур, а не сервис. Сборка sbt, кодогенерация ScalaPB из `contracts/proto` внутри `compile`, HTTP-граница с health на Pekko HTTP и тесты ScalaTest; в графе Aspire — узел с базой, запущенный голой JVM. Торгов и persistence в нём нет.
- `contracts/proto/` — канонические Protobuf-контракты NATS и gRPC, разложенные по домену-владельцу и major-версии; код генерируется потребителями при сборке, стиль и совместимость схем держат `buf lint` и `buf breaking` в CI.
- `shared/dotnet/` — общий код .NET-сервисов; сейчас это ServiceDefaults, его потребляют Meetups и Notifications. `shared/` содержит только подкаталоги по языкам и никогда не получает языконезависимый общий модуль.
- `infra/apphost/` — локальная оркестрация .NET Aspire, разложенная как компонент: проект `AppHost/` и его тесты `AppHost.UnitTests/`. Какой AppHost запускать, CLI читает из `appHost.path` в корневом `aspire.config.json`.
- `infra/apphost/AppHost.UnitTests/` — тесты графа и профилей AppHost на xUnit v3: валидация владения узлом и материализация модели отрабатывают до старта ресурсов, поэтому Docker набору не нужен. Рецепт `just apphost-test`, входит в `verify` и в джобу `apphost` в CI.
- `infra/observability/` — конфигурация Loki, Promtail и Grafana для локального стека логов.
- `tests/` — наборы уровня решения, которые не принадлежат ни одному компоненту, потому что пересекают несколько. Сейчас это `tests/contour/` — сквозной уровень L2 на `Aspire.Hosting.Testing`: `Contour.Environment` поднимает топологию и отдаёт адреса, `Contour.E2ETests` гоняет дымовой сценарий через настоящие Identity и Meetups, `Contour.Host` отдаёт `IDENTITY_GRPC_URL` и `MEETUPS_GRPC_URL` внешнему потребителю, `Contour.Contracts` держит generated-only C#-клиента Identity. Рецепты `just contour-test`, `just contour-up` и `just contour-contracts-check`; в `verify` набор не входит и гоняется джобой `contour` в CI.
- `tools/git-hooks/` — POSIX sh скрипты локальных хуков. Сейчас их два: `check-commit-message.sh` вызывает только хук `commit-msg`, `sync-skillshare-targets.sh` — хуки `post-checkout` и `post-merge`, чтобы таргеты skillshare не отставали от источника после смены ветки, pull и создания дерева.
- `tools/skillshare/` — два скрипта: `check-frontmatter.sh` разбирает YAML-frontmatter каждого `SKILL.md`, `install.sh` ставит внешние скиллы и падает, если install переписал объявление зависимостей. Первый вызывают `just check-agent-tools` и CI, второй — `just skillshare-install`.
- `tools/identity/` — прогоны Identity. Сейчас это `test-integration.sh`: он гоняет тесты под тегом сборки `integration` и роняет прогон на пропуске, которого `go test` сам не ловит. Его вызывает `just identity-test-integration`.
- `tools/meetups/` — проверки Meetups. Сейчас это `check-contracts-generated.sh`: он держит контрактный C#-проект generated-only. Его вызывают `just meetups-contracts-check` и CI.
- `tools/notifications/` — проверки Notifications. Сейчас это `check-contracts-generated.sh`: тот же гейт generated-only для контрактного проекта сервиса. Его вызывают `just notifications-contracts-check` и CI.
- `tools/contour/` — проверки сквозного контура. Сейчас это `check-contracts-generated.sh`: тот же гейт generated-only для контрактного проекта контура. Его вызывают `just contour-contracts-check` и CI.
- `tools/apphost/` — живой smoke-test профиля AppHost. Сейчас это `smoke.sh`: он ждёт конечного состояния всех ресурсов, делает доменный вызов каждого gRPC-сервиса с общим `x-request-id` и проверяет топологию JetStream. Его вызывает `just aspire-smoke`; в `verify` и CI он не входит, потому что нужны Docker и живой AppHost.
- `tools/community-site/` — проверки публикуемых страниц. Сейчас это `check-published-pages.sh`: он держит раскладку `docs/published/` картой адресов сайта и проверяет, что корневые ссылки разрешаются. Его вызывают `just check-published-pages`, CI и деплой-workflow.
- `tools/docs/` — механические проверки документации. Сейчас их три. `check-document-numbers.sh`: номер встречается ровно один раз, и у каждого файла есть строка в индексе своего каталога; его вызывают `just check-document-numbers` и джоба `document-numbers` в CI. `check-adr-applicability.sh`: у не-Active ADR баннер применимости стоит первой строкой после заголовка и совпадает со строкой индекса; его вызывают `just check-adr-applicability` и джоба `adr-applicability` в CI. `check-doc-links.py`: относительная ссылка из `docs/**/*.md` на `.md` ведёт в существующий файл, а якорь — на заголовок со slug по правилам GitHub; внешние URL пропускаются. Написан на Python, потому что slug переводит кириллицу в нижний регистр, а байтовый awk этого не умеет без UTF-8 локали. Его вызывают `just check-doc-links` и джоба `doc-links` в CI.
- `tools/verify/` — сужение механического гейта. `select-recipes.sh` выбирает рецепты `verify` по изменённым путям, читая карту из джобы `changes` в `.github/workflows/ci.yml`; его вызывает `just verify-changed`. Фикстуры `select-recipes-test.sh` держат выбор равным составу `verify` на правке `justfile`; их вызывают `just check-verify-selection` и джоба `repo-hygiene` в CI.
- `.skillshare/` — источник правды по agent tooling: скиллы в `.skillshare/skills/`, роли подагентов в `.skillshare/agents/`. Из них `skillshare sync --all -p` раскладывает `.claude/skills/`, `.agents/skills/`, `.claude/agents/` и `.opencode/agents/`. В Git лежит только источник, таргеты собираются на каждой машине.
- `.rulesync/` — источник правды по MCP-серверам и командам агента: `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, `.vscode/mcp.json` и `opencode.jsonc` генерируются из `.rulesync/mcp.jsonc`, а `.claude/commands/` и `.opencode/commands/` — из `.rulesync/commands/`.
- `tools/nats-tester/` — Python CLI для ручной проверки NATS-сообщений; единственный сервис репозитория с закоммиченными сгенерированными классами. Проверку держит `python -m nats_tester.gate`: импорт классов, состав генерации против схем, согласие реестра. Её вызывают `just nats-tester-check` и джоба `nats-tester` в CI; джоба дополнительно перегенерирует классы закреплённым `protoc` и падает на расхождении со схемой.
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
# Дальше sync запускают хуки post-checkout и post-merge (lefthook); руками
# он нужен, только если хуки не установлены или skillshare нет в PATH.
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

# Применимость не-Active ADR в индексе совпадает с баннером в самом файле
just check-adr-applicability

# Относительные ссылки в docs/ ведут на существующий файл и заголовок
just check-doc-links

# Весь модуль contracts/proto компилируется, включая домен без потребителя
just contracts-build

# Стиль схем и совместимость с origin/develop: buf lint и buf breaking
just contracts-check

# Весь модуль contracts/proto генерируется на Go, TypeScript и Scala
just contracts-codegen

# Механический гейт перед сдачей, сужённый до затронутых компонентов; правило
# выбора — комментарий над рецептом `verify-changed` в justfile
just verify-changed

# Полный механический гейт; состав — комментарий над рецептом `verify` в justfile
just verify

# Выбор verify-changed совпадает с картой путей CI и с составом verify
just check-verify-selection

# Все уровни тестов (unit, интеграционные, сквозной); падает на пропуске.
# Нужны Docker и PostgreSQL для Identity; в verify не входит
just test-all

# Локальная оркестрация — AppHost называет aspire.config.json в корне;
# wait/describe/stop к запущенному AppHost — из корня
aspire run

# Профили топологии — данные в Topology:Profiles (infra/apphost/AppHost/appsettings.json)
TOPOLOGY__PROFILE=infra aspire run
aspire run -- --profile hub

# Срез внутри профиля
aspire run -- --profile hub --run-services identity

# Живой smoke-test профиля; нужны Docker, grpcurl и python3
just aspire-smoke hub

# AppHost — сборка и тесты графа и профилей; Docker не нужен
just apphost-build
just apphost-test

# Identity — инструменты, кодогенерация, сборка, тесты и линт
just identity-tools
just identity-proto
just identity-build
just identity-test
just identity-test-integration
just identity-lint
just identity-run
# IDENTITY_DATABASE_URL обязателен для identity-run и identity-test-integration: умолчания
# на 127.0.0.1:5432 нет, без переменной рецепт отказывает до go test. identity-test —
# unit без базы; тесты с PostgreSQL лежат под тегом сборки integration

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
just telegram-bot-test-integration
just telegram-bot-lint
just telegram-bot-run
# telegram-bot-test — без Docker; *.integration.test.ts с Testcontainers идут в
# telegram-bot-test-integration

# Meetups — кодогенерация C#, сборка gRPC-сервиса, тесты и формат
just meetups-build
just meetups-test
just meetups-test-integration
just meetups-contracts-check
just meetups-run
just meetups-format
just meetups-format-check
# Fantomas берётся из .config/dotnet-tools.json; `just dotnet-tools` восстанавливает его

# Notifications — сборка силоса, тесты, гейт контрактов и запуск
just notifications-build
just notifications-test
just notifications-test-integration
just notifications-contracts-check
just notifications-run
# NOTIFICATIONS_DATABASE_URL обязателен для notifications-run. *-test — unit без Docker;
# *-test-integration поднимает PostgreSQL через Testcontainers и без Docker падает

# Auction — зависимости, кодогенерация, сборка, тесты, формат и запуск
just auction-tools
just auction-proto
just auction-build
just auction-test
just auction-lint
just auction-format
just auction-run
# Нужны JDK версии из apps/auction/.java-version и sbt; репозиторий их не ставит.
# Кодогенерация входит в сборку: auction-proto нужен только отдельным шагом

# Сквозной контур (L2) — дымовой прогон, среда наружу, гейт контрактов
just contour-test
just contour-up '--env-file .contour.env'
just contour-contracts-check
# Нужны Docker, go и buf в PATH: узел Identity сначала генерирует Go-код и
# собирает бинарник. В verify набор не входит; в CI его гоняет джоба contour,
# которая намеренно не числится в обязательных проверках ветки

# .NET — из папки проекта
dotnet build
dotnet test

# nats-tester — зависимости, регенерация закоммиченных классов, гейт и запуск
just nats-tester-tools
just nats-tester-proto
just nats-tester-check
cd tools/nats-tester && nats-tester --help
```

Часть проверок запускается без команды: PostToolUse-хуки в `.claude/settings.json` прогоняют `just check-agent-tools` после правки `.skillshare/**`, `just identity-proto && just telegram-bot-proto` после правки `contracts/proto/**` и `just sync-mcp && just sync-commands` после правки `.rulesync/**`. Хук видит правку через Edit и Write; изменение тех же файлов через Bash он не ловит, поэтому `just verify-changed` перед сдачей нужен в любом случае.

Что именно подтверждено живым прогоном Aspire — в [руководстве](docs/development/local-development.md); оно единственный владелец этого факта, и перечень профилей сюда не копируется. Полный `hub` с Telegram Bot прогнан отдельным локальным ботом в продакшн-среде Telegram; непроверенной остаётся тестовая среда Telegram. Токен бота сообщества способом проверки не является — живой бот начал бы отвечать реальным людям, и второй polling-экземпляр получает `409 Conflict`. Профиль владеет узлом, и зарегистрированный узел обязан быть назван хотя бы одним профилем: граф отвергает запуск до старта ресурсов, если владельца нет, поэтому регистрация узла едет одним изменением с профилем. Рабочее дерево находит свой AppHost через собственный корневой `aspire.config.json`, поэтому `--apphost` в дереве больше не нужен. Aspire — единственный способ локальной оркестрации: compose-файлы удалены вместе с сервисами предыдущего поколения. Production-like `aspire publish` и production-топология не подтверждены; граница и повторяемый gate описаны там же.

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
- Перед сдачей прогоняй `just verify-changed` — механический гейт, сужённый до компонентов, которые задевает правка, по той же карте путей, что и CI. Полный `just verify` остаётся для ручного запуска. Не больше двух прогонов гейта на сдачу, итерация идёт рецептами компонента, а красный по окружению — остановка, а не починка среды: правило — раздел «Бюджет гейта» в [agent-execution-loop.md](docs/development/agent-execution-loop.md). Состав `verify` перечислен один раз, в комментарии над рецептом в `justfile`; здесь и в других документах он не повторяется, потому что прозаические копии расходились с рецептом молча. Скилл `verify-this` решает другую задачу — проверяет отдельное утверждение экспериментом и гейт не заменяет.
- Вердикт гейта, коммита, push и кодогенерации читается по коду возврата самой команды. Проверяемую команду не ставят перед пайпом: `just verify 2>&1 | tail` возвращает код `tail`, и харнесс докладывает 0 на красном гейте. Нужно сократить вывод — `just verify > <лог> 2>&1; echo "EXIT=$?"`, и вердикт — строка `EXIT`, а не код обёртки, `tail` или харнесса.
- «Гейт красный» и «гейт не оценил изменение» — разные отчёты. Гейт, который встал до проверок над правкой (нет `just` или тулинга, инструмент разрешился в чужой бинарь среды, чужая блокировка), в отчёте так и называется, вместе с причиной. Гейт, собранный руками из части рецептов, называет, какие шаги не шли. Ни тот, ни другой зелёным не считается.
- Формат сообщения проверяет локальный хук `commit-msg` (lefthook); скрипт проверки — в `tools/git-hooks/`. В CI формат не проверяется намеренно.
- Стандарт сообщений распространяется на обычные коммиты. Заголовки PR, merge- и squash-коммиты под него не подпадают и в CI не проверяются.
- NATS и gRPC используют Protobuf. JSON в шине запрещён.
- Не считай Core NATS надёжной доставкой: JetStream, durable consumers и идемпотентность требуют согласованного решения.
- Новый язык или стек обновляет корневой `.gitignore` в том же коммите, что и первая сборка на нём; правила секций — в шапке файла. Секцию для стека, которого в репозитории нет, не заводят.
- Документация меняется вместе с кодом. При конфликте кода и документации выясни временной слой и зрелость решения, а не выбирай источник молча.
- Перед итогом содержательной сессии, обсуждения, ревью, диагностики или изменения запусти skill `proj-reflect-work`. Контур задачи — исключение: его сессия заканчивается отчётом сдачи, а рефлексия, заведение задач и правки по ревью идут новой сессией ([agent-execution-loop.md](docs/development/agent-execution-loop.md), «После контура»). Скилл предлагает только подтверждённые кандидаты для `proj-record-learning` и `proj-record-observation`, ничего не записывает и не выводит пустой блок. Простой ответ, промежуточный шаг и механическая правка без нового знания или сбоя процесса отдельной рефлексии не требуют. Запись начинается только после выбора владельца.
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

Упавший вызов роли сначала повторяют: реестр ролей в живой сессии обновляется не мгновенно, и роль, разложенная минуту назад, доступна не сразу. Падает и на повторе — проверяют раскладку тем же `sync --all -p`. Раскладка верна, а роль всё равно не находится — значит устарел реестр подагентов сессии, и диагностика на этом кончается: дальше ничего не чинится и появления ролей не ждут. В дереве от приложения причина одна: приложение копирует `.claude/` из основного клона при создании дерева, сессия читает роли из этой копии до первого действия агента, и отставший основной клон отдаёт отставший состав каждому новому дереву. Поэтому основной клон держат синхронизированным — это делают хуки `post-checkout` и `post-merge` из `lefthook.yml`, — а `sync` внутри уже открытой сессии реестр не чинит: роли приезжают уведомлением через десятки минут. Работу это не останавливает ни в одном случае: вызывающая сторона запускает подагента без роли, вставив задание из её тела в промпт, и передаёт ту же модель — отсутствие роли её не отменяет. Подмена и её причина называются в отчёте. Скиллы ссылаются на это правило, а не переписывают его.

Команды агента — источник правды `.rulesync/commands/`; `.claude/commands/` и `.opencode/commands/` генерируются из него командой `just sync-commands` и руками не правятся (`just check-commands` возвращает 1 при расхождении и входит в `verify`). Тело команды пишется в universal-синтаксисе rulesync — `$ARGUMENTS` и вставка вывода `` !`cmd` `` — а генератор переводит его в форму таргета, поэтому в теле не остаётся ни позиционных `$1`, ни путей вида `.claude/`. Таргетов два, а не пять, как у MCP: Codex CLI читает промпты только из домашнего каталога `~/.codex/prompts`, а Cursor и Copilot не раскрывают ни аргументы, ни вставки вывода команд — там тело доехало бы до модели текстом с `$ARGUMENTS` внутри. Расширить список — строка `RULESYNC_COMMAND_TARGETS` в `justfile`; сузить, когда команда нужна одному харнесу, — поле `targets` в её файле. Ключи, которых у других харнесов нет (`argument-hint`, `allowed-tools`), живут в блоке `claudecode:` frontmatter и в чужие таргеты не попадают. Свои скиллы, команды и роли подагентов носят префикс `proj-`, чтобы отличаться от внешних, персональных и плагинных: скиллы и команды делят одно пространство `/`, а роли — одно пространство `subagent_type` с плагинными вроде `codex-rescue`. Имя называет действие: скиллы `proj-record-decision`, `proj-change-contract`, `proj-create-task`, `proj-reflect-work`, `proj-record-learning`, `proj-record-observation`, `proj-write-commit`, `proj-start-task`, `proj-deliver-task`, `proj-review-change`, `proj-write-typescript`, `proj-write-grammy-bot`, `proj-write-aspire-apphost`, `proj-write-fsharp`, `proj-test-fsharp`, `proj-write-fsharp-vsa`, `proj-write-scala`, `proj-test-scala`; команды `proj-draft-commit-message`, `proj-take-task`; роли `proj-recon`, `proj-review-standards`, `proj-review-spec`, `proj-orleans-specialist`.

F#-инструментарий намеренно разделён по контекстам: `proj-write-fsharp` отвечает за язык и interop, `proj-test-fsharp` — за xUnit v3, Unquote, FsCheck, Moq и Testcontainers, `proj-write-fsharp-vsa` — за выбранные в ADR-033 функциональные vertical slices и Oxpecker boundary. Основа синтезирована из общего `managedcode/dotnet-skills:fsharp` и проверенных практик `pampadu.kasko`, а не установлена пакетом: исходные skills не знают локальных ADR и несут либо слишком общий scaffolding, либо чужие архитектурные допущения. `ECC:fsharp-testing` не установлен отдельно, потому что его полезный стек закреплён проектным standard, а FsUnit и NSubstitute не вводятся вторым способом утверждений и mocking. Пакеты `majiayu` исключены из-за Giraffe/Fable/SQLite и заранее заданной структуры приложения; Akka-specific skill из `pampadu.kasko` к Meetups не применяется, потому что ADR-024 прямо оставляет actor runtime за границей сервиса.

Orleans-инструментарий собран по той же границе, но другим способом: скилл `orleans` из `managedcode/dotnet-skills` установлен как есть — он несёт решающие таблицы «примитив — назначение — модель отказа», своего шаблона задачи и своей структуры приложения не навязывает и потому адаптируется через существующий шов. Роль `proj-orleans-specialist` рядом с ним синтезирована, а не установлена: исходный `dotnet-orleans-specialist` несёт поле `model`, права на запись и ссылки на три скилла, которых в репозитории нет, а первое прямо запрещено правилом ролей выше. Свой файл вместо чужого решает и вторую задачу — роль читает границы ADR-029 и запрет на два механизма миграций до того, как начнёт советовать. Установка скилла показала цену обёртки `just skillshare-install`: прямой `skillshare install` переписал `.skillshare/config.yaml`, оставив две записи из семнадцати, поэтому объявление правится руками, а вывод install сверяется с `git diff` до коммита.

Scala-инструментарий разделён по тому же принципу: `proj-write-scala` отвечает за язык, границу с Pekko Typed и interop со сгенерированным ScalaPB, `proj-test-scala` — за ScalaTest, ScalaCheck, Pekko TestKit и выбор уровня. Оба ссылаются на [languages/scala.md](docs/standards/languages/scala.md) и не пересказывают его. Из внешних взят один `akka-streams` ([alexandru/skills](https://github.com/alexandru/skills), MIT): он покрывает Pekko Streams явно, не несёт ни своей раскладки проекта, ни своего инструмента сборки и адаптируется существующим швом. Остальные кандидаты разведки отвергнуты по существу, а не по качеству: [j5ik2o/okite-ai](https://github.com/j5ik2o/okite-ai) предписывает `PersistenceEffector` вместо `EventSourcedBehavior`, ZIO-слой use case и read model через DynamoDB Streams — это прямое противоречие [ADR-045](docs/decisions/ADR-045-auction-scala-pekko-persistence-jdbc.md); [VirtusLab/scala-skill](https://github.com/VirtusLab/scala-skill) несёт direct-style на Ox, то есть конкурирующую акторам модель конкурентности; [majk-p/scala-skills](https://github.com/majk-p/scala-skills) сам называет себя very opinionated, навязывает `-no-indent` и typelevel-экосистему и в `scala-build-tools` предписывает свою раскладку проекта. Растиражированные по агрегаторам `scala-pro`, `moai-lang-scala` и `pcl@scala-expert` — persona-style и технической опоры не несут. Пакет Akka.NET от `aaronontheweb` к Scala не применяется.

Плагины включаются полем `enabledPlugins` в `.claude/settings.json` и действуют на весь проект. Сейчас включён `codex@openai-codex`: он приносит скиллы с префиксом `codex:` и агента `codex-rescue`, которые делегируют работу локальному Codex CLI. Плагин приходит мимо `.skillshare/` — `skillshare sync` его не раскладывает, `just check-agent-tools` его не проверяет, а без установленного Codex CLI его скиллы бесполезны.

Скилл, который агент не должен запускать сам, помечается `disable-model-invocation: true`. Так помечены `proj-record-learning` и `proj-record-observation`: агент сам находит кандидаты через `proj-reflect-work`, но владелец решает, что стоит записи. Детектор отделён от пишущих скиллов, чтобы инициатива агента не превращала гипотезу или разовый сбой в долговечный документ.

Перед изменением сервиса проверь наличие его локального `AGENTS.md`. Если стандарта ещё нет, следуй существующему коду и тестам; устойчивое повторяемое правило оформляй отдельно только после согласования.

## Agent skills

### Issue tracker

Задачи живут в Linear; GitHub несёт только код и review. См. [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).

### Domain docs

Single-context: словарь домена в ADR, решения — в `docs/decisions/`. См. [docs/agents/domain.md](docs/agents/domain.md).
