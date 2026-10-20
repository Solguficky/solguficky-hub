-- «Перебили в финале» (PER-645): живой финал, рядом с частотой перебитий
-- и выключателем анонса. Не категория. Нет строки — «выключено», поэтому
-- строки появляются только у тех, кто выключатель трогал.
CREATE TABLE IF NOT EXISTS final_outbid_preference
(
    identity_id uuid        NOT NULL,
    enabled     boolean     NOT NULL,
    updated_at  timestamptz NOT NULL,

    CONSTRAINT final_outbid_preference_pkey PRIMARY KEY (identity_id)
);
