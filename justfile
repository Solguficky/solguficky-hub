# Единая точка входа для команд репозитория.
#
# Репозиторий полиязычный: каждый компонент собирается своим инструментом
# (dotnet, cargo, pip, go, buf). Здесь они собраны в одном месте, чтобы не
# держать в голове, в какую папку зайти и чем собрать.
#
# Требуется just: https://github.com/casey/just
#
# Новый компонент добавляет свои рецепты и свою проверку в `verify` в том же
# коммите, в котором появляется его сборка.

# --- Версии инструментов ---------------------------------------------------
#
# Единственное место, где закреплены версии buf и golangci-lint. Джоба
# identity в CI читает их отсюда, а `just identity-tools` ставит их
# локально, чтобы локальная и CI-проверка шли одними бинарниками;
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

# Механический гейт перед сдачей: agent tooling, Identity, Meetups и тесты
verify: check-agent-tools identity-build identity-test identity-lint meetups-build meetups-test

# --- Локальная оркестрация -------------------------------------------------

# AppHost поднимает только инфраструктуру: исполняемых компонентов ещё нет.
# Профили: infra | core | full (см. infra/apphost/Topology.cs).
aspire profile="core":
    cd infra/apphost && TOPOLOGY__PROFILE={{profile}} aspire run

# --- Identity (Go) ---------------------------------------------------------
#
# Кодогенерация — часть сборки. Рецепты собирают скелет gRPC-сервера
# и проверяют заглушку ResolveIdentity.

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

# Сборка скелета Identity
identity-build: identity-proto
    cd apps/identity && go build ./...

# Проверка контракта и заглушки Identity
identity-test: identity-proto
    cd apps/identity && go test ./...

# Линт Identity закреплённой версией; чужая версия читает тот же
# .golangci.yml иначе, поэтому расхождение — ошибка, а не предупреждение
identity-lint: identity-proto
    @golangci-lint version --short 2>/dev/null | grep -qx '{{GOLANGCI_LINT_VERSION}}' || { echo 'нужен golangci-lint {{GOLANGCI_LINT_VERSION}}: just identity-lint-tools' >&2; exit 1; }
    cd apps/identity && golangci-lint run ./...

# Локальный запуск скелета; адрес — IDENTITY_GRPC_ADDR, по умолчанию :50051
identity-run: identity-proto
    cd apps/identity && go run ./cmd/identity

# --- Meetups (F# / .NET) ---------------------------------------------------
#
# Кодогенерация C# — часть `dotnet build` контрактного проекта.
# Исполняемого сервиса ещё нет: собираются контракты и F#-ссылка на них.

# Сборка контрактного C#-проекта и F#-библиотеки
meetups-build:
    dotnet build apps/meetups/Meetups.sln --nologo

# Проверка, что в схеме ровно шесть операций среза
meetups-test:
    DOTNET_ROLL_FORWARD=LatestMajor dotnet test apps/meetups/Meetups.sln --nologo

# --- Инструменты -----------------------------------------------------------

# Установка nats-tester в текущее окружение
nats-tester-install:
    cd tools/nats-tester && python generate_proto.py && pip install -e .
