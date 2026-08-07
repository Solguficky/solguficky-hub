# Continuous Integration

> **Статус:** Current, verification pending. Workflow существует, но успешный удалённый прогон после последних изменений не подтверждён.

Current workflow: `.github/workflows/ci.yml`.

Известные gaps:

- workflow устанавливает .NET 8 для сервисов, переведённых на net10;
- изменение `contracts/proto/` должно проверять всех producers и consumers, а не только проекты, выбранные обычными path filters;
- оставленные Legacy-сервисы должны продолжать собираться до согласованного удаления;
- Aspire AppHost требует отдельного restore/build/smoke-test gate;
- compatibility check Protobuf ещё не внедрён.

Целевой минимум для документационных и контрактных изменений:

1. Markdown links не содержат битых активных относительных ссылок.
2. Protobuf change запускает codegen/build/tests всех потребителей.
3. Breaking changes проверяются выбранным compatibility tooling.
4. Current и оставшийся Legacy код не выпадают из build незаметно.

Конкретные задачи и их прогресс ведутся в Linear.
