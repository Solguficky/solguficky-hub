# Architecture Decision Records

ADR сохраняет принятое решение, контекст и причины. Старый ADR не переписывается под новое направление: он получает ссылку на замену или пометку текущей применимости в этом индексе.

Новый ADR создаётся по [template.md](template.md) после явного решения владельца.

## Статусы

- **Historical status** — статус внутри исходного ADR на момент его написания.
- **Current applicability** — можно ли применять решение сейчас.

Значения применимости:

- `Active`;
- `Active, limited scope`;
- `Historical` — решение относилось к коду, которого больше нет в репозитории; сохраняется как контекст и к текущей платформе не применяется;
- `Superseded`;
- `Needs review`.

Тексты ADR фиксируют момент принятия решения и не переписываются задним числом. Поэтому старый ADR может ссылаться на каталоги и файлы, которых в репозитории уже нет: это свидетельство, а не инструкция.

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
| [ADR-009](ADR-009-auction-actor-hierarchy.md) | Иерархия акторов аукциона | Historical | Код удалён; извлечённое знание — в [архиве](../archive/services/auction-domain-and-lessons.md) |
| [ADR-010](ADR-010-hybrid-auction-clients.md) | Клиенты гибридного аукциона | Needs review | Future-направление, вне MVP |
| [ADR-011](ADR-011-notifications-realtime-separation.md) | Notifications и Real-Time Hub | Historical | Описывает удалённую аукционную ветку; устройство Notifications принято ADR-028 |
| [ADR-012](ADR-012-protobuf-from-start.md) | Protobuf вместо JSON | Active | Известные нарушения в коде считаются дефектами |
| [ADR-013](ADR-013-iterative-ai-assisted-development.md) | Итеративная работа с агентом | Needs review | Инициатива и решение должны принадлежать владельцу |
| [ADR-014](ADR-014-protobuf-in-git.md) | Protobuf-in-Git | Active, limited scope | Compatibility tooling и Registry остаются открытыми |
| [ADR-015](ADR-015-loki-centralized-logging.md) | Loki | Active, limited scope | Конфигурация существует, живой контур требует проверки |
| [ADR-016](ADR-016-rbac-action-pattern-and-transport.md) | RBAC, Action pattern и transport | Historical | Hardcoded-роли заменены ADR-026; остальные части относятся к удалённому аукционному шлюзу |
| [ADR-017](ADR-017-auction-service-stack.md) | C#/Akka.NET Auction Service | Historical | Код удалён; будущий аукцион на Scala/Pekko проектируется с нуля |
| [ADR-018](ADR-018-websocket-gateway-signalr.md) | C#/SignalR WebSocket Gateway | Historical | Код удалён; realtime-шлюз возвращается вместе с аукционом отдельным решением |
| [ADR-019](ADR-019-meetup-auction-separation-and-ulid.md) | Meetup/Auction и ULID | Active, limited scope | Разделение сохраняется; формат ID заменён ADR-020 |
| [ADR-020](ADR-020-uuidv7-identifiers.md) | UUIDv7 | Active | Канонический формат идентификаторов; уточнён ADR-023 |
| [ADR-021](ADR-021-aspire-local-orchestration.md) | Aspire local orchestration | Active, limited scope | Выбор Aspire в силе, профили `infra` и `identity` подтверждены живым прогоном. Механизм «три режима на компонент» заменён владением узлом и профилями-данными разделом «Пересмотр 2026-09-04»; предпосылка про C#-сервисы и Rust-шлюз не сбылась |
| [ADR-022](ADR-022-meetup-state-axes-and-visibility.md) | Оси состояния сходки, расписание и видимость | Active | Модель принята до реализации Meetups; хранение принято в ADR-024. В срезе организаторов нет ([ADR-031](ADR-031-meetups-domain-vocabulary-and-event-form.md)): скрытую видят все администраторы, изменяет администратор; правило «организатор — только свою» не применяется, пока организаторов нет |
| [ADR-023](ADR-023-meetup-public-number.md) | Публичный номер сходки рядом с UUIDv7 | Active, limited scope | Публичный номер снят [ADR-032](ADR-032-drop-meetup-public-number.md). В силе остаётся всё прочее: UUIDv7 как канонический идентификатор, UUID во внешнем deep link и `callback_data`, запрет сортировать сходки идентификатором. Раздел «Пересмотр 2026-08-25» сохраняется как история: он подтвердил номер, но вынес его из всех несущих ролей |
| [ADR-024](ADR-024-meetups-state-storage-with-domain-event-log.md) | Внутреннее устройство Meetups: строки состояния плюс журнал доменных событий | Active | Один ADR на весь RFC-004: 1b, чтение из тех же таблиц, версия строки, опрос для отложенной публикации. Утверждение «diff не нужно вычислять сравнением снимков» поправлено [ADR-031](ADR-031-meetups-domain-vocabulary-and-event-form.md): событие несёт снимок, diff считает потребитель |
| [ADR-025](ADR-025-meetups-fsharp-stack.md) | Стек Meetups: F#, Dapper, контракты через C#-проект | Active | Язык выбран под устройство из ADR-024; runtime остаётся .NET |
| [ADR-026](ADR-026-identity-mvp-model-and-access.md) | Модель Identity, контроль состава и проверка доступа в MVP | Active | Строки PostgreSQL и журнал доступа, три состояния допуска, премодерация в MVP, gRPC на каждом действии, fail-closed. Способ входа апдейтов уточнён [ADR-030](ADR-030-telegram-bot.md): long polling, secret token вебхука не используется |
| [ADR-027](ADR-027-identity-go-stack.md) | Стек Identity: Go | Active | Operational-эксперимент на простом CRUD-сервисе; generated-код изолирован в `gen/` |
| [ADR-028](ADR-028-notifications-subscriptions-replica-and-delivery-boundary.md) | Устройство Notifications: подписки, реплика чужих фактов и граница доставки | Active | Подписки принадлежат Notifications; факты берутся из реплики по событиям; ответственность заканчивается на публикации в шину. Уточнено [ADR-031](ADR-031-meetups-domain-vocabulary-and-event-form.md): повод различается типом события, а «что именно изменилось» — сравнением снимка с репликой |
| [ADR-029](ADR-029-notifications-orleans-stack.md) | Стек Notifications: C# и Orleans | Active | Reminders как механизм заданий; источник истины остаётся в PostgreSQL |
| [ADR-030](ADR-030-telegram-bot.md) | Telegram Bot: граница юзкейса, состояние в сообщении и ключ создания | Active | Собственного хранилища у компонента нет; идемпотентность принадлежит домену; вход — только long polling |
| [ADR-031](ADR-031-meetups-domain-vocabulary-and-event-form.md) | Словарь домена Meetups для среза и форма доменного события | Active | Четыре команды и два запроса, три типа событий со снимком в теле и в ответе команды. Автор — администратор, заведший запись; организаторов нет. PublishMeetup — целевое состояние. Поправляет утверждение ADR-024 про diff |
| [ADR-032](ADR-032-drop-meetup-public-number.md) | Публичный номер сходки не заводится | Active | Заменяет ADR-023 в части номера: у сходки один идентификатор, человеку она предъявляется заголовком. Сигнал возврата — повторяющиеся заголовки |

## Когда решение заслуживает ADR

Не каждое принятое решение становится ADR. Критерий один и проверяется до создания файла:

**ADR нужен там, где видна цена решения и дорог откат.**

Дорогой откат — это миграция данных, смена схемы, переписывание межсервисной границы, замена runtime или пересмотр продуктового обещания. Видная цена — это названный компромисс, за который платят конкретной сложностью.

Если решение меняется правкой конфигурации, переименованием или локальным рефакторингом, ему хватает записи в брифе сервиса или в задаче Linear. Решение, у которого нет альтернативы, тоже не требует ADR: фиксировать нечего.

Из этого критерия следует, что один ADR может закрывать несколько связанных вопросов, если они образуют одно решение с общей ценой. Разделять их на отдельные документы стоит тогда, когда у каждого своя цена, свой сигнал пересмотра и своя судьба.

## Переименования

Компонент, который в ADR-016, ADR-023 и ADR-028 назван Telegram Gateway, с [ADR-030](ADR-030-telegram-bot.md) называется **Telegram Bot** (`telegram-bot`). Тексты прежних ADR под новое имя не переписываются: они фиксируют решение на момент его принятия.

## Правила изменения

- Один ADR описывает одно решение.
- Не создавай ADR до решения владельца.
- Если решение заменяет старое, обнови индекс и статус старого ADR ссылкой на замену.
- Нормативное правило вынеси в `docs/standards/`; ADR хранит причины.
- Предложение и варианты до решения храни в `docs/rfcs/`.
