-- Сообщение лидеру о том, что его автоставка ответила чужой команде и подняла
-- цену лота (PER-473). Повод — то же событие Auction bid_placed, что у
-- lot_outbid, поэтому одно событие даёт до двух фактов: перебитому и лидеру.
-- Их различает тип в notification_cause_once_per_recipient, новой
-- уникальности не нужно.
--
-- Ограничение пересоздаётся, как в 014, 015, 017 и 018: CHECK нельзя расширить
-- на месте, а пересоздание держит скрипт идемпотентным.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_known;
ALTER TABLE notification ADD CONSTRAINT notification_type_known CHECK (type IN (
    'meetup_published', 'meetup_changed', 'meetup_material', 'meetup_unpublished',
    'meetup_reminder', 'organizer_message', 'community_announcement', 'lot_outbid',
    'access_requested', 'lot_purchased', 'access_granted', 'role_granted',
    'lot_proxy_raised'
));
