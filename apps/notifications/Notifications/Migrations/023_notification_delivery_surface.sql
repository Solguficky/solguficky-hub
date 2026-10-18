-- Канал доставки фиксируется вместе с адресным фактом. До этого релей
-- публиковал все факты на один subject, а выбранный бот выводился из типа.
-- Старый outbox не сохранял круг на момент события. Для ожидающих строк
-- используем доступный снимок реплики; без него аукционный факт сохраняет
-- прежний маршрут в Auction.
ALTER TABLE notification ADD COLUMN IF NOT EXISTS delivery_surface text NULL;

UPDATE notification AS n
SET delivery_surface = CASE
    WHEN person.role = 'guest' THEN 'auction'
    WHEN person.identity_id IS NOT NULL THEN 'hub'
    WHEN n.type IN ('lot_outbid', 'lot_proxy_raised', 'lot_purchased') THEN 'auction'
    ELSE 'hub'
END
FROM (SELECT identity_id, role FROM identity_replica) AS person
WHERE n.delivery_surface IS NULL
    AND person.identity_id = n.recipient_id;

UPDATE notification
SET delivery_surface = CASE
    WHEN type IN ('lot_outbid', 'lot_proxy_raised', 'lot_purchased') THEN 'auction'
    ELSE 'hub'
END
WHERE delivery_surface IS NULL;

ALTER TABLE notification ALTER COLUMN delivery_surface SET DEFAULT 'hub';
ALTER TABLE notification ALTER COLUMN delivery_surface SET NOT NULL;

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_delivery_surface_known;
ALTER TABLE notification ADD CONSTRAINT notification_delivery_surface_known CHECK (
    delivery_surface IN ('hub', 'auction')
);

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_known;
ALTER TABLE notification ADD CONSTRAINT notification_type_known CHECK (type IN (
    'meetup_published', 'meetup_changed', 'meetup_material', 'meetup_unpublished',
    'meetup_reminder', 'organizer_message', 'community_announcement', 'lot_outbid',
    'access_requested', 'lot_purchased', 'access_granted', 'role_granted',
    'lot_proxy_raised', 'circle_changed'
));
