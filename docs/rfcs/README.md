# RFC

RFC используется для обсуждения значимого изменения до принятия решения.

RFC нужен, если изменение:

- имеет несколько содержательных вариантов;
- меняет service boundary или взаимодействие компонентов;
- выбирает язык, платформу или инфраструктурный механизм;
- вводит новый межсервисный контракт;
- создаёт standard, применимый к нескольким частям проекта.

RFC не нужен для локального bugfix или очевидной реализации уже принятого решения.

## Процесс

1. Владелец формулирует проблему, границы и исходный вариант.
2. Агент исследует факты, оппонирует и расширяет список альтернатив.
3. Владелец принимает решение.
4. Результат при необходимости фиксируется ADR, standard или обоими документами.
5. Реализация и прогресс ведутся в Linear.

## Статусы

- `Draft` — черновик владельца;
- `In Review` — идёт обсуждение;
- `Accepted` — предложение принято;
- `Rejected` — отклонено с причиной;
- `Superseded` — заменено последующим RFC.

Новый RFC создаётся по [template.md](template.md).

## Индекс

| RFC | Предложение | Статус |
|---|---|---|
| [RFC-001](RFC-001-meetup-modules-topology.md) | Модули сходки: модель композиции, размещение и транспорт | Draft, рассмотрение отложено |
| [RFC-002](RFC-002-meetup-publication-visibility-materials.md) | Модель сходки: публикация, видимость и материалы | Accepted |
| [RFC-003](RFC-003-bot-presentation-rich-blocks.md) | Представление бота: плоский текст или блоки Rich Messages | Draft, ожидает проверки Bot API |
| [RFC-004](RFC-004-meetups-domain-events-persistence.md) | Дизайн Meetups: домен, события и persistence | Accepted, [ADR-024](../decisions/ADR-024-meetups-state-storage-with-domain-event-log.md); открыт словарь домена |
| [RFC-005](RFC-005-notifications-subscription-scheduling-delivery.md) | Notifications: две плоскости, триггеры и граница доставки | Accepted, [ADR-028](../decisions/ADR-028-notifications-subscriptions-replica-and-delivery-boundary.md) и [ADR-029](../decisions/ADR-029-notifications-orleans-stack.md) |
| [RFC-006](RFC-006-go-protobuf-codegen.md) | Кодогенерация Protobuf для Go: `buf` или `protoc` | In Review, [PER-31](https://linear.app/anticnvm/issue/per-31) |

Документы разделены по границе, которую каждый блокирует: RFC-001 — контракт расширения, RFC-002 — продуктовую модель сходки, RFC-003 — механику Gateway и ревизию макета, RFC-004 — схему и язык Meetups, RFC-005 — устройство Notifications и границу доставки, RFC-006 — команду генерации Go-кода из `contracts/proto`.

Порядок рассмотрения: RFC-004 решён первым, за ним RFC-005, потому что устройство подписок зависит от того, как устроен домен сходки. RFC-006 закрывает открытый выбор из [ADR-027](../decisions/ADR-027-identity-go-stack.md) до первого контракта Identity. RFC-001 отложен до появления первого реального модуля.
