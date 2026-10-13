-- Итог жеребьёвки розыгрыша среди участников (PER-620, ADR-066, п. 13).
--
-- Новых таблиц нет: адресаты — владельцы билетов из самого факта Auction, и
-- реплики пула Notifications не ведёт. Расширяются только перечни типа и
-- повода: повод — event_id факта журнала розыгрыша, а не журнала аукциона.

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_known;
ALTER TABLE notification ADD CONSTRAINT notification_type_known CHECK (type IN (
    'meetup_published', 'meetup_changed', 'meetup_material', 'meetup_unpublished',
    'meetup_reminder', 'organizer_message', 'community_announcement', 'lot_outbid',
    'access_requested', 'lot_purchased', 'access_granted', 'preset_granted',
    'lot_proxy_raised', 'circle_changed', 'lot_activity_digest',
    'auction_final_lineup', 'auction_final_started', 'lot_reminder', 'raffle_result'
));

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_cause_kind_known;
ALTER TABLE notification ADD CONSTRAINT notification_cause_kind_known CHECK (
    cause_kind IN ('meetup_event', 'reminder_task', 'command_request', 'auction_lot_event', 'identity_event',
                   'outbid_digest', 'auction_event', 'auction_raffle_event')
);
