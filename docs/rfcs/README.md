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
| [RFC-003](RFC-003-bot-presentation-rich-blocks.md) | Представление бота: плоский текст или блоки Rich Messages | Accepted, [ADR-034](../decisions/ADR-034-telegram-bot-rich-presentation.md); открыты контракт модуля и экран настроек |
| [RFC-004](RFC-004-meetups-domain-events-persistence.md) | Дизайн Meetups: домен, события и persistence | Accepted, [ADR-024](../decisions/ADR-024-meetups-state-storage-with-domain-event-log.md); открыт словарь домена |
| [RFC-005](RFC-005-notifications-subscription-scheduling-delivery.md) | Notifications: две плоскости, триггеры и граница доставки | Accepted, [ADR-028](../decisions/ADR-028-notifications-subscriptions-replica-and-delivery-boundary.md) и [ADR-029](../decisions/ADR-029-notifications-orleans-stack.md) |
| [RFC-006](RFC-006-telegram-bot-edge-design.md) | Telegram-бот: граница представления, состояние экрана и идемпотентность | Accepted, [ADR-030](../decisions/ADR-030-telegram-bot.md) |
| [RFC-007](RFC-007-auction-scope-and-format-options.md) | Аукцион: формат события, объём первого запуска и реестр обещаний | Draft, ожидает ответа админа; связанный материал — страница обсуждения [«Аукцион 2026»](../published/auction-2026/index.html) по адресу `/auction-2026` |
| [RFC-008](RFC-008-identity-service-endpoint-auth.md) | Аутентификация служебного endpoint Identity | Accepted, [ADR-037](../decisions/ADR-037-identity-maintainer-shared-secret.md) |
| [RFC-009](RFC-009-identity-access-data-retention.md) | Retention и жизненный цикл данных доступа Identity | In Review |

Документы разделены по границе, которую каждый блокирует: RFC-001 — контракт расширения, RFC-002 — продуктовую модель сходки, RFC-003 — форму сообщений бота (механика принята, открыты вклад модуля и настройки), RFC-004 — схему и язык Meetups, RFC-005 — устройство Notifications и границу доставки, RFC-006 — устройство Telegram-края и его состояние, RFC-007 — формат и объём аукциона как события, RFC-008 — доказательство права на maintainer-операцию Identity, RFC-009 — срок жизни whitelist, закрытого профиля и журнала доступа; инвайт-токены хаба в срезе отложены.

Порядок рассмотрения: RFC-004 решён первым, за ним RFC-005, потому что устройство подписок зависит от того, как устроен домен сходки. RFC-001 отложен до появления первого реального модуля.
