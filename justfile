# Единая точка входа для команд репозитория.
#
# Репозиторий полиязычный: каждый компонент собирается своим инструментом
# (dotnet, cargo, pip, go, buf). Здесь они собраны в одном месте, чтобы не
# держать в голове, в какую папку зайти и чем собрать.
#
# Требуется just: https://github.com/casey/just
#
# Новый компонент добавляет свои рецепты сюда в том же коммите, в котором
# появляется его сборка.

# --- Версии инструментов ---------------------------------------------------
#
# Единственное место, где закреплена версия buf. Джоба identity в CI читает
# её отсюда, чтобы локальная и CI-генерация шли одним бинарником.
# Версии protoc-gen-go и protoc-gen-go-grpc закреплены в apps/identity/go.mod.

BUF_VERSION := "1.54.0"

# Список рецептов
default:
    @just --list

# --- Настройка окружения ---------------------------------------------------

# Git-хуки, один раз после клонирования
setup:
    lefthook install

# --- Проверки --------------------------------------------------------------
#
# Те же скрипты вызывают git-хуки через lefthook.yml.

# Синхронность скиллов .claude/skills и .agents/skills
check-skills:
    sh tools/git-hooks/check-skills-mirror.sh

# Сообщение коммита из файла: just check-commit-message .git/COMMIT_EDITMSG
check-commit-message file:
    sh tools/git-hooks/check-commit-message.sh {{file}}

# --- Локальная оркестрация -------------------------------------------------

# ВНИМАНИЕ: AppHost ссылается на пути services/, которых больше нет,
# и не соберётся до актуализации. См. infra/apphost/Program.cs.
aspire profile="core":
    cd infra/apphost && TOPOLOGY__PROFILE={{profile}} aspire run

# --- Identity (Go) ---------------------------------------------------------
#
# Кодогенерация — часть сборки сервиса. Исполняемого Identity ещё нет;
# рецепты проверяют, что контракт собирается в gen/.

# Установить buf и Go-плагины кодогенерации закреплённых версий в $(go env GOPATH)/bin
identity-proto-tools:
    go install github.com/bufbuild/buf/cmd/buf@v{{BUF_VERSION}}
    cd apps/identity && go install google.golang.org/protobuf/cmd/protoc-gen-go google.golang.org/grpc/cmd/protoc-gen-go-grpc

# Сгенерировать Go-типы Identity из contracts/proto
identity-proto:
    buf generate --template apps/identity/buf.gen.yaml

# Сборка сгенерированного пакета Identity
identity-build: identity-proto
    cd apps/identity && go build ./...

# Проверка wire-типов Identity
identity-test: identity-proto
    cd apps/identity && go test ./...

# --- Инструменты -----------------------------------------------------------

# Установка nats-tester в текущее окружение
nats-tester-install:
    cd tools/nats-tester && python generate_proto.py && pip install -e .

# --- legacy ----------------------------------------------------------------
#
# legacy/ не входит в платформу и не собирается как её часть. Эти рецепты
# нужны для извлечения знаний: прогнать тесты, посмотреть поведение,
# снять доменную модель перед удалением. Уходят вместе с legacy/.

legacy-build-auction:
    dotnet build legacy/auction-service/AuctionService.sln

legacy-test-auction:
    dotnet test legacy/auction-service/AuctionService.sln

legacy-build-notifications:
    dotnet build legacy/notifications-service/NotificationsService.sln

legacy-test-notifications:
    dotnet test legacy/notifications-service/NotificationsService.sln

legacy-build-websocket:
    dotnet build legacy/websocket-gateway/WebSocketGateway.sln

legacy-test-websocket:
    dotnet test legacy/websocket-gateway/WebSocketGateway.sln

legacy-check-gateway:
    cd legacy/telegram-gateway && cargo fmt --check
    cd legacy/telegram-gateway && cargo clippy --all-targets -- -D warnings
    cd legacy/telegram-gateway && cargo test
