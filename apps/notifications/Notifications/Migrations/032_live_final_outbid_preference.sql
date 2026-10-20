-- Выключатель перебитий в живом финале аукциона (PER-645): «перебили» и ответ
-- своей автоставки на лоте живого финала.
--
-- Это настройка уведомлений аукциона рядом с частотой перебитий
-- (outbid_preference): в живом финале частота не действует, решает этот
-- выключатель. Нет строки — действует умолчание «не присылать», поэтому
-- строки появляются только у тех, кто выключатель трогал.
CREATE TABLE IF NOT EXISTS live_final_outbid_preference
(
    identity_id uuid        NOT NULL,
    enabled     boolean     NOT NULL,
    updated_at  timestamptz NOT NULL,

    CONSTRAINT live_final_outbid_preference_pkey PRIMARY KEY (identity_id)
);
