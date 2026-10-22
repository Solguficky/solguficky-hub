-- Личное сообщение собравшему коллекционный сет (ADR-073, п. 7; PER-687).
-- Повод — event_id факта журнала аукциона, собравший — единственный адресат.
-- Новых таблиц и cause kind нет: дедупликацию по событию дополняет постоянный
-- ключ причины (тип, auction_event, event_id, recipient_id).

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_known;
ALTER TABLE notification ADD CONSTRAINT notification_type_known CHECK (type IN (
    'meetup_published', 'meetup_changed', 'meetup_material', 'meetup_unpublished',
    'meetup_reminder', 'organizer_message', 'community_announcement', 'lot_outbid',
    'access_requested', 'lot_purchased', 'access_granted', 'preset_granted',
    'lot_proxy_raised', 'circle_changed', 'lot_activity_digest',
    'auction_final_lineup', 'auction_final_started', 'lot_reminder', 'raffle_result',
    'prediction_results', 'release_summary', 'auction_cancelled',
    'lot_deadline_close', 'auction_final_lot_next', 'step_window_started',
    'lot_lead_restored', 'auction_published', 'auction_trading_opened',
    'lot_set_collected'
));
