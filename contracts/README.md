# Контракты Solguficky Hub

`contracts/proto/` — единственный источник Protobuf wire-схем для NATS и gRPC. Generated code создаётся сборкой потребляющего сервиса и не является источником правды.

## Фактическая структура

```text
contracts/proto/
├── buf.yaml
├── auction/
│   └── v1/
│       ├── auction.proto
│       ├── auction_events.proto
│       └── auction_service.proto
├── identity/
│   └── v1/
│       ├── identity_events.proto
│       ├── identity_service.proto
│       └── roles.proto
├── meetups/
│   └── v1/
│       ├── meetups.proto
│       ├── meetups_events.proto
│       └── meetups_service.proto
└── notifications/
    └── v1/
        ├── notifications.proto
        └── notifications_service.proto
```

Схемы раскладываются по домену-владельцу и major-версии: `<domain>/v<major>/`. Protobuf package повторяет путь: `auction.v1`, `identity.v1`, `meetups.v1`, `notifications.v1`. Транспорт каталогом не является — то, что операция идёт по gRPC, а не по NATS, записано в [integration catalog](../docs/architecture/integration.md), а не в раскладке.

Корень buf-модуля — сам `contracts/proto/`, поэтому импорты между схемами считаются от него. Как потребитель указывает этот корень — в [стандарте Protobuf](../docs/standards/contracts/protobuf.md).

Схемы прежнего аукциона удалены и контрактом не являются; `auction/v1` написан заново по словарю [ADR-047](../docs/decisions/ADR-047-auction-trading-domain-vocabulary-and-event-form.md): публичные факты журнала лота, команды участника и чтение состояния торгов. Первый NATS-контракт — `notifications/v1/notifications.proto`: адресный факт уведомления, который Notifications публикует каналам. Второй — `meetups/v1/meetups_events.proto`: исходящие факты журнала сходок. Третий — `identity/v1/identity_events.proto`: исходящие факты о доступе человека. Контракт Telegram Bot ещё не спроектирован.

Файл домена делится по признаку «сервис, значения или исходящие факты», а не по транспорту: `meetups/v1/meetups.proto` и `identity/v1/roles.proto` несут только типы значений, `*_service.proto` — сам сервис и его запросы, а `*_events.proto` — то, что домен публикует наружу. Последние вынесены по той же причине, по которой вынесены значения: потребителю событий не нужен ни `MeetupsService` с его запросами, ни `IdentityService` с его операциями. Импорт через границу домена целится в файл значений: так `notifications/v1/notifications.proto` берёт расписание, жизненный цикл и видимость сходки, не зная `MeetupsService`. Внутри домена работает то же правило: `identity/v1/identity_events.proto` берёт `GlobalRole` из файла значений своего домена.

Потребителя это не освобождает от импортированного файла — фильтр `paths` отбирает, что генерируется, а не что резолвится, и срез из одного каталога `contracts/proto/notifications` даёт код с импортом на несгенерированный `meetups/v1/meetups_pb`. Но расширяется такой фильтр одним файлом значений, а не чужим сервисом с десятком его запросов и клиентской заглушкой.

У `notifications/v1` потребителя пока нет: сервис не реализован, а генерация Identity и Telegram Bot сужает вход фильтром `paths`, тогда как `Meetups.Contracts` перечисляет файлы поимённо. Схему домена без потребителя не читает ни одна джоба сборки, поэтому компиляцию всего модуля держит отдельная проверка — `just contracts-build` и одноимённая джоба CI. Генерацию на всех языках потребителей держит `just contracts-codegen`: Go и TypeScript — шаблоном `contracts/buf.gen.codegen.yaml` в игнорируемый `tmp/`, Scala — сборкой Auction. Так схема `auction/v1`, которую сегодня читает только Scala, проверяется и Go-, и TypeScript-генератором, а `gen/` Identity и бота чужого кода не получают.

## Владение

- `.proto` задаёт сообщение и номера полей.
- [Integration catalog](../docs/architecture/integration.md) задаёт NATS subject, producer и consumers.
- Каждый сервис хранит только configuration кодогенерации и использует сгенерированные типы. У Go и TypeScript это `buf.gen.yaml`, у .NET — элементы `Protobuf` и `ProtoRoot` в контрактном `.csproj`.
- `tools/nats-tester` генерирует Python-типы из тех же схем.

## Изменение

Норматив совместимости — в [Protobuf standard](../docs/standards/contracts/protobuf.md). Пошаговый workflow — в skill `proj-change-contract`.

Минимальный порядок:

1. изменить схему без переиспользования field numbers;
2. найти всех producers и consumers по имени сообщения и subject;
3. обновить их в одном изменении;
4. пересобрать затронутые сервисы;
5. обновить `nats-tester` и integration catalog;
6. отдельно зафиксировать версионирование любого breaking change.

## Текущее управление схемами

Git остаётся источником схем. ADR-014 описывает текущий Protobuf-in-Git подход. Проверка совместимости в CI введена — `just contracts-check` и джоба `contracts` ([Protobuf standard](../docs/standards/contracts/protobuf.md)). Schema Registry остаётся открытым архитектурным вопросом: его необходимость и роль не решены.

## Ссылки

- [Protobuf language guide](https://protobuf.dev/programming-guides/proto3/)
- [Integration catalog](../docs/architecture/integration.md)
- [ADR index](../docs/decisions/README.md)
