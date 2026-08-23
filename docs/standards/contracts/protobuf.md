# Standard: Protobuf-контракты

> **Статус:** Active  
> **Применимость:** `contracts/proto/`, все NATS/gRPC producers и consumers  
> **Связанные документы:** ADR-012, ADR-014, [integration.md](../../architecture/integration.md)

`contracts/proto/` — единственный источник wire-схем межсервисного обмена.

## Совместимость

- Не меняй тип или номер существующего поля несовместимым образом.
- Не переиспользуй номер удалённого поля; помечай удалённые номера и имена как `reserved`.
- Новое поле добавляй так, чтобы старый consumer мог его проигнорировать, а новый consumer корректно обработал отсутствие значения.
- Breaking change требует явного решения о версии или миграции потребителей до изменения схемы.
- Межсервисные UUID-идентификаторы, включая identity, сходки и аукционы, передаются канонической lowercase UUIDv7-строкой с дефисами.

## Packages gRPC MVP

- Контракт владеемого доменом gRPC-сервиса лежит в `contracts/proto/grpc/<domain>/v<major>/`.
- Protobuf package имеет форму `solguficky.<domain>.v<major>`: например, `solguficky.identity.v1`. Имя не включает transport или язык потребителя.
- Major-версия является частью пути и package с первой версии. Новый major вводится только для breaking change с согласованной миграцией.

## Transport

- NATS и gRPC payload сериализуется только в Protobuf.
- JSON на межсервисном NATS path запрещён.
- Имя NATS subject не является частью `.proto`; оно документируется в [integration.md](../../architecture/integration.md) и задаётся константой или конфигурацией producer/consumer.
- Subjects именуются `<commands|events>.<домен>.<действие>` в `snake_case`.

## Кодогенерация Go

- Go-потребители вызывают `buf generate` как единый frontend кодогенерации. Конфигурация конкретного потребителя хранится в его `buf.gen.yaml`.
- Код генерируют локальные официальные плагины `protoc-gen-go` и `protoc-gen-go-grpc` с закреплёнными версиями. Remote plugins и Buf Schema Registry не входят в build path.
- Сгенерированный код находится в отдельном пакете `gen/`, не содержит рукописного кода и не является источником правды.
- Для Identity команда из корня репозитория — `buf generate --template apps/identity/buf.gen.yaml`. Её оборачивают рецепт `just identity-proto` и локальная, CI- и container-сборка сервиса; Aspire запускает уже подготовленный Go-процесс и сам кодогенерацию не выполняет.
- Для Identity версии инструментов закреплены в рецепте `just identity-proto-tools`: Buf `v1.47.2`, `protoc-gen-go` `v1.36.6`, `protoc-gen-go-grpc` `v1.5.1`.
- Identity задаёт Go import prefix `github.com/anticnvm/solguficky-hub/apps/identity/gen` через managed-настройку `go_package_prefix`; к нему добавляется путь `.proto` относительно `contracts/proto`.

Buf выбран вместо прямого вызова `protoc`, потому что генерирует код теми же Go-плагинами, но хранит список входов и параметры декларативно и оставляет единый путь к `buf lint` и `buf breaking`. Эти проверки не включаются самим выбором генератора: существующие Legacy-схемы не проходят стандартный lint, а compatibility gate вводится отдельным изменением контрактного CI.

## Изменение контракта

- Найди producers, consumers, тестовые инструменты и generated-code configuration по имени сообщения и subject.
- Обнови всех затронутых потребителей в одном изменении.
- Пересобери каждый затронутый сервис, чтобы выполнить кодогенерацию.
- Обнови `tools/nats-tester`, если он поддерживает изменённое сообщение.
- Обнови `architecture/integration.md` при добавлении или изменении subject.

Пошаговый workflow находится в skill `sgh-change-contract`.
