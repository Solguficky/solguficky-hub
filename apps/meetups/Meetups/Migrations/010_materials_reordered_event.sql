-- Новый повод сохраняет полный снимок с новым порядком материалов.
-- DROP IF EXISTS позволяет применить миграцию повторно без журнала DbUp.
ALTER TABLE meetup_events
    DROP CONSTRAINT IF EXISTS meetup_events_type_check;

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
        'meetup_material_removed',
        'materials_reordered'
    ));
