-- Напоминание о сходке (PER-364): сработавшее задание разворачивается на
-- подписчиков адресными фактами meetup_reminder — ветка oneof типа в
-- contracts/proto/notifications/v1/notifications.proto.
--
-- Ограничение пересоздаётся, как в 009: CHECK нельзя расширить на месте, а
-- DROP IF EXISTS перед ADD держит скрипт идемпотентным. Вид повода
-- reminder_task схема допускала с 008, поэтому трогать приходится только тип.
--
-- Ключ повода (type, cause_kind, cause_id, recipient_id) держит и напоминание:
-- cause_id — идентификатор задания, повтор срабатывания даёт тот же ключ, и
-- второго факта нет. Перенос создаёт новое задание, а с ним законно и новый
-- ключ: перенос после отправленного напоминания обязан напомнить снова.

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_known;

ALTER TABLE notification ADD CONSTRAINT notification_type_known CHECK (type IN (
    'meetup_published',
    'meetup_changed',
    'meetup_material',
    'meetup_unpublished',
    'meetup_reminder'
));
