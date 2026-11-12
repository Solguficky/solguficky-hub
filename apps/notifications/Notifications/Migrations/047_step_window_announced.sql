-- Общая весть о начале окна сниженного шага (PER-766, ADR-047, дополнение
-- 2026-10-27): держателям права ставок, кроме следящих за лотом окна. Задание
-- и его ключ те же, что у вести следящим (038): тип свой, поэтому две вести
-- одного задания на ключе повода не совпадают. Новых колонок нет — тип
-- добавлен к известным.
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
    'auction_notice', 'step_window_announced'
));
