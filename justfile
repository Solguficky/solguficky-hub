# Единая точка входа для команд репозитория.
#
# Репозиторий полиязычный: каждый компонент собирается своим инструментом
# (dotnet, cargo, pip, go, buf, npm). Здесь они собраны в одном месте, чтобы не
# держать в голове, в какую папку зайти и чем собрать.
#
# Требуется just: https://github.com/casey/just
#
# Новый компонент добавляет свои рецепты и свою проверку в `verify` в том же
# коммите, в котором появляется его сборка.

# --- Версии инструментов ---------------------------------------------------
#
# Единственное место, где закреплены версии buf и golangci-lint. Джобы
# identity и telegram-bot в CI читают BUF_VERSION отсюда, а `just identity-tools`
# ставит buf локально, чтобы локальная и CI-проверка шли одними бинарниками;
# identity-lint отказывается работать на другой версии. Версии
# protoc-gen-go и protoc-gen-go-grpc закреплены в apps/identity/go.mod.

BUF_VERSION := "1.54.0"
GOLANGCI_LINT_VERSION := "2.13.2"

# Список рецептов
default:
    @just --list

# --- Настройка окружения ---------------------------------------------------

# Git-хуки, один раз после клонирования
setup:
    lefthook install

# --- Проверки --------------------------------------------------------------
#
# Тот же скрипт вызывает git-хук через lefthook.yml.

# Сообщение коммита из файла: just check-commit-message .git/COMMIT_EDITMSG
check-commit-message file:
    sh tools/git-hooks/check-commit-message.sh {{file}}

# Сгенерированные skills, agents и commands совпадают с источниками Skillshare
check-agent-tools:
    sh tools/skillshare/check-generated.sh

# Механический гейт перед сдачей: agent tooling, Identity, Telegram Bot, AppHost
verify: check-agent-tools identity-build identity-test identity-lint telegram-bot-typecheck telegram-bot-lint telegram-bot-test telegram-bot-build apphost-build

# --- Локальная оркестрация -------------------------------------------------

# AppHost поднимает инфраструктуру и зарегистрированные компоненты профиля.
# Профили: infra | core | full (см. infra/apphost/Topology.cs).
# Подготовка компонентов описана в их условных AppHost-ресурсах.
aspire profile="core":
    cd infra/apphost && TOPOLOGY__PROFILE={{profile}} aspire run

# Сборка Aspire AppHost
apphost-build:
    cd infra/apphost && dotnet build --nologo

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

# Проверка контракта, схемы и разрешения Identity
identity-test: identity-proto
    cd apps/identity && go test ./...

# Линт Identity закреплённой версией; чужая версия читает тот же
# .golangci.yml иначе, поэтому расхождение — ошибка, а не предупреждение
identity-lint: identity-proto
    @golangci-lint version --short 2>/dev/null | grep -qx '{{GOLANGCI_LINT_VERSION}}' || { echo 'нужен golangci-lint {{GOLANGCI_LINT_VERSION}}: just identity-lint-tools' >&2; exit 1; }
    cd apps/identity && golangci-lint run ./...

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

telegram-bot-test: telegram-bot-proto
    cd apps/telegram-bot && npm test

telegram-bot-lint: telegram-bot-proto
    cd apps/telegram-bot && npm run lint

telegram-bot-run: telegram-bot-build
    cd apps/telegram-bot && npm start

# --- Инструменты -----------------------------------------------------------

# Установка nats-tester в текущее окружение
nats-tester-install:
    cd tools/nats-tester && python generate_proto.py && pip install -e .
