# Architecture Decision Records

ADR сохраняет принятое решение, контекст и причины. Старый ADR не переписывается под новое направление: он получает ссылку на замену или пометку текущей применимости в этом индексе.

Новый ADR создаётся по [template.md](template.md) после явного решения владельца.

## Статусы

- **Historical status** — статус внутри исходного ADR на момент его написания.
- **Current applicability** — можно ли применять решение сейчас.

Значения применимости:

- `Active`;
- `Active, limited scope`;
- `Legacy scope`;
- `Superseded`;
- `Needs review`.

## Индекс

| ADR | Решение | Current applicability | Комментарий |
|---|---|---|---|
| [ADR-001](ADR-001-microservices-choreography.md) | Микросервисы и хореография | Active, limited scope | Не означает, что любое взаимодействие обязано быть асинхронным |
| [ADR-002](ADR-002-cqrs-event-sourcing-stateful-services.md) | CQRS/ES для stateful-сервисов | Active, limited scope | Не применять автоматически к CRUD и MVP-сервисам |
| [ADR-003](ADR-003-nats-jetstream-message-bus.md) | NATS JetStream | Needs review | Current consumers не являются durable только из-за конфигурации JetStream |
| [ADR-004](ADR-004-postgresql-primary-database.md) | PostgreSQL | Active | Current primary storage |
| [ADR-005](ADR-005-grpc-synchronous-communication.md) | gRPC | Active, limited scope | Конкретный transport определяется failure semantics сценария |
| [ADR-006](ADR-006-railway-hosting.md) | Railway hosting | Needs review | Railway — вариант наряду с собственным железом и VPS |
| [ADR-007](ADR-007-polyglot-service-stacks.md) | Полиглотная модель выбора стека | Active | Язык выбирается под задачу сервиса; назначения языков из исходной редакции удалены |
| [ADR-008](ADR-008-apicurio-schema-registry.md) | Apicurio Registry | Superseded | Заменён ADR-014; возврат Registry требует нового решения |
| [ADR-009](ADR-009-auction-actor-hierarchy.md) | Иерархия акторов аукциона | Legacy scope | Источник знаний для вывода C#/Akka.NET-кода |
| [ADR-010](ADR-010-hybrid-auction-clients.md) | Клиенты гибридного аукциона | Needs review | Future-направление, вне MVP |
| [ADR-011](ADR-011-notifications-realtime-separation.md) | Notifications и Real-Time Hub | Legacy scope | Описывает старую аукционную ветку |
| [ADR-012](ADR-012-protobuf-from-start.md) | Protobuf вместо JSON | Active | Известные нарушения в коде считаются дефектами |
| [ADR-013](ADR-013-iterative-ai-assisted-development.md) | Итеративная работа с агентом | Needs review | Инициатива и решение должны принадлежать владельцу |
| [ADR-014](ADR-014-protobuf-in-git.md) | Protobuf-in-Git | Active, limited scope | Compatibility tooling и Registry остаются открытыми |
| [ADR-015](ADR-015-loki-centralized-logging.md) | Loki | Active, limited scope | Конфигурация существует, живой контур требует проверки |
| [ADR-016](ADR-016-rbac-action-pattern-and-transport.md) | RBAC, Action pattern и transport | Legacy scope | Hardcoded-роли заменены ADR-026; остальные части относятся к legacy-аукционному Gateway |
| [ADR-017](ADR-017-auction-service-stack.md) | C#/Akka.NET Auction Service | Legacy scope | Не определяет Scala/Pekko auction v2 |
| [ADR-018](ADR-018-websocket-gateway-signalr.md) | C#/SignalR WebSocket Gateway | Legacy scope | Сервис заморожен и обслуживает только аукцион |
| [ADR-019](ADR-019-meetup-auction-separation-and-ulid.md) | Meetup/Auction и ULID | Active, limited scope | Разделение сохраняется; формат ID заменён ADR-020 |
| [ADR-020](ADR-020-uuidv7-identifiers.md) | UUIDv7 | Active | Канонический формат идентификаторов; уточнён ADR-023 |
| [ADR-021](ADR-021-aspire-local-orchestration.md) | Aspire local orchestration | Active, limited scope | AppHost ещё не подтверждён живым запуском |
| [ADR-022](ADR-022-meetup-state-axes-and-visibility.md) | Оси состояния сходки, расписание и видимость | Active | Модель принята до реализации Meetups; хранение принято в ADR-024 |
| [ADR-023](ADR-023-meetup-public-number.md) | Публичный номер сходки рядом с UUIDv7 | Active | Номер — для человека и поддержки; внешний routing остаётся на UUID |
| [ADR-024](ADR-024-meetups-state-storage-with-domain-event-log.md) | Внутреннее устройство Meetups: строки состояния плюс журнал доменных событий | Active | Один ADR на весь RFC-004: 1b, чтение из тех же таблиц, версия строки, опрос для отложенной публикации |
| [ADR-025](ADR-025-meetups-fsharp-stack.md) | Стек Meetups: F#, Dapper, контракты через C#-проект | Active | Язык выбран под устройство из ADR-024; runtime остаётся .NET |
| [ADR-026](ADR-026-identity-mvp-model-and-access.md) | Модель Identity и проверка доступа в MVP | Active | Строки PostgreSQL, gRPC на каждом действии, fail-closed, ручной контроль состава |
| [ADR-027](ADR-027-identity-go-stack.md) | Стек Identity: Go | Active | Operational-эксперимент на простом CRUD-сервисе; generated-код изолирован в `gen/` |

## Правила изменения

- Один ADR описывает одно решение.
- Не создавай ADR до решения владельца.
- Если решение заменяет старое, обнови индекс и статус старого ADR ссылкой на замену.
- Нормативное правило вынеси в `docs/standards/`; ADR хранит причины.
- Предложение и варианты до решения храни в `docs/rfcs/`.
