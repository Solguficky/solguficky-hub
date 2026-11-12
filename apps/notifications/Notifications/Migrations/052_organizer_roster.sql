-- Вести о составе организаторов сходки: назначенному и снятому другим (PER-746,
-- ADR-076, п. 8). Типы добавлены к известным, старый образ после отката читает
-- прежний набор.
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
    'invoice_reminder', 'invoice_due_reminder', 'lot_set_collected',
    'auction_notice', 'step_window_announced',
    'auction_prebidding_ended', 'auction_lot_sold_in_final',
    'organizer_appointed', 'organizer_dismissed'
));
