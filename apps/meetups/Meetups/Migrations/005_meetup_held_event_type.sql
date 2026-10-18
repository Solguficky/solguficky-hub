ALTER TABLE meetup_events
    DROP CONSTRAINT meetup_events_type_check;

ALTER TABLE meetup_events
    ADD CONSTRAINT meetup_events_type_check
    CHECK (event_type IN (
        'meetup_created',
        'meetup_changed',
        'meetup_published',
        'meetup_unpublished',
        'meetup_republished',
        'meetup_cancelled',
        'meetup_held'
    ));
