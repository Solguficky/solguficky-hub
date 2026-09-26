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
# identity и telegram-bot в CI читают BUF_VERSION отсюда, а `just identity-tools`
# ставит buf локально, чтобы локальная и CI-проверка шли одними бинарниками;
# identity-lint отказывается работать на другой версии. Версии
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
    buf generate {{ if path_exists("apps/telegram-bot/node_modules/@bufbuild/protoc-gen-es/bin/protoc-gen-es") == "true" { "--template contracts/buf.gen.codegen.yaml" } else { error("нужен protoc-gen-es: just telegram-bot-tools") } }}

# Селектор verify-changed читает карту путей из джобы changes в CI и для
# правки justfile выбирает ровно зависимости verify — это и сверяет тест
check-verify-selection:
    sh tools/verify/select-recipes-test.sh

# Механический гейт перед сдачей: agent tooling, MCP, команды, публикуемые страницы, номера ADR/RFC, применимость ADR, ссылки в docs, селектор verify-changed, контракты и их кодогенерация, Identity, Telegram Bot, API сайта, AppHost, Meetups, Notifications, формат F#, Auction, формат Scala, nats-tester и unit-тесты (L0). Docker и PostgreSQL гейту не нужны: интеграционные и сквозной наборы гоняют CI и `test-all`
verify: check-agent-tools check-mcp check-commands check-published-pages check-document-numbers check-adr-applicability check-doc-links check-verify-selection contracts-build contracts-check contracts-codegen-buf identity-build identity-test identity-lint telegram-bot-typecheck telegram-bot-lint telegram-bot-test telegram-bot-build community-site-api-typecheck community-site-api-lint community-site-api-test apphost-build apphost-test meetups-contracts-check meetups-build meetups-test meetups-format-check notifications-contracts-check notifications-build notifications-test auction-verify nats-tester-check

# Тот же гейт, сужённый до компонентов, которые задевает правка: дешёвые
# проверки репозитория идут всегда, рецепты компонента — если изменённый путь
# поднимает его джобу в CI. Карта путей одна — джоба changes в ci.yml, её
# читает tools/verify/select-recipes.sh. Правка justfile или ci.yml поднимает
# все джобы, и здесь выбирается весь verify. Выбор печатается до прогона.
verify-changed:
    @recipes=$(sh tools/verify/select-recipes.sh) && echo "verify-changed: $recipes" && "{{ just_executable() }}" $recipes

# Все уровни тестов всех компонентов: L0, L1 и L2. Пропущенный тест роняет
# прогон — у .NET флагом --fail-skips, у Identity скриптом поверх `go test -v`.
# Нужны Docker и PostgreSQL для Identity по адресу из IDENTITY_DATABASE_URL —
# умолчания нет; линт, формат и контракты сюда не входят — их держит `verify`.
# `identity-test-integration` гоняет под тегом и unit-тесты, поэтому
# `identity-test` здесь не повторяется.
test-all: identity-test-integration telegram-bot-test telegram-bot-test-integration community-site-api-test apphost-test meetups-test meetups-test-integration notifications-test notifications-test-integration auction-test contour-test

# Тулинг всех компонентов, которые гоняет `verify`: один раз после клонирования или создания рабочего дерева, до первого гейта. В `verify` не входит: гейт не ходит в сеть.
tools: identity-tools telegram-bot-tools community-site-api-tools dotnet-tools auction-tools nats-tester-tools

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

# Сборка Aspire AppHost
apphost-build:
    dotnet build infra/apphost/AppHost/AppHost.csproj --nologo

# Порог поднимается руками вместе с набором: выведенный из текущего прогона
# сравнивал бы набор сам с собой. Добавил тест — обнови число тем же изменением.
APPHOST_TEST_THRESHOLD := "34"

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

# Все тесты Identity под тегом integration: unit-файлы тег не исключает, поэтому
# прогон полный. База обязательна: `testdb` без PostgreSQL роняет тест, а не
# пропускает его, а скрипт роняет прогон, если пропуск всё же случился.
# Адрес базы задаётся только явно: умолчание на общий порт машины отдавало
# вердикт тому, что там слушает, и посторонний PostgreSQL с другим паролем
# ронял гейт на правке, которая Identity не трогала. Без адреса рецепт
# отказывает до go test и называет это отказом среды, а не красным тестом.
identity-test-integration: identity-proto
    @[ -n "${IDENTITY_DATABASE_URL:-}" ] || { echo 'identity-test-integration: отказ среды, а не красный тест — IDENTITY_DATABASE_URL не задан; задай адрес PostgreSQL, на котором тесты вправе создавать базы' >&2; exit 1; }
    @echo "identity-test-integration: база обязательна, недоступный PostgreSQL роняет прогон"
    sh tools/identity/test-integration.sh

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

# --- Telegram Bot (TypeScript) --------------------------------------
#
# Кодогенерация — часть сборки. Рецепты собирают grammY-скелет,
# клиент Identity и проверяют границу юзкейса без Telegram.

telegram-bot-tools:
    cd apps/telegram-bot && npm ci

telegram-bot-proto:
    buf generate {{ if path_exists("apps/telegram-bot/node_modules/@bufbuild/protoc-gen-es/bin/protoc-gen-es") == "true" { "--template apps/telegram-bot/buf.gen.yaml" } else { error("нужен protoc-gen-es: just telegram-bot-tools") } }}

telegram-bot-build: telegram-bot-proto
    cd apps/telegram-bot && npm run build

telegram-bot-typecheck: telegram-bot-proto
    cd apps/telegram-bot && npm run typecheck

# Unit и component tests (L0): Docker не нужен, наборы `*.integration.test.ts`
# исключены в vitest.config.ts
telegram-bot-test: telegram-bot-proto
    cd apps/telegram-bot && npm test

# Наборы с Testcontainers (L1): нужен Docker. В `verify` не входит — его гоняют
# CI и `test-all`
telegram-bot-test-integration: telegram-bot-proto
    cd apps/telegram-bot && npm run test:integration

telegram-bot-lint: telegram-bot-proto
    cd apps/telegram-bot && npm run lint

telegram-bot-run: telegram-bot-build
    cd apps/telegram-bot && npm start

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

# --- Meetups (F# / .NET) ---------------------------------------------------
#
# Кодогенерация C# — часть `dotnet build` контрактного проекта.
# Сервис — gRPC-сервер на Kestrel в h2c; готовность отдаётся по grpc.health.v1,
# HTTP-эндпоинтов health у него нет.

# Сборка контрактов, сервиса и обоих тестовых проектов
meetups-build:
    dotnet build apps/meetups/Meetups.sln --nologo

# Пороги числа тестов по уровням, в сумме 643. Поднимаются вручную вместе с
# набором — добавил тест, обнови число своего уровня здесь тем же изменением.
# Порог держит исчезновение тестов из набора; частичный пропуск ловит
# --fail-skips, а не он: --minimum-expected-tests считает пропущенный тест
# выполненным.
MEETUPS_UNIT_TEST_THRESHOLD := "524"
MEETUPS_INTEGRATION_TEST_THRESHOLD := "131"

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

# --- Notifications (C# / Orleans / .NET) -----------------------------------
#
# Кодогенерация C# — часть `dotnet build` контрактного проекта.
# Сервис — силос Orleans, co-hosted с gRPC-сервером на Kestrel в h2c; готовность
# отдаётся по grpc.health.v1, HTTP-эндпоинтов health у него нет. Реализаций
# gRPC пока нет: command plane — PER-71.

# Сборка контрактов, сервиса и обоих тестовых проектов
notifications-build:
    dotnet build apps/notifications/Notifications.sln --nologo

# Пороги числа тестов Notifications по уровням, в сумме 235. Поднимаются вручную
# вместе с набором — добавил тест, обнови число своего уровня здесь тем же
# изменением. Порог держит исчезновение тестов из набора; частичный пропуск
# ловит --fail-skips.
NOTIFICATIONS_UNIT_TEST_THRESHOLD := "198"
NOTIFICATIONS_INTEGRATION_TEST_THRESHOLD := "87"

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

# --- Auction (Scala / Pekko) -----------------------------------------------
#
# Кодогенерация Scala — часть `sbt compile`: sbt-protoc вызывает ScalaPB на
# схемах contracts/proto, как Grpc.Tools вызывает protoc внутри dotnet build
# у Meetups. Buf в этой сборке не участвует — обоснование в ADR-048.
# Версии Scala и библиотек закреплены в apps/auction/build.sbt.
# Сервис — HTTP-граница на Pekko HTTP; торговой логики в нём пока нет.

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

# Прогон ScalaTest, включая property-проверку каркаса лога
auction-test:
    cd apps/auction && sbt -batch test

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
# Локальный запуск вне Aspire; адрес — AUCTION_HTTP_HOST и AUCTION_HTTP_PORT
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

# Адреса уходят в окружение дочерней команды и, если указан путь, в
# dotenv-файл. Этим входом пользуется набор провода бота (PER-271), который
# средой не владеет.
#
#   just contour-up                             держит среду до Ctrl+C
#   just contour-up '--env-file .contour.env'
#   just contour-up '-- npm test'
#
# Поднять контур и отдать IDENTITY_GRPC_URL и MEETUPS_GRPC_URL наружу
contour-up *args="":
    dotnet run --project tests/contour/Contour.Host/Contour.Host.csproj -- {{args}}

# Контрактный проект контура остаётся generated-only (ADR-025)
contour-contracts-check:
    sh tools/contour/check-contracts-generated.sh
