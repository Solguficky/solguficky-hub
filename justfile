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
# identity в CI читает их отсюда, чтобы локальная и CI-проверка шли
# одними бинарниками. Версии protoc-gen-go и protoc-gen-go-grpc
# закреплены в apps/identity/go.mod.

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

# Механический гейт перед сдачей: agent tooling, Identity и затронутые тесты
verify: check-agent-tools identity-build identity-test identity-lint

# --- Локальная оркестрация -------------------------------------------------

# AppHost поднимает только инфраструктуру: исполняемых компонентов ещё нет.
# Профили: infra | core | full (см. infra/apphost/Topology.cs).
aspire profile="core":
    cd infra/apphost && TOPOLOGY__PROFILE={{profile}} aspire run

# --- Identity (Go) ---------------------------------------------------------
#
# Кодогенерация — часть сборки. Рецепты собирают скелет gRPC-сервера
# и проверяют заглушку ResolveIdentity.

# Установить buf и Go-плагины кодогенерации закреплённых версий в $(go env GOPATH)/bin
identity-proto-tools:
    go install github.com/bufbuild/buf/cmd/buf@v{{BUF_VERSION}}
    cd apps/identity && go install google.golang.org/protobuf/cmd/protoc-gen-go google.golang.org/grpc/cmd/protoc-gen-go-grpc

# Сгенерировать Go-типы Identity из contracts/proto
identity-proto:
    buf generate --template apps/identity/buf.gen.yaml

# Сборка скелета Identity
identity-build: identity-proto
    cd apps/identity && go build ./...

# Проверка контракта и заглушки Identity
identity-test: identity-proto
    cd apps/identity && go test ./...

# Линт Identity; версия golangci-lint закреплена выше, как BUF_VERSION
identity-lint: identity-proto
    cd apps/identity && golangci-lint run ./...

# Локальный запуск скелета; адрес — IDENTITY_GRPC_ADDR, по умолчанию :50051
identity-run: identity-proto
    cd apps/identity && go run ./cmd/identity

# --- Инструменты -----------------------------------------------------------

# Установка nats-tester в текущее окружение
nats-tester-install:
    cd tools/nats-tester && python generate_proto.py && pip install -e .
