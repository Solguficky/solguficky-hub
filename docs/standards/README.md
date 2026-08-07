# Standards

Standards — канонические нормативы для реализации и code review. Они отвечают на вопрос «как в этом проекте обязательно делать», но не хранят историю выбора.

## Действующие документы

| Документ | Scope |
|---|---|
| [contracts/protobuf.md](contracts/protobuf.md) | Protobuf, совместимость схем и изменение потребителей |
| [testing/testing-strategy.md](testing/testing-strategy.md) | выбор уровня и обязательные свойства тестов |
| [observability/logging.md](observability/logging.md) | структурные логи, correlation и privacy |

Новый документ создаётся по [template.md](template.md).

## Границы

- Общее правило для нескольких сервисов или языков живёт здесь.
- Языковой standard создаётся только после появления повторяемой практики в реальном коде.
- Уникальный инвариант сервиса остаётся в его `AGENTS.md` или service brief.
- Обоснование выбора хранится в RFC/ADR; standard содержит действующий итог.
- Skill ссылается на standard и задаёт workflow, но не копирует норматив целиком.
