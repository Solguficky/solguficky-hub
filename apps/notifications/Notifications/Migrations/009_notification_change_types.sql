-- Поводы изменения сходки, нового материала и снятия с публикации (PER-218).
-- Ветки oneof типа в contracts/proto/notifications/v1/notifications.proto,
-- которые порождает event plane сверх «новой сходки» из 008.
--
-- Ограничение пересоздаётся, а не дописывается: CHECK нельзя расширить на
-- месте. Сначала DROP IF EXISTS, потом ADD — так скрипт идемпотентен, и
-- повторное применение ставит то же ограничение заново. Уже записанные строки
-- проходят новое ограничение: оно шире прежнего.
--
-- Ключ повода (type, cause_kind, cause_id, recipient_id) держит и новые типы:
-- повтор события изменения даёт тот же cause_id, и второго факта нет.

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_known;

ALTER TABLE notification ADD CONSTRAINT notification_type_known CHECK (type IN (
    'meetup_published',
    'meetup_changed',
    'meetup_material',
    'meetup_unpublished'
));
