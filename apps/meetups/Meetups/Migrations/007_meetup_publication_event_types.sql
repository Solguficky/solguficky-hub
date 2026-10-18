ALTER TABLE meetup_events
    DROP CONSTRAINT IF EXISTS meetup_events_type_check;

-- Назначение и отмена запланированной публикации — свои поводы журнала, а не
-- оттенки «сходка изменена»: первое несёт момент, второе очищает поле, и по
-- отдельному имени потребитель отличает их, не разбирая тело события.
ALTER TABLE meetup_events
    ADD CONSTRAINT meetup_events_type_check
    CHECK (event_type IN (
        'meetup_created',
        'meetup_changed',
        'meetup_published',
        'meetup_unpublished',
        'meetup_republished',
        'meetup_publication_scheduled',
        'meetup_publication_cancelled',
        'meetup_cancelled',
        'meetup_held',
        'meetup_material_attached',
        'meetup_material_removed'
    ));

-- Отменённая сходка не оставляет запланированной публикации: поле очищает
-- применение события, а ограничение держит то же свойство строки независимо от
-- кода — так же, как видимая строка не может остаться с моментом.
-- DROP IF EXISTS, а не безусловное добавление: миграции обязаны переживать повтор
-- без журнала, и повторное добавление ограничения упало бы на нём.
ALTER TABLE meetups
    DROP CONSTRAINT IF EXISTS meetups_scheduled_publish_not_cancelled;

ALTER TABLE meetups
    ADD CONSTRAINT meetups_scheduled_publish_not_cancelled
    CHECK (scheduled_publish_at IS NULL OR lifecycle <> 'cancelled');
