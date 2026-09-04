# Standards

Standards — канонические нормативы для реализации и code review. Они отвечают на вопрос «как в этом проекте обязательно делать», но не хранят историю выбора.

## Действующие документы

| Документ | Scope |
|---|---|
| [contracts/protobuf.md](contracts/protobuf.md) | Protobuf, совместимость схем и изменение потребителей |
| [testing/testing-strategy.md](testing/testing-strategy.md) | выбор уровня и обязательные свойства тестов |
| [testing/fsharp.md](testing/fsharp.md) | инструменты и проверяемые свойства F#-тестов |
| [languages/fsharp.md](languages/fsharp.md) | типы, эффекты, ошибки, interop и порядок компиляции F# |
| [architecture/functional-slices.md](architecture/functional-slices.md) | устройство F#-приложения из срезов: чистое ядро, зависимости, error flow, границы |
| [observability/logging.md](observability/logging.md) | каркас полей структурной записи, correlation и privacy |
| [git/branching.md](git/branching.md) | база ветвления, имя ветки, параллельные рабочие деревья, заголовок и тело pull request |
| [git/commit-messages.md](git/commit-messages.md) | формат сообщения коммита |
| [backlog/linear.md](backlog/linear.md) | структура бэклога, метки, оценки и форма задачи |

Новый документ создаётся по [template.md](template.md).

## Границы

- Общее правило для нескольких сервисов или языков живёт здесь.
- Языковой standard обычно создаётся после появления повторяемой практики в реальном коде. До первой реализации допускается узкий design-led standard, если владелец явно выбрал подход, а правила проверяемы и не подменяют открытые решения.
- Уникальный инвариант сервиса остаётся в его `AGENTS.md` или service brief.
- Обоснование выбора хранится в RFC/ADR; standard содержит действующий итог.
- Skill ссылается на standard и задаёт workflow, но не копирует норматив целиком.
