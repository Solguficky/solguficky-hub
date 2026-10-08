# Единая точка входа для команд репозитория.
#
# Репозиторий полиязычный: каждый компонент собирается своим инструментом
# (dotnet, cargo, pip, go, buf, npm). Здесь они собраны в одном месте, чтобы не
# держать в голове, в какую папку зайти и чем собрать.
#
# Требуется just: https://github.com/casey/just
#
# Новый компонент добавляет свои рецепты, свою проверку в `verify` и установку
# своего тулинга в `tools` в том же коммите, в котором появляется его сборка.

# --- Версии инструментов ---------------------------------------------------
#
# Единственное место, где закреплены версии buf и golangci-lint. Джобы
# identity и hub-bot в CI читают BUF_VERSION отсюда, а `just identity-tools`
# ставит buf локально, чтобы локальная и CI-проверка шли одними бинарниками;
# identity-lint отказывается работать на другой версии. Образ bufbuild/buf в
# apps/hub-bot/Containerfile и apps/identity/Containerfile закреплён по digest и
# потому несёт версию литералом; tools/image/check-containerfile.sh роняет
# сборку, если она разошлась с BUF_VERSION. Меняется BUF_VERSION — тег и digest
# меняются в обоих Containerfile тем же изменением. Версии
# protoc-gen-go и protoc-gen-go-grpc закреплены в apps/identity/go.mod.

BUF_VERSION := "1.54.0"
GOLANGCI_LINT_VERSION := "2.13.2"
RULESYNC_VERSION := "16.24.1"

# nats-tester: Python — рантайм инструмента, protoc — генератор закоммиченных
# классов. Джоба nats-tester в CI читает оба значения отсюда; перегенерация
# другим protoc даёт другой gencode, поэтому локальная регенерация идёт той же
# версией, что и проверка в CI.
PYTHON_VERSION := "3.12"
PROTOC_VERSION := "33.0"
# Контрольная сумма архива protoc для linux-x86_64: его скачивает и запускает
# джоба nats-tester, и версия без суммы не отличает свой бинарник от чужого.
PROTOC_SHA256 := "d99c011b799e9e412064244f0be417e5d76c9b6ace13a2ac735330fa7d57ad8f"

# Инструменты среды, которые ставит tools/env/install.sh: рецепты их не
# вызывают, скрипт читает значения тем же grep-разбором строки, что и CI, —
# поэтому закреплён и сам just. Мажор Node тот же, что у setup-node в CI;
# версии .NET, Go и JDK скрипт берёт из global.json, go.mod и .java-version.
JUST_VERSION := "1.58.0"
LEFTHOOK_VERSION := "2.1.10"
SKILLSHARE_VERSION := "0.21.10"
NODE_MAJOR := "22"

# Helm для проверки и публикации чарта прода (apphost-chart). Джобы apphost и
# chart-publish в CI ставят его tools/apphost/install-helm.sh из релиза и
# сверяют архив linux-amd64 с суммой. Aspire требует не ниже 4.2 для деплоя, а
# чарт, который проверен одной версией и опубликован другой, мог бы разойтись в
# том, что считает ошибкой lint.
HELM_VERSION := "4.3.0"
HELM_SHA256 := "86584a54def73570558f66f5111cc53dfed56689637ae32c1201205d494f54fb"

# Таргеты MCP: пять агентов, у каждого свой формат одного и того же объявления.
# Zed сюда не входит намеренно — rulesync писал бы .zed/settings.json целиком
# и затёр бы редакторские настройки репозитория.
RULESYNC_MCP_TARGETS := "claudecode,cursor,codexcli,copilot,opencode"

# Таргеты команд: только те агенты, чей формат разворачивает подстановки
# самого тела команды. У Codex CLI промпты лежат вне репозитория
# (~/.codex/prompts), а Cursor и Copilot не раскрывают ни аргументы, ни
# вставки вывода команд — там тело доехало бы до модели текстом.
RULESYNC_COMMAND_TARGETS := "claudecode,opencode"

# Список рецептов
default:
    @just --list

# --- Настройка окружения ---------------------------------------------------

# Git-хуки, один раз после клонирования
setup:
    lefthook install

# Внешние скиллы по .skillshare/config.yaml, один раз после клонирования.
# Падает, если install переписал само объявление зависимостей.
skillshare-install:
    sh tools/skillshare/install.sh

# Контракт, состояния и коды возврата — docs/development/agent-execution-loop.md;
# допустимые харнессы печатает сам скрипт. Коды 2 и 3 зелёными не считаются.
# В `verify` не входит: ответ зависит от логинов машины и ходит в сеть.
# Готовность среды к контуру: инструмент поимённо, «не объявлен» отдельно от «не авторизован»
agent-ready harness:
    sh tools/agent-env/ready.sh {{harness}}

# --- Раскладка agent tooling -----------------------------------------------
#
# Скиллы и агентов раскладывает skillshare (`skillshare sync --all -p`, см.
# AGENTS.md). MCP и команды генерирует rulesync: у него длинная командная
# строка с закреплённой версией и списком таргетов, и её незачем держать
# в голове.

# MCP-конфигурация всех агентов из .rulesync/mcp.jsonc
sync-mcp:
    npx --yes rulesync@{{RULESYNC_VERSION}} generate --targets "{{RULESYNC_MCP_TARGETS}}" --features "mcp"

# Команды всех агентов из .rulesync/commands/
sync-commands:
    npx --yes rulesync@{{RULESYNC_VERSION}} generate --targets "{{RULESYNC_COMMAND_TARGETS}}" --features "commands"

# --- Документация ----------------------------------------------------------

# Журнал наблюдений подряд: файл на запись, порядок имён — порядок дат.
# Записи разложены по файлам, потому что общий хвост одного файла конфликтовал
# на каждой паре параллельных задач (docs/development/observations.md).
observations:
    @awk 'FNR==1 && NR>1 {print ""} {print}' docs/development/observations/*.md

# --- Проверки --------------------------------------------------------------
#
# Тот же скрипт вызывает git-хук через lefthook.yml.

# Сообщение коммита из файла: just check-commit-message .git/COMMIT_EDITMSG
check-commit-message file:
    sh tools/git-hooks/check-commit-message.sh {{file}}

# Frontmatter скиллов разбирается
check-agent-tools:
    sh tools/skillshare/check-frontmatter.sh

# Конфигурация MCP каждого агента совпадает с .rulesync/mcp.jsonc
check-mcp:
    npx --yes rulesync@{{RULESYNC_VERSION}} generate --targets "{{RULESYNC_MCP_TARGETS}}" --features "mcp" --check

# Команды каждого агента совпадают с .rulesync/commands/
check-commands:
    npx --yes rulesync@{{RULESYNC_VERSION}} generate --targets "{{RULESYNC_COMMAND_TARGETS}}" --features "commands" --check

# Раскладка docs/published совпадает с адресами сайта, а ссылки разрешаются
check-published-pages:
    sh tools/community-site/check-published-pages.sh

# Номер ADR и RFC встречается один раз, у каждого файла есть строка в индексе
check-document-numbers:
    sh tools/docs/check-document-numbers.sh
    sh tools/docs/check-document-numbers-test.sh

# Применимость не-Active ADR в индексе совпадает с баннером в самом файле
check-adr-applicability:
    sh tools/docs/check-adr-applicability.sh
    sh tools/docs/check-adr-applicability-test.sh

# Относительная ссылка в docs/ ведёт в существующий файл и на существующий заголовок
check-doc-links:
    python3 tools/docs/check-doc-links.py
    sh tools/docs/check-doc-links-test.sh

# Весь модуль contracts/proto компилируется, включая схемы, которых не читает
# ни один потребитель. Потребители сужают вход фильтром paths и поимённым
# списком Protobuf, поэтому домен без потребителя иначе не проверяется нигде
# и ломается молча.
contracts-build:
    cd contracts/proto && buf build

# Стиль схем и совместимость с origin/develop: набор правил и исключения —
# в contracts/proto/buf.yaml. База — удалённая ветка, поэтому перед прогоном
# нужен `git fetch`: на отставшей от origin/develop ветке чужие мержи читаются
# как обратная правка схемы.
contracts-check:
    buf lint contracts/proto
    buf breaking contracts/proto --against '.git#branch=origin/develop,subdir=contracts/proto'

# Весь модуль contracts/proto генерируется на Go, TypeScript и Scala одной
# командой. Go и TypeScript пишутся в игнорируемый tmp/ плагинами потребителей,
# Scala генерирует своя сборка. Сборка схемы (`contracts-build`) не ловит
# отказ конкретного генератора: имя, которое один язык принимает, другой может
# отвергнуть, — это и проверяется здесь.
contracts-codegen: contracts-codegen-buf auction-proto

# Go и TypeScript отдельно: в `verify` Scala уже генерирует auction-verify, и
# второй холодный старт sbt гейту не нужен
contracts-codegen-buf:
    buf generate {{ if path_exists("apps/hub-bot/node_modules/@bufbuild/protoc-gen-es/bin/protoc-gen-es") == "true" { "--template contracts/buf.gen.codegen.yaml" } else { error("нужен protoc-gen-es: just hub-bot-tools") } }}

# Селектор verify-changed читает карту путей из джобы changes в CI и для
# правки justfile выбирает ровно зависимости verify — это и сверяет тест
check-verify-selection:
    sh tools/verify/select-recipes-test.sh

# Проверка готовности среды на заглушках: без сети и без харнесса
check-agent-ready:
    sh tools/agent-env/ready-test.sh

# Механический гейт перед сдачей: agent tooling, MCP, команды, публикуемые страницы, номера ADR/RFC, применимость ADR, ссылки в docs, селектор verify-changed, проверка готовности среды, контракты и их кодогенерация, Identity, пакет ботов — бот хаба и бот аукциона, API сайта, линтер экрана дизайн-кода, пульт провода двух ботов (его typecheck, lint и L0 — сам пульт не гейт), путь AppHost в aspire.config.json, AppHost и фикстуры проверки его чарта, Meetups, Notifications, формат F#, Auction, формат Scala, nats-tester и unit-тесты (L0). Docker и PostgreSQL гейту не нужны: интеграционные и сквозной наборы гоняют CI и `test-all`
verify: check-agent-tools check-mcp check-commands check-published-pages check-document-numbers check-adr-applicability check-doc-links check-verify-selection check-agent-ready contracts-build contracts-check contracts-codegen-buf identity-build identity-test identity-test-log-check identity-lint hub-bot-typecheck hub-bot-lint hub-bot-test hub-bot-build community-site-api-typecheck community-site-api-lint community-site-api-test screen-lint-typecheck screen-lint-lint screen-lint-test bot-console-typecheck bot-console-lint bot-console-test apphost-config-check apphost-build apphost-test apphost-chart-test meetups-contracts-check meetups-build meetups-test meetups-format-check notifications-contracts-check notifications-build notifications-test auction-verify nats-tester-check

# Тот же гейт, сужённый до компонентов, которые задевает правка: дешёвые
# проверки репозитория идут всегда, рецепты компонента — если изменённый путь
# поднимает его джобу в CI. Карта путей одна — джоба changes в ci.yml, её
# читает tools/verify/select-recipes.sh. Правка justfile или ci.yml поднимает
# все джобы, и здесь выбирается весь verify. Выбор печатается до прогона.
verify-changed:
    @recipes=$(sh tools/verify/select-recipes.sh) && echo "verify-changed: $recipes" && "{{ just_executable() }}" $recipes

# Все уровни тестов всех компонентов: L0, L1 и L2. Пропущенный тест роняет
# прогон — у .NET флагом --fail-skips, у Identity разбором `go test -json`,
# у vitest reporter'ом vitest.fail-on-skip.ts, у ScalaTest обёрткой
# `Test / executeTests` в build.sbt.
# Нужны Docker и PostgreSQL для Identity по адресу из IDENTITY_DATABASE_URL —
# умолчания нет; линт, формат и контракты сюда не входят — их держит `verify`.
# Живой контур Telegram (L3, `telegram-live-test`) не входит тоже: ему нужны
# секреты и сам Telegram. `identity-test-integration` гоняет под тегом и
# unit-тесты, поэтому `identity-test` здесь не повторяется.
test-all: identity-test-integration hub-bot-test hub-bot-test-integration community-site-api-test screen-lint-test apphost-test meetups-test meetups-test-integration notifications-test notifications-test-integration auction-test auction-test-integration contour-test contour-bot-test

# Тулинг всех компонентов, которые гоняет `verify`: один раз после клонирования или создания рабочего дерева, до первого гейта. В `verify` не входит: гейт не ходит в сеть.
tools: identity-tools hub-bot-tools community-site-api-tools screen-lint-tools bot-console-tools dotnet-tools auction-tools nats-tester-tools

# --- Локальная оркестрация -------------------------------------------------

# AppHost поднимает узлы, которыми владеет профиль. Профили — данные:
# секция Topology:Profiles в infra/apphost/AppHost/appsettings.json, там же их список.
# Срез внутри профиля: `just aspire hub -- --run-services identity`.
aspire profile="hub" *args="":
    TOPOLOGY__PROFILE={{profile}} aspire run {{args}}

# Живой smoke-test профиля: ресурсы доходят до конечного состояния, каждый
# gRPC-сервис отвечает доменным вызовом, а не только пробой здоровья. Нужны
# Docker, aspire, grpcurl и python3; в verify не входит. Флаги — в шапке скрипта:
# `just aspire-smoke --keep hub` оставляет AppHost для ручных проверок.
aspire-smoke *args="":
    sh tools/apphost/smoke.sh {{args}}

# appHost.path в aspire.config.json ведёт на существующий проект с Aspire.AppHost.Sdk.
# Статически, без Aspire CLI и сборки: путь читает только CLI, и опечатка в нём
# иначе проходит зелёной до первого `aspire run`.
apphost-config-check:
    python3 tools/apphost/check-config.py
    sh tools/apphost/check-config-test.sh

# Сборка Aspire AppHost
apphost-build:
    dotnet build infra/apphost/AppHost/AppHost.csproj --nologo

# Порог поднимается руками вместе с набором: выведенный из текущего прогона
# сравнивал бы набор сам с собой. Добавил тест — обнови число тем же изменением.
APPHOST_TEST_THRESHOLD := "103"

# Тесты графа и профилей. Уровень L0 и Docker не требуется: валидация и
# материализация модели отрабатывают до старта ресурсов, поэтому единственная
# ветка отказа, у которой нет симптома, — «узел без владеющего профиля» —
# проверяется здесь, а не живым прогоном.
#
# Runner Microsoft.Testing.Platform принимает и `--project`, так что
# `dotnet test` здесь тоже работал бы; `dotnet run` оставлен ради одной формы
# с contour-test, где `dotnet test` глотает stdout набора.
apphost-test:
    @echo "apphost-test: минимум {{APPHOST_TEST_THRESHOLD}} тестов — добавил тест, подними APPHOST_TEST_THRESHOLD в этом рецепте тем же изменением"
    dotnet run --project infra/apphost/AppHost.UnitTests/AppHost.UnitTests.csproj -- --fail-skips on --minimum-expected-tests {{APPHOST_TEST_THRESHOLD}}

# Чарт прода из графа AppHost (ADR-055): `aspire publish` собирает его из профиля
# Topology:PublishProfile, затем helm lint, helm template с фикстурой values и
# проверка правил чарта. Aspire CLI берётся через dnx той же версии, что SDK
# AppHost, — второго закрепления нет. Нужны helm и сеть, поэтому в verify не
# входит: его гоняет джоба apphost в CI на каждом PR, а в verify идут фикстуры
# самой проверки (apphost-chart-test).
apphost-chart out="infra/apphost/AppHost/bin/chart":
    #!/usr/bin/env sh
    set -eu
    version=$(sed -n 's/.*<Sdk Name="Aspire.AppHost.Sdk" Version="\([^"]*\)".*/\1/p' infra/apphost/AppHost/AppHost.csproj)
    rm -rf "{{out}}"
    dotnet dnx --yes "aspire.cli@$version" -- publish -o "{{out}}" --non-interactive
    python3 tools/apphost/check-chart.py "{{out}}" tools/apphost/chart-values.fixture.yaml

# Фикстуры проверки чарта: каждое правило ловит свой дефект. Без helm и сети.
apphost-chart-test:
    sh tools/apphost/check-chart-test.sh

# --- Identity (Go) ---------------------------------------------------------
#
# Кодогенерация — часть сборки. Рецепты собирают gRPC-сервер,
# применяют миграции PostgreSQL при запуске и проверяют разрешение личности.

# Весь инструментарий Identity закреплённых версий в $(go env GOPATH)/bin
identity-tools: identity-proto-tools identity-lint-tools

# Установить buf и Go-плагины кодогенерации закреплённых версий в $(go env GOPATH)/bin
identity-proto-tools:
    go install github.com/bufbuild/buf/cmd/buf@v{{BUF_VERSION}}
    cd apps/identity && go install tool

# Установить golangci-lint закреплённой версии в $(go env GOPATH)/bin
identity-lint-tools:
    go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v{{GOLANGCI_LINT_VERSION}}

# Сгенерировать Go-типы Identity из contracts/proto
identity-proto:
    buf generate --template apps/identity/buf.gen.yaml

# Сборка Identity
identity-build: identity-proto
    cd apps/identity && go build ./...

# Unit-тесты Identity (L0): база не нужна. Тесты с PostgreSQL лежат в
# `*_integration_test.go` под тегом сборки `integration` и в этот прогон не
# компилируются вовсе — уровень выбирается тегом, а не пропуском.
identity-test: identity-proto
    cd apps/identity && go test ./...

# Порог поднимается руками вместе с набором, как у .NET: выведенный из текущего
# прогона сравнивал бы набор сам с собой. Считаются тесты верхнего уровня под
# тегом integration — то же число, что печатает
# `go test -tags=integration -list . ./...` без базы. Опечатка в теге молча
# выключает файл, на который не ссылаются соседние файлы пакета, и недобор до
# порога — единственный её след; файл со ссылками роняет компиляцию пакета.
IDENTITY_TEST_THRESHOLD := "238"

# Все тесты Identity под тегом integration: unit-файлы тег не исключает, поэтому
# прогон полный. База обязательна: `testdb` без PostgreSQL роняет тест, а не
# пропускает его, а скрипт роняет прогон, если пропуск всё же случился или
# тестов выполнено меньше порога. Флаги уходят в `go test`: CI добавляет -race.
# Флаг, который сужает набор (-run, -skip), роняет прогон недобором: порог
# считает весь набор, и частичный прогон этим рецептом не делается.
# Адрес базы задаётся только явно: умолчание на общий порт машины отдавало
# вердикт тому, что там слушает, и посторонний PostgreSQL с другим паролем
# ронял гейт на правке, которая Identity не трогала. Без адреса рецепт
# отказывает до go test и называет это отказом среды, а не красным тестом.
identity-test-integration *flags: identity-proto
    @[ -n "${IDENTITY_DATABASE_URL:-}" ] || { echo 'identity-test-integration: отказ среды, а не красный тест — IDENTITY_DATABASE_URL не задан; задай адрес PostgreSQL, на котором тесты вправе создавать базы' >&2; exit 1; }
    @echo "identity-test-integration: база обязательна, недоступный PostgreSQL роняет прогон"
    @echo "identity-test-integration: минимум {{IDENTITY_TEST_THRESHOLD}} тестов — добавил тест, подними IDENTITY_TEST_THRESHOLD в этом рецепте тем же изменением"
    sh tools/identity/test-integration.sh {{IDENTITY_TEST_THRESHOLD}} {{flags}}

# Фикстуры разбора лога: пропуск и недобор до порога роняют прогон. Без базы и
# без Go — готовые логи `go test -json`, поэтому идут в `verify`
identity-test-log-check:
    sh tools/identity/check-test-log-test.sh

# Линт Identity закреплённой версией; чужая версия читает тот же
# .golangci.yml иначе, поэтому расхождение — ошибка, а не предупреждение
# --allow-parallel-runners: без флага golangci-lint берёт блокировку в каталоге
# временных файлов пользователя, а не рабочего дерева, и параллельный прогон в
# соседнем дереве ронял гейт кодом 3 без единой находки. Кэш флаг не портит:
# два одновременных прогона на холодном кэше дают тот же результат.
# Два прогона: с тегом integration линтер видит тесты с базой, без тега ловит
# помощник, которым пользуются только тегированные файлы, — `unused` в обычной
# сборке видит лишь второй прогон.
identity-lint: identity-proto
    @golangci-lint version --short 2>/dev/null | grep -qx '{{GOLANGCI_LINT_VERSION}}' || { echo 'нужен golangci-lint {{GOLANGCI_LINT_VERSION}}: just identity-lint-tools' >&2; exit 1; }
    cd apps/identity && golangci-lint run --allow-parallel-runners ./...
    cd apps/identity && golangci-lint run --allow-parallel-runners --build-tags=integration ./...

# Локальный запуск; адрес — IDENTITY_GRPC_ADDR, база — IDENTITY_DATABASE_URL
identity-run: identity-proto
    cd apps/identity && go run ./cmd/identity

# Production-образ в локальное хранилище движка как identity:local и те же
# проверки до публикации, что в CI: база по digest и общий поиск токена Bot API.
# Секреты самой Identity он не ищет — их выдаёт только среда запуска. Движок —
# IMAGE_ENGINE, podman по умолчанию; docker находит список контекста
# Containerfile.dockerignore сам. Публикацию в GHCR делает только CI
# (.github/workflows/image-identity.yml)
identity-image:
    #!/usr/bin/env sh
    set -eu
    engine=${IMAGE_ENGINE:-podman}
    ignore=
    case "$engine" in *podman*) ignore="--ignorefile apps/identity/Containerfile.dockerignore" ;; esac
    sh tools/image/check-containerfile.sh apps/identity/Containerfile
    "$engine" build -f apps/identity/Containerfile $ignore -t identity:local .
    sh tools/image/check-no-token.sh identity:local

# --- Hub Bot (TypeScript) --------------------------------------
#
# Один пакет на два бота (ADR-064, п. 18): бот хаба и бот аукциона — две
# поверхности одного кода, процесс выбирает свою переменной BOT_SURFACE.
# Рецепты hub-bot-* поэтому проверяют обе. Кодогенерация — часть сборки.

# Пакет живого контура ставится здесь же: его код типизирует, линтует и
# гоняет на L0 конфиг бота, а mtcute боту не принадлежит (ADR-046). Скрипты
# установки не нужны: сессия в памяти, нативный better-sqlite3 не строится
hub-bot-tools:
    cd apps/hub-bot && npm ci
    cd tests/telegram-live && npm ci --ignore-scripts

hub-bot-proto:
    buf generate {{ if path_exists("apps/hub-bot/node_modules/@bufbuild/protoc-gen-es/bin/protoc-gen-es") == "true" { "--template apps/hub-bot/buf.gen.yaml" } else { error("нужен protoc-gen-es: just hub-bot-tools") } }}

hub-bot-build: hub-bot-proto
    cd apps/hub-bot && npm run build

hub-bot-typecheck: hub-bot-proto
    cd apps/hub-bot && npm run typecheck

# Unit и component tests (L0): Docker не нужен, наборы `*.integration.test.ts`
# исключены в vitest.config.ts
hub-bot-test: hub-bot-proto
    cd apps/hub-bot && npm test

# Наборы с Testcontainers (L1): нужен Docker. В `verify` не входит — его гоняют
# CI и `test-all`
hub-bot-test-integration: hub-bot-proto
    cd apps/hub-bot && npm run test:integration

hub-bot-lint: hub-bot-proto
    cd apps/hub-bot && npm run lint

# Обычный путь — профили AppHost `hub` и `auction-bot`: они раздают переменные
# сами. Запуск вне AppHost: BOT_SURFACE=hub или auction, BOT_TOKEN,
# BOT_SERVICE_TOKEN, BOT_COMMUNITY_TIME_ZONE, адреса сервисов поверхности и NATS
# по BOT_NATS_URL с durable и bucket журнала
hub-bot-run: hub-bot-build
    cd apps/hub-bot && npm start

# Production-образ в локальное хранилище движка как hub-bot:local и те же
# проверки, что в CI: база по digest, нет токена Bot API, нет пакетов разработки.
# Движок — IMAGE_ENGINE, podman по умолчанию; docker находит список контекста
# Containerfile.dockerignore сам. Публикацию в GHCR делает только CI
# (.github/workflows/image-hub-bot.yml)
hub-bot-image:
    #!/usr/bin/env sh
    set -eu
    engine=${IMAGE_ENGINE:-podman}
    ignore=
    case "$engine" in *podman*) ignore="--ignorefile apps/hub-bot/Containerfile.dockerignore" ;; esac
    sh tools/image/check-containerfile.sh apps/hub-bot/Containerfile
    "$engine" build -f apps/hub-bot/Containerfile $ignore -t hub-bot:local .
    sh tools/image/check-no-token.sh hub-bot:local
    sh tools/image/check-node-runtime.sh hub-bot:local apps/hub-bot/package-lock.json /app

# Негативный путь проверок образа: база по тегу, токен в слое и токен в
# аргументе сборки роняют проверки их кодами — на финальной базе Node-образа.
# Нужен движок, как у hub-bot-image
image-checks-test:
    sh tools/image/check-test.sh apps/hub-bot/Containerfile

# Живой контур (L3, ADR-046): `/start` от синтетического аккаунта тестового DC
# до ответа бота через настоящий Telegram. Бота поднимает владелец —
# `aspire run -- --profile hub --telegram-environment test`; рецепт его не
# запускает, чтобы не завести второй поллер. Секреты — `TelegramLive:*` в
# user-secrets AppHost. Недоступный Telegram, флуд-лимит и отсутствующий секрет
# роняют прогон с названной причиной. В verify, test-all и CI не входит ни при
# какой стабильности: источник отказа внешний.
#
# Живой `/start` и кадры ошибок через тестовую среду Telegram; в verify и test-all не входит
telegram-live-test: hub-bot-proto
    cd apps/hub-bot && npm run test:live

# Живой пульт (L3, ADR-046): синтетический аккаунт тестовой среды ведёт
# разговор с ботом по шагу — пишет, жмёт inline-кнопки по подписи и читает
# экраны — через настоящий Telegram. Бота поднимает владелец, как для
# telegram-live-test. Команда — строка в теле POST на 127.0.0.1:7358, ответ —
# JSON; клиент `tests/telegram-live/console/send.sh`, язык команд —
# `commands.ts` рядом. Живёт до `quit` или Ctrl+C, журнал обмена — в
# .work/bot-console-live/. Не гейт: вне verify, test-all и CI.
#
# Живой пульт тестовой среды Telegram для ручного и агентского прохода; вне verify, test-all и CI
telegram-live-console: hub-bot-proto
    cd apps/hub-bot && npm run console:live

# Строка сессии синтетического аккаунта `99966XYYYY` в user-secrets AppHost; код
# подтверждения выводится из номера. Аккаунт в тестовой среде заводит владелец.
#
# Войти синтетическим аккаунтом и записать строку сессии в user-secrets
telegram-live-login phone:
    cd tests/telegram-live && node --experimental-strip-types session.ts login {{phone}}

# --- Community site API (TypeScript) ---------------------------------------
#
# Функция `/api/notes` держит заметки страницы «Аукцион 2026»: документ в
# Netlify Blobs, ревизии и откаты. Кодогенерации у компонента нет, поэтому
# рецепты прямые. Сборки тоже нет: бандлит функцию Netlify CLI при деплое,
# а гейт держат typecheck, линт и тесты доменной логики.

community-site-api-tools:
    cd apps/community-site-api && npm ci

community-site-api-typecheck:
    cd apps/community-site-api && npm run typecheck

community-site-api-test:
    cd apps/community-site-api && npm test

community-site-api-lint:
    cd apps/community-site-api && npm run lint

# Браузер ставится один раз:
# cd apps/community-site-api && npx playwright install chromium
# E2E страницы в настоящем браузере; в `verify` не входит — гейт обязан работать без Chromium
community-site-api-e2e:
    cd apps/community-site-api && npm run e2e

# Сервер поднимает настоящий обработчик поверх хранилища в памяти; E2E запускает его сам.
# Статика docs/published плюс /api/notes — для ручного прогона страницы
community-site-serve:
    cd apps/community-site-api && node e2e/server.mjs

# --- Screen lint (TypeScript) ----------------------------------------------
#
# Линтер экрана дизайн-кода и форма каталога экранов, общие для двух ботов и
# пакета аукционного интерфейса. Сборки нет: тестовый код потребителей берёт
# исходники относительным путём, и проверяют их и эти рецепты, и наборы
# потребителей. `npm ci` ставит только инструменты разработки пакета.

screen-lint-tools:
    cd shared/typescript/screen-lint && npm ci

screen-lint-typecheck:
    cd shared/typescript/screen-lint && npm run typecheck

screen-lint-test:
    cd shared/typescript/screen-lint && npm test

screen-lint-lint:
    cd shared/typescript/screen-lint && npm run lint

# --- Meetups (F# / .NET) ---------------------------------------------------
#
# Кодогенерация C# — часть `dotnet build` контрактного проекта.
# Сервис — gRPC-сервер на Kestrel в h2c; готовность отдаётся по grpc.health.v1,
# HTTP-эндпоинтов health у него нет.

# Сборка контрактов, сервиса и обоих тестовых проектов
meetups-build:
    dotnet build apps/meetups/Meetups.sln --nologo

# Пороги числа тестов по уровням, в сумме 709. Поднимаются вручную вместе с
# набором — добавил тест, обнови число своего уровня здесь тем же изменением.
# Порог держит исчезновение тестов из набора; частичный пропуск ловит
# --fail-skips, а не он: --minimum-expected-tests считает пропущенный тест
# выполненным.
MEETUPS_UNIT_TEST_THRESHOLD := "570"
MEETUPS_INTEGRATION_TEST_THRESHOLD := "139"

# Unit-тесты (L0): Docker и PostgreSQL не нужны. Уровень выбирается проектом,
# а не пропуском: проекты решения названы по уровню.
# Runner — Microsoft.Testing.Platform (опция `test` в global.json); он принимает
# и `--solution`, и `--project`.
meetups-test:
    @echo "meetups-test: пропуск теста роняет прогон, разрешённых пропусков нет"
    @echo "meetups-test: минимум {{MEETUPS_UNIT_TEST_THRESHOLD}} тестов — добавил тест, подними MEETUPS_UNIT_TEST_THRESHOLD в этом рецепте тем же изменением"
    dotnet test --project apps/meetups/Meetups.UnitTests/Meetups.UnitTests.fsproj --fail-skips on --minimum-expected-tests {{MEETUPS_UNIT_TEST_THRESHOLD}}

# Интеграционный прогон (L1): настоящий Kestrel на свободном порту, настоящий
# gRPC-канал и миграции на PostgreSQL из Testcontainers. Нужен Docker. Пропуск
# теста роняет прогон: неполная среда видна отказом, а не зелёным результатом.
# В `verify` не входит — его гоняют CI и `test-all`.
meetups-test-integration:
    @echo "meetups-test-integration: пропуск теста роняет прогон, разрешённых пропусков нет"
    @echo "meetups-test-integration: минимум {{MEETUPS_INTEGRATION_TEST_THRESHOLD}} тестов — добавил тест, подними MEETUPS_INTEGRATION_TEST_THRESHOLD в этом рецепте тем же изменением"
    dotnet test --project apps/meetups/Meetups.IntegrationTests/Meetups.IntegrationTests.fsproj --fail-skips on --minimum-expected-tests {{MEETUPS_INTEGRATION_TEST_THRESHOLD}}

# Контрактный проект остаётся generated-only: это условие обратимости из ADR-025
meetups-contracts-check:
    sh tools/meetups/check-contracts-generated.sh

# Локальный запуск вне Aspire; адрес — ASPNETCORE_URLS, база — MEETUPS_DATABASE_URL
meetups-run:
    dotnet run --project apps/meetups/Meetups

# Форматирование F# по корневому .editorconfig (секция Fantomas)
meetups-format: dotnet-tools
    dotnet fantomas apps/meetups

# Гейт форматирования F#: печатает файлы, которые Fantomas переписал бы
meetups-format-check: dotnet-tools
    dotnet fantomas --check apps/meetups

# Production-образ в архив apps/meetups/Meetups/bin/container/, без реестра и
# демона: `docker load` поднимает его как meetups:local. Публикацию в GHCR делает только CI
# (.github/workflows/image-meetups.yml); база по тегу роняет сборку с SOLG0001
meetups-image:
    dotnet publish apps/meetups/Meetups -t:PublishContainer --nologo -p:ContainerImageTags=local -p:ContainerArchiveOutputPath=bin/container/meetups.tar.gz

# --- Notifications (C# / Orleans / .NET) -----------------------------------
#
# Кодогенерация C# — часть `dotnet build` контрактного проекта.
# Сервис — силос Orleans, co-hosted с gRPC-сервером на Kestrel в h2c; готовность
# отдаётся по grpc.health.v1, HTTP-эндпоинтов health у него нет. Реализаций
# gRPC пока нет: command plane — PER-71.

# Сборка контрактов, сервиса и обоих тестовых проектов
notifications-build:
    dotnet build apps/notifications/Notifications.sln --nologo

# Пороги числа тестов Notifications по уровням, в сумме 531. Поднимаются вручную
# вместе с набором — добавил тест, обнови число своего уровня здесь тем же
# изменением. Порог держит исчезновение тестов из набора; частичный пропуск
# ловит --fail-skips.
NOTIFICATIONS_UNIT_TEST_THRESHOLD := "440"
NOTIFICATIONS_INTEGRATION_TEST_THRESHOLD := "177"

# Unit-тесты (L0): Docker не нужен.
# Runner — Microsoft.Testing.Platform (опция `test` в global.json); он принимает
# и `--solution`, и `--project`.
notifications-test:
    @echo "notifications-test: пропуск теста роняет прогон, разрешённых пропусков нет"
    @echo "notifications-test: минимум {{NOTIFICATIONS_UNIT_TEST_THRESHOLD}} тестов — добавил тест, подними NOTIFICATIONS_UNIT_TEST_THRESHOLD в этом рецепте тем же изменением"
    dotnet test --project apps/notifications/Notifications.UnitTests/Notifications.UnitTests.csproj --fail-skips on --minimum-expected-tests {{NOTIFICATIONS_UNIT_TEST_THRESHOLD}}

# Интеграционный прогон (L1): PostgreSQL через Testcontainers, нужен Docker.
# Пропуск теста роняет прогон и локально, и в CI: разрешённых пропусков внутри
# уровня нет, а зелёный прогон на пропущенных тестах выглядит как проверка.
# В `verify` не входит — его гоняют CI и `test-all`.
notifications-test-integration:
    @echo "notifications-test-integration: пропуск теста роняет прогон, разрешённых пропусков нет"
    @echo "notifications-test-integration: минимум {{NOTIFICATIONS_INTEGRATION_TEST_THRESHOLD}} тестов — добавил тест, подними NOTIFICATIONS_INTEGRATION_TEST_THRESHOLD в этом рецепте тем же изменением"
    dotnet test --project apps/notifications/Notifications.IntegrationTests/Notifications.IntegrationTests.csproj --fail-skips on --minimum-expected-tests {{NOTIFICATIONS_INTEGRATION_TEST_THRESHOLD}}

# Контрактный проект остаётся generated-only: то же условие обратимости, что у Meetups
notifications-contracts-check:
    sh tools/notifications/check-contracts-generated.sh

# Локальный запуск вне Aspire; адрес — ASPNETCORE_URLS, база — NOTIFICATIONS_DATABASE_URL
notifications-run:
    dotnet run --project apps/notifications/Notifications

# Production-образ в архив apps/notifications/Notifications/bin/container/, без
# реестра и демона: `docker load` поднимает его как notifications:local. Публикацию
# в GHCR делает только CI (.github/workflows/image-notifications.yml); база по тегу
# роняет сборку с SOLG0001
notifications-image:
    dotnet publish apps/notifications/Notifications -t:PublishContainer --nologo -p:ContainerImageTags=local -p:ContainerArchiveOutputPath=bin/container/notifications.tar.gz

# --- Auction (Scala / Pekko) -----------------------------------------------
#
# Кодогенерация Scala — часть `sbt compile`: sbt-protoc вызывает ScalaPB на
# схемах contracts/proto, как Grpc.Tools вызывает protoc внутри dotnet build
# у Meetups. Buf в этой сборке не участвует — обоснование в ADR-048.
# Версии Scala и библиотек закреплены в apps/auction/build.sbt.
# Сервис — HTTP-граница на Pekko HTTP, одноузловой кластер и журнал Pekko
# Persistence JDBC; торговой логики в нём пока нет.

# Одного `update` мало: бинарник protoc тянет protocbridge на первой генерации,
# а scalafmt-core подтягивается при первой проверке формата. Без обоих шагов
# `just verify` в свежем дереве без сети падает, хотя `tools` уже отработал.
#
# Зависимости и бинарники сборки. Ходит в сеть, поэтому живёт в `tools`, а не в `verify`
auction-tools:
    cd apps/auction && sbt -batch "update; Compile/protocGenerate; scalafmtCheckAll"

# Кодогенерация Protobuf отдельным шагом; `auction-build` выполняет её сам
auction-proto:
    cd apps/auction && sbt -batch Compile/protocGenerate

# Сборка сервиса и тестов; кодогенерация входит в compile
auction-build:
    cd apps/auction && sbt -batch Test/compile

# Сьюты `*IntegrationSpec` отбирает переменная в build.sbt, а не тег ScalaTest:
# тег исключает тесты, но не конструктор сьюта, где может стартовать контейнер.
# Без Docker сьют падает, а не пропускается.
#
# Прогон ScalaTest L0, включая property-проверку каркаса лога; Docker не нужен
auction-test:
    cd apps/auction && sbt -batch test

# L1: схема, журнал, шардинг и готовность на PostgreSQL в Testcontainers; нужен Docker
auction-test-integration:
    cd apps/auction && AUCTION_INTEGRATION_TESTS=1 sbt -batch test

# scalafmtCheckAll не видит саму сборку, поэтому .sbt-файлы проверяет
# отдельная задача — иначе build.sbt остаётся единственным неформатируемым
# файлом компонента.
#
# Гейт форматирования Scala по apps/auction/.scalafmt.conf
auction-lint:
    cd apps/auction && sbt -batch "scalafmtCheckAll; scalafmtSbtCheck"

# Форматирование Scala вместе с файлами сборки
auction-format:
    cd apps/auction && sbt -batch "scalafmtAll; scalafmtSbt"

# Останавливать через сам sbt: forked JVM переживает убитого родителя и
# оставляет блокировку сервера sbt.
#
# Локальный запуск вне Aspire; адреса — AUCTION_HTTP_* и AUCTION_GRPC_*, токены
# вызывающих — AUCTION_CALLER_TOKEN_HUB_BOT и AUCTION_CALLER_TOKEN_AUCTION_BOT
auction-run:
    cd apps/auction && sbt -batch run

# Узел `auction-build` AppHost зовёт этот рецепт, а не sbt напрямую: на Windows
# `sbt` — это sbt.bat, и cmd.exe разбирает кавычки и скобки выражения `set` как
# свой синтаксис. Задача объявляется на одну сессию, build.sbt её не держит:
# classpath нужен только графу, который запускает сервис голой JVM вместо
# `sbt run` — форкнутая JVM переживает остановленный sbt.
#
# Компиляция и runtime classpath в apps/auction/target/aspire-classpath
auction-classpath:
    cd apps/auction && sbt -batch 'set TaskKey[Unit]("aspireClasspath") := IO.write(target.value / "aspire-classpath", (Runtime / fullClasspath).value.files.mkString(java.io.File.pathSeparator))' aspireClasspath

# Production-образ в локальное хранилище движка как auction:local и те же
# проверки до публикации, что в CI: база по digest и общий поиск токена Bot API.
# Сборка идёт внутри образа: JDK и sbt на машине не нужны, нужен движок —
# IMAGE_ENGINE, podman по умолчанию; docker находит список контекста
# Containerfile.dockerignore сам. Публикацию в GHCR делает только CI
# (.github/workflows/image-auction.yml)
auction-image:
    #!/usr/bin/env sh
    set -eu
    engine=${IMAGE_ENGINE:-podman}
    ignore=
    case "$engine" in *podman*) ignore="--ignorefile apps/auction/Containerfile.dockerignore" ;; esac
    sh tools/image/check-containerfile.sh apps/auction/Containerfile
    "$engine" build -f apps/auction/Containerfile $ignore -t auction:local .
    sh tools/image/check-no-token.sh auction:local

# В `verify` входит именно этот рецепт, а не три отдельных: каждый вызов sbt
# поднимает свою JVM, и три холодных старта добавили бы к гейту около двух
# минут на пустом месте.
#
# Формат, сборка и тесты Scala одной сессией sbt
auction-verify:
    cd apps/auction && sbt -batch "scalafmtCheckAll; scalafmtSbtCheck; Test/compile; test"

# --- nats-tester (Python) --------------------------------------------------
#
# Инструмент ручной проверки шины. Классы сообщений коммитятся — установка без
# protoc и есть смысл ручного инструмента, — поэтому протухшие классы ловит не
# сборка, а проверка: состав генерации сверяется со схемами, а перегенерация в
# CI идёт закреплённым protoc. Схемы для генерации — NATS_PROTO_FILES в
# nats_tester/proto_sources.py, версии — PYTHON_VERSION и PROTOC_VERSION выше.

# Зависимости инструмента; ходит в сеть, поэтому в `tools`, а не в `verify`
nats-tester-tools:
    cd tools/nats-tester && python -m pip install -e .

# Перегенерация закоммиченных классов; нужен protoc закреплённой версии
nats-tester-proto:
    cd tools/nats-tester && python generate_proto.py

# Классы импортируются, состав генерации совпадает со схемами, реестр не врёт
nats-tester-check:
    cd tools/nats-tester && python -m nats_tester.gate

# --- Инструменты -----------------------------------------------------------

# Локальные .NET-инструменты закреплённых версий из .config/dotnet-tools.json
dotnet-tools:
    dotnet tool restore

# Исследовательский зонд Rich Messages; не входит в verify
telegram-rich-probe:
    node tools/telegram-rich-probe/probe.mjs

# Сквозной контур (L2): Identity и Meetups вместе на топологии, поднятой
# AppHost через Aspire.Hosting.Testing. В `verify` намеренно не входит —
# стандарт держит в механическом гейте только L0. Входит в `test-all`.
#
# Нужны Docker, `go` и `buf` в PATH: узел Identity в графе сначала генерирует
# Go-код и собирает бинарник. Недоступность среды даёт отказ с именем
# инструмента, а не пропуск; порог --minimum-expected-tests ловит и случай,
# когда набор не обнаружил ни одного теста, а --fail-skips — пропуск внутри
# набора, как у остальных рецептов `test-all`.
#
# Порог задаётся руками и поднимается вместе с набором: выведенный из
# текущего прогона сравнивал бы набор сам с собой. Он ловит и случай, когда
# тестов не обнаружено вовсе, — прогон с порогом 2 на одном тесте даёт код 9.
#
# `dotnet run`, а не `dotnet test --project`, ради вывода. Оба варианта гоняют
# тест и оба соблюдают порог, но `dotnet test` глотает stdout: измерено на
# зелёном прогоне — ни баннера с seed и адресами, ни одной строки
# `AppHost.Resources.*`, и `--output Detailed` этого не меняет. Под `dotnet run`
# в том же прогоне баннер на месте и строк ресурсов 146. Именно они и есть
# логи Identity, Meetups и PostgreSQL: своего сбора у набора нет, потому что
# ResourceLoggerService под тестовым builder'ом отдаёт ноль строк.
#
# Дымовой прогон сквозного контура; в verify не входит
contour-test:
    dotnet run --project tests/contour/Contour.E2ETests/Contour.E2ETests.csproj -- --fail-skips on --minimum-expected-tests 1

# Адреса и токен maintainer'а уходят в окружение дочерней команды и, если
# указан путь, в dotenv-файл; унаследованные от Aspire переменные OTEL_*
# дочерняя команда не получает. Этим входом пользуется набор провода бота,
# который средой не владеет.
#
#   just contour-up                             держит среду до Ctrl+C
#   just contour-up '--env-file .contour.env'
#   just contour-up '-- npm test'
#
# Поднять контур и отдать IDENTITY_GRPC_URL, MEETUPS_GRPC_URL, IDENTITY_MAINTAINER_TOKEN и HUB_BOT_SERVICE_TOKEN наружу
contour-up *args="":
    dotnet run --project tests/contour/Contour.Host/Contour.Host.csproj -- {{args}}

# Провод бота (L2, вход B RFC-012): `bot.handleUpdate` с настоящими клиентами
# Identity и Meetups на топологии, которую поднимает Contour.Host. Сценарии
# лежат в tests/contour/bot-wire, kit и зависимости — у бота. Нужно то же, что
# `contour-test`, и Node. Пустой набор, забытый `.only` и пропущенный тест
# роняют прогон (vitest.contour.config.ts); порога числа тестов у vitest нет.
#
# Провод бота против настоящих Identity и Meetups; в verify не входит
contour-bot-test: hub-bot-proto
    dotnet run --project tests/contour/Contour.Host/Contour.Host.csproj -- -- npm --prefix apps/hub-bot run test:contour

# Исследующий прогон RFC-012 (роль 3, PER-273): случайные последовательности
# действий человека поверх провода бота, оракулы — каркас записи логов. Не
# гейт и не входит ни в verify, ни в test-all, ни в CI: недетерминированный
# источник падений обесценил бы гейт. Кандидаты печатаются и пишутся в
# .work/explore/, прогон падает только на отказе среды. Параметры окружением:
# EXPLORE_SEED, EXPLORE_RUNS, EXPLORE_STEPS, EXPLORE_REPLAY=<файл>#<i>.
#
# Исследующий прогон провода бота; не гейт, вне verify, test-all и CI
contour-bot-explore: hub-bot-proto
    dotnet run --project tests/contour/Contour.Host/Contour.Host.csproj -- -- npm --prefix apps/hub-bot run explore:contour

# Пульт провода двух ботов (L2): разговор с ботом хаба и ботом аукциона по
# шагу против настоящих Identity, Meetups и Auction — завести людей с ролями,
# писать, жать кнопки по подписи и читать экраны. Контур поднимается с Auction
# (`Contour.Host --with-auction`), поэтому нужны ещё JDK из
# apps/auction/.java-version и sbt. Команда — строка в теле POST на
# 127.0.0.1:7357, ответ — JSON; клиент `tests/contour/bot-wire/console/send.sh`,
# язык команд — `commands.ts` рядом. Живёт до `quit` или Ctrl+C, журнал обмена
# — в .work/bot-console/. Telegram не участвует. Не гейт: вне verify, test-all
# и CI.
#
# Пульт провода двух ботов для ручного и агентского прохода; вне verify, test-all и CI
contour-bot-console: hub-bot-proto
    dotnet run --project tests/contour/Contour.Host/Contour.Host.csproj -- --with-auction -- npm --prefix tests/contour/bot-wire/console run console

# --- Bot console (TypeScript) -----------------------------------------------
#
# Пульт провода `tests/contour/bot-wire/console` — своя единица: он импортирует
# test kit обеих поверхностей пакета ботов относительным путём. Зависимости у
# пульта свои (vitest, typescript, biome), код ботов он берёт из дерева пакета,
# поэтому его typecheck требует установленного и сгенерированного пакета. L0 —
# разбор языка команд и прокси задержки с обрывом; сам пульт запускает
# contour-bot-console.

bot-console-tools:
    cd tests/contour/bot-wire/console && npm ci

bot-console-typecheck: hub-bot-typecheck
    cd tests/contour/bot-wire/console && npm run typecheck

# L0 импортирует kit обеих поверхностей, а тот — сгенерированный код пакета
bot-console-test: hub-bot-proto
    cd tests/contour/bot-wire/console && npm test

bot-console-lint:
    cd tests/contour/bot-wire/console && npm run lint

# Контрактный проект контура остаётся generated-only (ADR-025)
contour-contracts-check:
    sh tools/contour/check-contracts-generated.sh
