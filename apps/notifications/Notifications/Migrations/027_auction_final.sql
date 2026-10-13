-- Анонс состава и старта финала (PER-477).
--
-- Круг анонса — те, кто хоть раз стал лидером лота аукциона в bid_placed.
-- Прокси-лимит приватен и на шину не выходит, поэтому держатель лимита без
-- единой ставки сюда не попадает: это решение владельца, а не упущение.
-- Строка — факт участия, а не ставка: повтор и следующая ставка её не множат.
CREATE TABLE IF NOT EXISTS auction_bidder
(
    auction_id uuid        NOT NULL,
    bidder_id  uuid        NOT NULL,
    first_at   timestamptz NOT NULL,

    CONSTRAINT auction_bidder_pkey PRIMARY KEY (auction_id, bidder_id)
);

-- Лидер и цена лота на момент удержания для финала. Отдельно от lot_replica:
-- реплику двигает версия, и удержание, пришедшее после более нового факта
-- лота, в неё не попадает, а анонсу состава нужен именно снимок удержания.
-- Лот удерживается один раз, поэтому первая запись и есть ответ.
CREATE TABLE IF NOT EXISTS lot_hold
(
    lot_id             uuid        NOT NULL,
    auction_id         uuid        NOT NULL,
    leader_id          uuid        NULL,
    price_minor_units  bigint      NOT NULL,
    price_currency     text        NOT NULL,
    held_at            timestamptz NOT NULL,

    CONSTRAINT lot_hold_pkey PRIMARY KEY (lot_id)
);

-- Чистка по концу аукциона идёт по нему.
CREATE INDEX IF NOT EXISTS lot_hold_auction ON lot_hold (auction_id);

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_known;
ALTER TABLE notification ADD CONSTRAINT notification_type_known CHECK (type IN (
    'meetup_published', 'meetup_changed', 'meetup_material', 'meetup_unpublished',
    'meetup_reminder', 'organizer_message', 'community_announcement', 'lot_outbid',
    'access_requested', 'lot_purchased', 'access_granted', 'preset_granted',
    'lot_proxy_raised', 'circle_changed', 'lot_activity_digest',
    'auction_final_lineup', 'auction_final_started'
));

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_cause_kind_known;
ALTER TABLE notification ADD CONSTRAINT notification_cause_kind_known CHECK (
    cause_kind IN ('meetup_event', 'reminder_task', 'command_request', 'auction_lot_event', 'identity_event',
                   'outbid_digest', 'auction_event')
);
