-- Избранное до конца аукциона и извещение об отмене (PER-604, ADR-063,
-- дополнение 2026-10-12; ADR-047, дополнение 2026-10-12, «Факт отмены»).
--
-- Реплика лота получает аукцион из снимка LotState: конец аукциона чистит
-- реплики и отметки его лотов по нему. Реплика, записанная до этой миграции,
-- получает аукцион со следующим фактом лота; к которой факт не придёт, уходит
-- по прежнему правилу 30 дней после конечного положения. Цена продажи нужна
-- извещению об отмене: покупатель видит в нём свои покупки с ценой, а Auction
-- после чистки не спрашивают.
ALTER TABLE lot_replica ADD COLUMN IF NOT EXISTS auction_id uuid NULL;
ALTER TABLE lot_replica ADD COLUMN IF NOT EXISTS sale_minor_units bigint NULL;
ALTER TABLE lot_replica ADD COLUMN IF NOT EXISTS sale_currency text NULL;

ALTER TABLE lot_replica DROP CONSTRAINT IF EXISTS lot_replica_sale_price;
ALTER TABLE lot_replica ADD CONSTRAINT lot_replica_sale_price CHECK (
    (sale_minor_units IS NULL) = (sale_currency IS NULL)
    AND (sale_minor_units IS NULL OR status = 'sold')
);

-- Чистка по концу аукциона.
CREATE INDEX IF NOT EXISTS lot_replica_auction ON lot_replica (auction_id)
    WHERE auction_id IS NOT NULL;

-- Аукцион пришёл в конечное положение: finished или cancelled. Факт лота
-- такого аукциона ни реплику, ни отметку не создаёт, и старый факт из шины
-- их не воскресит. Удалённый до торгов аукцион строки не получает: он
-- рождается заново под тем же auction_id, и строка закрыла бы новое рождение.
--
-- event_id и meetup_id отмены нужны позднему bid_placed: его лидер получает
-- то же извещение с тем же поводом, и ключ (тип, повод, получатель) гасит
-- его у уже извещённого. Строка живёт горизонт Notifications:Dispatch:Retention
-- от записи — дольше хранения стрима AUCTION_EVENTS.
CREATE TABLE IF NOT EXISTS auction_ended
(
    auction_id  uuid        NOT NULL,
    outcome     text        NOT NULL,
    event_id    uuid        NOT NULL,
    meetup_id   uuid        NOT NULL,
    recorded_at timestamptz NOT NULL,

    CONSTRAINT auction_ended_pkey PRIMARY KEY (auction_id),

    CONSTRAINT auction_ended_outcome_known CHECK (outcome IN ('finished', 'cancelled'))
);

-- Выборка чистки по сроку.
CREATE INDEX IF NOT EXISTS auction_ended_recorded_at ON auction_ended (recorded_at);

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_known;
ALTER TABLE notification ADD CONSTRAINT notification_type_known CHECK (type IN (
    'meetup_published', 'meetup_changed', 'meetup_material', 'meetup_unpublished',
    'meetup_reminder', 'organizer_message', 'community_announcement', 'lot_outbid',
    'access_requested', 'lot_purchased', 'access_granted', 'preset_granted',
    'lot_proxy_raised', 'circle_changed', 'lot_activity_digest',
    'auction_final_lineup', 'auction_final_started', 'lot_reminder', 'raffle_result',
    'prediction_results', 'release_summary', 'auction_cancelled'
));
