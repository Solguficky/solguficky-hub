-- Выключатель вестей о новом аукционе и открытии торгов (PER-646): «Новый
-- аукцион» по публикации аукциона сходки и «Торги открыты» по открытию
-- онлайн-недели.
--
-- Это настройка уведомлений аукциона рядом с частотой перебитий и анонсом
-- финала: аукционной категории в общих настройках нет (PER-539, RFC-015 О-12), и
-- экран у неё тот же. Нет строки — действует умолчание «присылать», поэтому
-- строки появляются только у тех, кто выключатель трогал.
CREATE TABLE IF NOT EXISTS auction_announcement_preference
(
    identity_id uuid        NOT NULL,
    enabled     boolean     NOT NULL,
    updated_at  timestamptz NOT NULL,

    CONSTRAINT auction_announcement_preference_pkey PRIMARY KEY (identity_id)
);

-- Снятие неотправленной вести о новом аукционе: аукцион сняли с публикации до
-- того, как релей вынес весть в шину (PER-646). Причина встаёт рядом с прежними,
-- и проверка остаётся одна на колонку.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_withdrawal_reason_known;
ALTER TABLE notification ADD CONSTRAINT notification_withdrawal_reason_known CHECK (
    withdrawal_reason IN ('meetup_cancelled', 'expired', 'application_closed', 'auction_hidden')
);

-- Типы вестей добавлены к известным, иначе первая же публикация аукциона
-- нарушила бы ограничение на типе.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_known;
ALTER TABLE notification ADD CONSTRAINT notification_type_known CHECK (type IN (
    'meetup_published', 'meetup_changed', 'meetup_material', 'meetup_unpublished',
    'meetup_reminder', 'organizer_message', 'community_announcement', 'lot_outbid',
    'access_requested', 'lot_purchased', 'access_granted', 'preset_granted',
    'lot_proxy_raised', 'circle_changed', 'lot_activity_digest',
    'auction_final_lineup', 'auction_final_started', 'lot_reminder', 'raffle_result',
    'prediction_results', 'release_summary', 'auction_cancelled',
    'lot_deadline_close', 'auction_final_lot_next', 'step_window_started',
    'lot_lead_restored', 'auction_published', 'auction_trading_opened'
));
