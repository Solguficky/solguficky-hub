-- Выключатель анонса финала аукциона (PER-539): состав и старт финала.
--
-- Это настройка уведомлений аукциона рядом с частотой перебитий
-- (outbid_preference), а не категория: анонс адресован самим фактом аукциона и
-- подписки не требует. Нет строки — действует умолчание «присылать», поэтому
-- строки появляются только у тех, кто выключатель трогал.
CREATE TABLE IF NOT EXISTS final_announcement_preference
(
    identity_id uuid        NOT NULL,
    enabled     boolean     NOT NULL,
    updated_at  timestamptz NOT NULL,

    CONSTRAINT final_announcement_preference_pkey PRIMARY KEY (identity_id)
);
