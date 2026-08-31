# Межсервисное взаимодействие

> **Статус:** Canonical для принятых MVP-контрактов.

Wire-схемы находятся в `contracts/proto/`. Этот документ описывает transport boundaries и имена NATS subjects, которые не являются частью `.proto`.

## Базовое разделение

- Асинхронные команды и события передаются через NATS.
- Синхронные queries и CRUD-вызовы могут использовать gRPC.
- Конкретный выбор делается по failure semantics сценария, а не только по признаку read/write; перегруженный ADR-016 переведён в `Historical` и новые решения принимаются отдельными ADR.
- NATS и gRPC payload сериализуется только в Protobuf.

## Subjects

Формат: `<commands|events>.<домен>.<действие>` в `snake_case`.

`>` — многоуровневый wildcard. Например, `events.auction.>` получает все события аукциона; одноуровневый `*` не заменяет его.

Действующих NATS-контрактов нет: ни один subject не принят. Реестр `nats-tester` пуст, и запись в него добавляется одновременно с записью в этот каталог.

Subjects удалённой аукционной ветки перечислены в [архиве](../archive/services/auction-domain-and-lessons.md) как историческое свидетельство. Обязательным контрактом будущего аукциона они не являются; сами `.proto` восстанавливаются из истории Git.

## MVP-контракты

### Identity gRPC

| RPC | Proto | Caller | Callee |
|---|---|---|---|
| `IdentityService.ResolveIdentity` | `identity.v1` в `contracts/proto/identity/v1/identity_service.proto` | Telegram Bot | Identity |

Запрос: `telegram_user_id` (`int64`) и `telegram_username`, если ник есть. Ответ: `identity_id` канонической UUIDv7-строкой и `global_roles` из `GlobalRole`. В срезе единственная роль — `GLOBAL_ROLE_ADMIN`; пустой набор — обычный пользователь.

Операция устанавливает личность: создаёт профиль при первом обращении и обновляет ник как кэш. Статус допуска, whitelist, инвайты и служебные endpoints премодерации в этот контракт не входят — полей под них нет. Отказы передаются статусами gRPC, отдельного error-message нет.

Для вызова бот → Identity принят синхронный gRPC на каждом Telegram update, требующем продуктового действия; при недоступности Identity операция завершается fail-closed, кэш фактов доступа не используется. Service authentication остаётся предметом отдельного контракта.

### Meetups gRPC

| RPC | Proto | Caller | Callee |
|---|---|---|---|
| `MeetupsService.CreateMeetupDraft` | `meetups.v1` в `contracts/proto/meetups/v1/meetups_service.proto` | Telegram Bot | Meetups |
| `MeetupsService.ChangeMeetupAttributes` | то же | Telegram Bot | Meetups |
| `MeetupsService.SetMeetupSchedule` | то же | Telegram Bot | Meetups |
| `MeetupsService.PublishMeetup` | то же | Telegram Bot | Meetups |
| `MeetupsService.ListVisibleMeetups` | то же | Telegram Bot | Meetups |
| `MeetupsService.GetMeetup` | то же | Telegram Bot | Meetups |

Шесть синхронных операций среза идут по gRPC. NATS для них не используется: боту нужен ответ в том же ходе, что и Telegram update, а доменных событий в шину срез не публикует. Service authentication остаётся предметом отдельного контракта.

Во всех шести запросах поле `viewer`: `identity_id` канонической UUIDv7-строкой и `global_roles` из `identity.v1.GlobalRole`. Бот передаёт установленную личность и общие роли, а не готовое разрешение; доменное решение принимает Meetups.

`CreateMeetupDraft` принимает `id` — каноническую UUIDv7-строку, которую генерирует вызывающая сторона; это же ключ идемпотентности ([ADR-030](../decisions/ADR-030-telegram-bot.md), [ADR-031](../decisions/ADR-031-meetups-domain-vocabulary-and-event-form.md)). Отдельного поля ключа нет. Meetups атомарно связывает пару (автор, `id`) с черновиком: ключ уникален в пределах автора и живёт вместе со строкой сходки. Повтор с тем же `id` и тем же смотрящим возвращает текущий снимок и не создаёт вторую запись. Повтор с тем же `id` и другим смотрящим неотличим от «не найдено».

`ChangeMeetupAttributes` и `SetMeetupSchedule` несут целевое состояние поля, а не действие над ним: все пять информационных атрибутов целиком и расписание одним значением. `PublishMeetup` на уже видимой сходке — успех без нового события.

Отказы передаются статусами gRPC, отдельного error-message в схеме нет. Видимость не имеет собственного кода: скрытая для смотрящего сходка и несуществующая отвечают одинаково.

| Условие | gRPC status |
|---|---|
| нет права на административное действие | `PERMISSION_DENIED` |
| нарушен инвариант домена | `FAILED_PRECONDITION` |
| сходка не найдена или скрыта от смотрящего | `NOT_FOUND` |

Код генерируется штатным `Grpc.Tools` в `apps/meetups/Meetups.Contracts`; F#-проект `apps/meetups/Meetups` ссылается на него как на библиотеку ([ADR-025](../decisions/ADR-025-meetups-fsharp-stack.md)).

Форма публикуемого наружу события среза не касается: без уведомлений событий в шину не уходит. ADR-031 фиксирует только доменное событие и строку журнала; конверт публикации, subject'ы и wire-формат остаются открытыми и решаются вместе со словарём уведомлений. Метод перечисления состояния для реплики Notifications в этот контракт не входит.

Wire-схемы gRPC API для Telegram Bot и reminders ещё не приняты.

Notifications публикует наружу не команду каналу, а факт «человеку положено такое уведомление»: явный получатель во внутреннем идентификаторе, тип уведомления со структурированными данными — типизированным `oneof`, а не строковым кодом со свободным словарём. Готового текста и `chat_id` в сообщении нет, обратных событий о доставке нет. Команда `commands.telegram.send_message` из удалённой аукционной ветки формой будущего контракта не является: она несла `chat_id` и готовый текст, то есть ровно то, от чего [ADR-028](../decisions/ADR-028-notifications-subscriptions-replica-and-delivery-boundary.md) отказался. Словарь кодов типов уведомлений становится межсервисным контрактом и меняется согласованно с потребителями.

Identity публикует события о регистрации и смене статуса допуска: их потребляет Notifications, который ведёт по ним собственную реплику ([ADR-028](../decisions/ADR-028-notifications-subscriptions-replica-and-delivery-boundary.md)). Эти события вне среза и в текущем `.proto` не описаны. Telegram Bot устанавливает Telegram identity из принятого апдейта: вход идёт long polling, доверенностью служит владение bot token, входящего HTTP и secret token у компонента нет ([ADR-030](../decisions/ADR-030-telegram-bot.md)). Identity разрешает Telegram user id во внутренний id и глобальные роли, а Meetups принимает доменные authorization-решения. Статус допуска входит в полную модель ADR-026, но в контракт среза не входит. Authentication material через Identity не проходит.

## Выбор sync и async

Правило «команды к stateful aggregates через NATS, CRUD и queries через gRPC» остаётся отправной точкой, но не применяется механически. Для каждой операции нужно определить:

- требуется ли немедленный ответ пользователю;
- кто владеет состоянием;
- допустима ли eventual consistency;
- что происходит при timeout;
- как клиент узнаёт итог асинхронной команды;
- нужна ли durable delivery;
- как обеспечивается idempotency.

ADR-016 объединяет transport, RBAC и решения аукционного шлюза и имеет applicability `Historical`: часть про роли заменена [ADR-026](../decisions/ADR-026-identity-mvp-model-and-access.md), остальное описывает удалённый код. Правило выбора transport из него используется как отправная точка, а не как действующее решение для MVP.

## Contract governance

Приняты раскладка `contracts/proto/<domain>/v<major>/` с совпадающим Protobuf package, кодогенерация Go и TypeScript через `buf generate` с локальными плагинами и кодогенерация .NET через `Grpc.Tools` в отдельном C#-проекте. Норматив — [protobuf.md](../standards/contracts/protobuf.md).

Закрыто и записано нормативно:

- правила совместимости — раздел «Совместимость» в [protobuf.md](../standards/contracts/protobuf.md);
- ownership схем, каталога и generated-code configuration — раздел «Владение» в [contracts/README.md](../../contracts/README.md);
- раскладка каталогов, именование пакетов и кодогенерация Go — [protobuf.md](../standards/contracts/protobuf.md);
- кодогенерация .NET — раздел «Кодогенерация .NET» в [protobuf.md](../standards/contracts/protobuf.md);
- кодогенерация TypeScript — раздел «Кодогенерация TypeScript» в [protobuf.md](../standards/contracts/protobuf.md).

До следующих контрактов остаются открытыми:

- CI breaking checks и `buf lint`;
- машинно-проверяемые ограничения полей. Единственный рабочий механизм — protovalidate: опция вида `[(buf.validate.field).string.uuid = true]` прямо в схеме и рантайм-библиотека у каждого потребителя. Он требует зависимости из Buf Schema Registry, которая по [protobuf.md](../standards/contracts/protobuf.md) сейчас вне build path, поэтому вводится не вместе с отдельным контрактом, а решением по всем схемам сразу;
- граница отдельного контрактного изменения, когда оно затрагивает несколько потребителей.

Schema Registry — не одно бинарное решение:

| Задача | Ближайший разумный уровень |
|---|---|
| Source control схем | Git остаётся источником |
| Breaking-change detection | Compatibility check в CI, например Buf |
| Code generation | Единые команды и версии generators |
| Distribution/discovery | Оценивать при независимых lifecycle или repositories |
| Runtime schema resolution | Не вводить без реального сценария |
| Учебная эксплуатация Registry | Отдельная итерация после product slice |

Возврат Schema Registry остаётся Open. Сначала формулируется проблема, которую он должен решить.

## Delivery semantics

- В коде используются обычные NATS subscriptions; наличие JetStream в локальной конфигурации не делает consumers durable автоматически.
- Durable consumers, redelivery, deduplication и idempotency должны проектироваться совместно.
- Наличие `op_id` в части команд само по себе не обеспечивает идемпотентность: consumer должен сохранять или проверять обработанные операции.
- Требования к допустимой потере, повтору и порядку задаются отдельно для каждого сценария.

Перед использованием durable delivery в продуктовом потоке совместно проектируются:

- stream и retention policy;
- durable consumer;
- ack/retry policy;
- idempotency key и проверка `op_id`;
- consumer inbox/dedup storage;
- идемпотентность внешнего Telegram side effect;
- dead-letter либо операционный способ разбирать необрабатываемые сообщения;
- метрики lag, redelivery и failed delivery.

Read model вводится, когда query-нагрузка, UX или изоляция stateful aggregate делает прямые обращения неудобными, а не как обязательный CQRS-ритуал.

## Observability baseline MVP

- структурные логи без персональных данных и Telegram authentication material;
- correlation/operation id через межсервисный путь;
- health и readiness checks;
- метрики ошибок, latency и delivery attempts;
- trace первого вертикального среза Telegram Bot → Identity → Meetups;
- операторский способ увидеть и повторить неуспешное действие без ручной правки БД.

Loki/Grafana и Aspire dashboard являются заделом. Наличие конфигурации не подтверждает работающую наблюдаемость.

## Изменение

При изменении `.proto` следуй [Protobuf standard](../standards/contracts/protobuf.md) и skill `proj-change-contract`. При изменении subject или gRPC-операции обновляй producer, consumers, тестовый инструмент и этот каталог в одном изменении.

## Технические источники

- [Buf breaking change detection](https://buf.build/docs/breaking/)
- [Apicurio Registry compatibility modes](https://www.apicur.io/registry/docs/apicurio-registry/3.3.x/getting-started/assembly-registry-compatibility-modes.html)
