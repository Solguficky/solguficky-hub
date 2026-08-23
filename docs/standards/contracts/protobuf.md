# Standard: Protobuf-контракты

> **Статус:** Active  
> **Применимость:** `contracts/proto/`, все NATS/gRPC producers и consumers  
> **Связанные документы:** ADR-012, ADR-014, ADR-025, ADR-027, [RFC-006](../../rfcs/RFC-006-go-protobuf-codegen.md), [integration.md](../../architecture/integration.md)

`contracts/proto/` — единственный источник wire-схем межсервисного обмена.

## Совместимость

- Не меняй тип или номер существующего поля несовместимым образом.
- Не переиспользуй номер удалённого поля; помечай удалённые номера и имена как `reserved`.
- Новое поле добавляй так, чтобы старый consumer мог его проигнорировать, а новый consumer корректно обработал отсутствие значения.
- Breaking change требует явного решения о версии или миграции потребителей до изменения схемы.
- Идентификаторы сходок и аукционов передаются канонической lowercase UUIDv7-строкой с дефисами.

## Transport

- NATS и gRPC payload сериализуется только в Protobuf.
- JSON на межсервисном NATS path запрещён.
- Имя NATS subject не является частью `.proto`; оно документируется в [integration.md](../../architecture/integration.md) и задаётся константой или конфигурацией producer/consumer.
- Subjects именуются `<commands|events>.<домен>.<действие>` в `snake_case`.

## Изменение контракта

- Найди producers, consumers, тестовые инструменты и generated-code configuration по имени сообщения и subject.
- Обнови всех затронутых потребителей в одном изменении.
- Пересобери каждый затронутый сервис, чтобы выполнить кодогенерацию.
- Обнови `tools/nats-tester`, если он поддерживает изменённое сообщение.
- Обнови `architecture/integration.md` при добавлении или изменении subject.

Пошаговый workflow находится в skill `sgh-change-contract`.

## Кодогенерация

Сгенерированный код создаёт сборка потребляющего сервиса и не является источником правды.

- F#: штатный `Grpc.Tools` в отдельном C#-проекте ([ADR-025](../../decisions/ADR-025-meetups-fsharp-stack.md)).
- Go: инструмент ещё не выбран. Варианты и рекомендация — [RFC-006](../../rfcs/RFC-006-go-protobuf-codegen.md), задача — [PER-31](https://linear.app/anticnvm/issue/per-31).
- TypeScript: решается сервисом-потребителем.
