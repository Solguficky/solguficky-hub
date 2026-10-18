-- Адресный повод аукциона: без реплики лота, event_id и outbox одной транзакцией.
ALTER TABLE consumed_event DROP CONSTRAINT IF EXISTS consumed_event_source_known;
ALTER TABLE consumed_event ADD CONSTRAINT consumed_event_source_known
    CHECK (source IN ('meetups', 'identity', 'auction'));

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_known;
ALTER TABLE notification ADD CONSTRAINT notification_type_known CHECK (type IN (
    'meetup_published', 'meetup_changed', 'meetup_material', 'meetup_unpublished',
    'meetup_reminder', 'organizer_message', 'community_announcement', 'lot_outbid'
));

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_cause_kind_known;
ALTER TABLE notification ADD CONSTRAINT notification_cause_kind_known CHECK (
    cause_kind IN ('meetup_event', 'reminder_task', 'command_request', 'auction_lot_event')
);
