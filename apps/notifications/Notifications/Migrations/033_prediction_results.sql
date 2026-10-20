-- Итоги прогнозов аукциона сделавшим прогноз (PER-567, ADR-067, п. 9).
--
-- Новых таблиц нет: адресаты — участники из самого факта Auction, как
-- владельцы билетов розыгрыша. Расширяются только перечни типа и повода:
-- повод — event_id факта журнала итогов, а не журнала аукциона.

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_known;
ALTER TABLE notification ADD CONSTRAINT notification_type_known CHECK (type IN (
    'meetup_published', 'meetup_changed', 'meetup_material', 'meetup_unpublished',
    'meetup_reminder', 'organizer_message', 'community_announcement', 'lot_outbid',
    'access_requested', 'lot_purchased', 'access_granted', 'preset_granted',
    'lot_proxy_raised', 'circle_changed', 'lot_activity_digest',
    'auction_final_lineup', 'auction_final_started', 'lot_reminder', 'raffle_result',
    'prediction_results'
));

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_cause_kind_known;
ALTER TABLE notification ADD CONSTRAINT notification_cause_kind_known CHECK (
    cause_kind IN ('meetup_event', 'reminder_task', 'command_request', 'auction_lot_event', 'identity_event',
                   'outbid_digest', 'auction_event', 'auction_raffle_event', 'auction_prediction_results_event')
);
