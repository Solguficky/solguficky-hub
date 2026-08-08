# Notifications Service

> **Слой:** Current / MVP candidate. **Current stack:** C#. **Reminder design и scheduling placement:** Open.

## Current

Сервис существует как каркас маршрутизации событий в уведомления, но единственный содержательный сценарий связан с аукционом.

`BidPlacedHandler`:

- обрабатывает `BidPlacedEvent`;
- формирует `SendMessageCommand`;
- временно предполагает `user_id == chat_id`;
- не реализует напоминания о сходках;
- не решает scheduling, durable delivery и дедупликацию side effects.

Каркас можно оставить на C#, но пригодность структуры должна подтверждаться первым реальным reminder-сценарием.

## MVP-сценарий

Уведомления солегуфикам, явно подписавшимся на конкретную сходку, — первый реальный сценарий сервиса. Ответ в Telegram-опросе не считается подпиской и не интерпретируется продуктом.

Пользователь должен управлять категориями уведомлений. Изменение основных данных или статуса сходки, появление нового прикреплённого сообщения и приближение времени проведения образуют исходный набор продуктовых потребностей. Точные интервалы, обязательность отдельных категорий, quiet hours, группировка, отмена и изменение времени сходки определяются требованиями. «24 часа» и «2 часа» остаются гипотезой, а не архитектурным принципом. Ownership самой подписки между Meetups и Notifications пока Open.

## Scheduler пока не является сервисом

Сначала нужно определить:

- кто создаёт расписание;
- где хранится pending reminder;
- что происходит при переносе или отмене сходки;
- как переживается restart;
- какая задержка допустима;
- как исключается повторная отправка.

После этого выбирается placement:

1. scheduling внутри Notifications;
2. scheduling внутри Meetups;
3. отдельный Scheduler.

Scheduling внутри Notifications — предпочтительный кандидат, если Notifications владеет жизненным циклом доставки. Отдельный сервис оправдан только несколькими независимыми потребителями общей scheduling capability.

## Три разные задачи надёжности

1. **Scheduling** — когда сообщение готово к обработке.
2. **Durable delivery** — переживает ли готовое сообщение restart consumer.
3. **Idempotent user-visible side effect** — не получит ли человек два Telegram-сообщения.

JetStream может участвовать во втором пункте и в новых версиях предлагает scheduling-возможности, но не отменяет durable consumer configuration, idempotency key, deduplication storage, outbox/inbox и Telegram API retry. Текущий NATS 2.10 нельзя проектировать как более новую версию без отдельного upgrade decision.

## Свидетельства и ссылки

- Current handler: `services/notifications-service/src/NotificationsService/Handlers/BidPlacedHandler.cs`
- [NATS JetStream schedules](https://docs.nats.io/nats-concepts/jetstream/headers)
