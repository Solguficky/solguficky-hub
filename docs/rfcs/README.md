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
| [RFC-009](RFC-009-identity-access-data-retention.md) | Retention и жизненный цикл данных доступа Identity | Accepted, [ADR-038](../decisions/ADR-038-identity-hub-access-retention.md); абзац о запрете роли `community` заменён [ADR-043](../decisions/ADR-043-identity-roles-and-community-circles.md) |
| [RFC-010](RFC-010-remote-development-and-self-hosting-platform.md) | Удалённая среда разработки и self-hosting Solguficky | In Review; hosting model принят в ADR-039 |
| [RFC-011](RFC-011-auction-trading-domain-model.md) | Доменная модель торгов аукциона: словарь, правила и инварианты | Accepted, [ADR-047](../decisions/ADR-047-auction-trading-domain-vocabulary-and-event-form.md); открыт только ответ прокси на ask — он контракты не блокирует |
| [RFC-012](RFC-012-testing-strategy-and-agent-qa.md) | Стратегия тестирования: пять уровней, граница гейта и агентский QA | Accepted; третье основание отказа от MTProto заменено [ADR-046](../decisions/ADR-046-telegram-test-contour.md); открыты OTLP у Identity и бота и property-библиотека для Scala |
| [RFC-013](RFC-013-phased-execution-loop-and-gates.md) | Фазовый контур исполнения и гейты решений | Accepted; изменения 1–3 (завершение сессии на сдаче, роли моделей, граница ручного гейта) приняты владельцем 2026-09-21, разнесение фаз по сессиям ждёт прогона PER-282, который выбирает форму запуска между Orca и CAO |

Документы разделены по границе, которую каждый блокирует: RFC-001 — контракт расширения, RFC-002 — продуктовую модель сходки, RFC-003 — форму сообщений бота (механика принята, открыты вклад модуля и настройки), RFC-004 — схему и язык Meetups, RFC-005 — устройство Notifications и границу доставки, RFC-006 — устройство Telegram-края и его состояние, RFC-007 — формат и объём аукциона как события, RFC-008 — доказательство права на maintainer-операцию Identity, RFC-009 — retention допуска к хабу (принято, [ADR-038](../decisions/ADR-038-identity-hub-access-retention.md)), RFC-010 — модель удалённой разработки, self-hosting и восстановления, RFC-011 — словарь торгов аукциона, от которого зависят выбор стека и состав контрактов, RFC-012 — состав уровней тестирования и границу механического гейта, RFC-013 — форму контура исполнения агентов и границу ручного гейта.

Порядок рассмотрения: RFC-004 решён первым, за ним RFC-005, потому что устройство подписок зависит от того, как устроен домен сходки. RFC-011 рассматривается до выбора стека и контрактов аукциона по тому же основанию, что и RFC-004: словарь домена нужен раньше хранилища. Он предлагал снять зависимость от RFC-007, вынеся формат события в конфигурацию сессии; вместе с принятием RFC-011 21.09.2026 это предложение принято, и доменная модель от выбора формата больше не зависит. Сам В-1 остаётся открытым вопросом RFC-007: он выбирает формат мероприятия и форму уведомления перед лотом, а не устройство модели. RFC-001 отложен до появления первого реального модуля.
