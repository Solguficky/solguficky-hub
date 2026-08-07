---
name: contract-change
description: Провести изменение Protobuf-контракта через всех producers, consumers, тесты и документацию. Использовать при любом изменении contracts/proto/ или связанного NATS/gRPC сообщения.
---

# Изменить Protobuf-контракт

1. Прочитай `docs/standards/contracts/protobuf.md`, `contracts/README.md` и `docs/architecture/integration.md`.
2. Найди producers, consumers, subject constants/configuration, codegen и `nats-tester` по имени сообщения и subject. Не полагайся на статический список сервисов в skill.
3. Проверь совместимость до изменения field numbers/types. Для breaking change требуется отдельное принятое решение о версии или миграции.
4. Измени `.proto` и всех затронутых потребителей в одном изменении.
5. Пересобери и протестируй каждый consumer, чтобы выполнить кодогенерацию и wire-проверки.
6. Обнови integration catalog и contract documentation.
7. В отчёте перечисли всех найденных consumers и явно укажи, что не удалось проверить.

Если на NATS path обнаружен JSON, считай это отдельным дефектом и не закрепляй его в новом контракте.
