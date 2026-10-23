-- Категория «Новое в боте» в перечнях схемы (PER-626, ADR-069).
--
-- Новых таблиц нет: сводка выпуска — предмет контракта и поведения процесса,
-- а из схемы она трогает только словарь категорий настройки. Перечни
-- пересоздаются, как у каждой новой категории с PER-213: CHECK нельзя
-- расширить на месте, а пересоздание держит скрипт идемпотентным. Области у
-- значения нет — сводка принадлежит поверхности бота, а не сходке.

ALTER TABLE notification_preference DROP CONSTRAINT IF EXISTS notification_preference_category_known;
ALTER TABLE notification_preference ADD CONSTRAINT notification_preference_category_known CHECK (category IN (
    'meetup_published',
    'meetup_changed',
    'meetup_material',
    'meetup_reminder',
    'organizer_message',
    'community_announcement',
    'access_request',
    'release_notes'
));

ALTER TABLE notification_preference DROP CONSTRAINT IF EXISTS notification_preference_scope;
ALTER TABLE notification_preference ADD CONSTRAINT notification_preference_scope CHECK (
    meetup_id IS NULL OR category NOT IN ('meetup_published', 'community_announcement', 'access_request',
                                           'release_notes')
);
