-- Ведение лота вернулось новому лидеру: администратор снял участника, который
-- вёл лот (ADR-072, п. 5, PER-672). Тип добавлен к известным, иначе строка
-- факта нарушила бы ограничение на первом же снятии.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_known;
ALTER TABLE notification ADD CONSTRAINT notification_type_known CHECK (type IN (
    'meetup_published', 'meetup_changed', 'meetup_material', 'meetup_unpublished',
    'meetup_reminder', 'organizer_message', 'community_announcement', 'lot_outbid',
    'access_requested', 'lot_purchased', 'access_granted', 'preset_granted',
    'lot_proxy_raised', 'circle_changed', 'lot_activity_digest',
    'auction_final_lineup', 'auction_final_started', 'lot_reminder', 'raffle_result',
    'prediction_results', 'release_summary', 'auction_cancelled',
    'lot_deadline_close', 'auction_final_lot_next', 'lot_lead_restored'
));
