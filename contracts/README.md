# Контракты Solguficky Hub

`contracts/proto/` — единственный источник Protobuf wire-схем для NATS и gRPC. Generated code создаётся сборкой потребляющего сервиса и не является источником правды.

## Фактическая структура

```text
contracts/proto/
├── buf.yaml
└── identity/
    └── v1/
        └── identity_service.proto
```

Схемы раскладываются по домену-владельцу и major-версии: `<domain>/v<major>/`. Protobuf package повторяет путь: `identity.v1`. Транспорт каталогом не является — то, что операция идёт по gRPC, а не по NATS, записано в [integration catalog](../docs/architecture/integration.md), а не в раскладке.

Корень buf-модуля — сам `contracts/proto/`, поэтому импорты между схемами считаются от него. Потребитель сужает генерацию фильтром `paths` в своём `buf.gen.yaml`, а не переносом корня.

Аукционные схемы удалены: аукцион не входит в MVP. Контракты Meetups, нового Telegram Gateway и NATS-событий Identity ещё не спроектированы.

## Владение

- `.proto` задаёт сообщение и номера полей.
- [Integration catalog](../docs/architecture/integration.md) задаёт NATS subject, producer и consumers.
- Каждый сервис хранит только configuration кодогенерации и использует сгенерированные типы.
- `tools/nats-tester` генерирует Python-типы из тех же схем.

## Изменение

Норматив совместимости — в [Protobuf standard](../docs/standards/contracts/protobuf.md). Пошаговый workflow — в skill `sgh-change-contract`.

Минимальный порядок:

1. изменить схему без переиспользования field numbers;
2. найти всех producers и consumers по имени сообщения и subject;
3. обновить их в одном изменении;
4. пересобрать затронутые сервисы;
5. обновить `nats-tester` и integration catalog;
6. отдельно зафиксировать версионирование любого breaking change.

## Текущее управление схемами

Git остаётся источником схем. ADR-014 описывает текущий Protobuf-in-Git подход, но не запрещает навсегда compatibility tooling или Schema Registry. Их необходимость и роль остаются открытым архитектурным вопросом.

## Ссылки

- [Protobuf language guide](https://protobuf.dev/programming-guides/proto3/)
- [Integration catalog](../docs/architecture/integration.md)
- [ADR index](../docs/decisions/README.md)
