-- Две категории заявок вместо одной (PER-635, ADR-062).
--
-- «Не присылать запросы доступа» выключало заявки обеих очередей сразу, а
-- подпись об этом не говорила. Теперь у каждой очереди своя категория, и
-- сохранённое выключение переносится на обе: кто выключил общую, тот выключал
-- и ту, и другую. Новых таблиц нет — меняются только перечни категорий в
-- ограничениях и строки людей, у которых общая настройка была сохранена.

-- Шаг 1. Старый и два новых ключа одновременно: строки с прежним ключом ещё
-- лежат в таблице, и CHECK, отвергающий его сразу, не дал бы себя создать.
ALTER TABLE notification_preference DROP CONSTRAINT IF EXISTS notification_preference_category_known;
ALTER TABLE notification_preference ADD CONSTRAINT notification_preference_category_known CHECK (category IN (
    'meetup_published',
    'meetup_changed',
    'meetup_material',
    'meetup_reminder',
    'organizer_message',
    'community_announcement',
    'access_request',
    'access_request_community',
    'access_request_auction',
    'release_notes'
));

-- Шаг 2. Веер: строка прежнего ключа становится двумя, с тем же значением и
-- моментом. Повтор строки гасит тот же уникальный индекс, что держит одну
-- глобальную настройку категории на человека.
INSERT INTO notification_preference (identity_id, meetup_id, category, enabled, updated_at)
SELECT identity_id, NULL, 'access_request_community', enabled, updated_at
FROM notification_preference
WHERE category = 'access_request'
ON CONFLICT DO NOTHING;

INSERT INTO notification_preference (identity_id, meetup_id, category, enabled, updated_at)
SELECT identity_id, NULL, 'access_request_auction', enabled, updated_at
FROM notification_preference
WHERE category = 'access_request'
ON CONFLICT DO NOTHING;

-- Шаг 3. Прежний ключ уходит: значение перенесено, а контракт больше такого
-- значения не знает.
DELETE FROM notification_preference
WHERE category = 'access_request';

ALTER TABLE notification_preference DROP CONSTRAINT IF EXISTS notification_preference_category_known;
ALTER TABLE notification_preference ADD CONSTRAINT notification_preference_category_known CHECK (category IN (
    'meetup_published',
    'meetup_changed',
    'meetup_material',
    'meetup_reminder',
    'organizer_message',
    'community_announcement',
    'access_request_community',
    'access_request_auction',
    'release_notes'
));

-- Обе новые категории только глобальные, как и прежняя: очередей заявок две, а
-- сходки у них нет.
ALTER TABLE notification_preference DROP CONSTRAINT IF EXISTS notification_preference_scope;
ALTER TABLE notification_preference ADD CONSTRAINT notification_preference_scope CHECK (
    meetup_id IS NULL OR category NOT IN ('meetup_published', 'community_announcement',
                                           'access_request_community', 'access_request_auction',
                                           'release_notes')
);
