-- Настройка перебитий участника и окно частоты (PER-514).
--
-- Настройка — не категория: lot_outbid адресован самим фактом аукциона и
-- подписки не требует, а положений у настройки больше двух. Нет строки —
-- действует умолчание «о каждом», поэтому строки появляются только у тех, кто
-- настройку менял.
CREATE TABLE IF NOT EXISTS outbid_preference
(
    identity_id uuid        NOT NULL,
    frequency   text        NOT NULL,
    updated_at  timestamptz NOT NULL,

    CONSTRAINT outbid_preference_pkey PRIMARY KEY (identity_id),

    CONSTRAINT outbid_preference_frequency_known CHECK (frequency IN (
        'every', 'at_most_every_5_minutes', 'at_most_every_15_minutes', 'at_most_every_60_minutes', 'off'
    ))
);

-- Открытое окно частоты по лоту и участнику. Окно открывает первое перебитие
-- и закрывается через интервал настройки; одно сообщение уходит при закрытии,
-- если участник к этому моменту всё ещё перебит. Закрытое окно удаляется, а не
-- копится историей: что было отправлено, записано в notification.
--
-- Источник момента — эта строка, а не таймер процесса: окно, наступившее за
-- время простоя, подбирает первый проход после подъёма.
CREATE TABLE IF NOT EXISTS outbid_window
(
    lot_id            uuid        NOT NULL,
    recipient_id      uuid        NOT NULL,
    opened_at         timestamptz NOT NULL,
    due_at            timestamptz NOT NULL,

    -- Перебит ли участник по последней применённой ставке лота: лидер не он.
    -- Возврат лидерства снимает отметку, но окно не закрывает: иначе следующее
    -- перебитие открыло бы новое окно, и сообщения шли бы чаще интервала.
    outbid            boolean     NOT NULL,

    -- Последняя применённая ставка лота — любого участника, а не только
    -- перебития этого: на закрытии сообщение несёт актуальную цену. Версия
    -- держит переупорядочивание, пока окно открыто: старшая ставка не
    -- перетирается младшей, пришедшей позже. До открытия и после закрытия
    -- строки нет, и запоздавшее перебитие открывает окно, как у режима
    -- «о каждом» оно дало бы сообщение: версия повод не отсекает.
    last_event_id     uuid        NOT NULL,
    last_version      bigint      NOT NULL,
    price_minor_units bigint      NOT NULL,
    price_currency    text        NOT NULL,

    CONSTRAINT outbid_window_pkey PRIMARY KEY (lot_id, recipient_id)
);

-- Выборка прохода: наступившие окна.
CREATE INDEX IF NOT EXISTS outbid_window_due ON outbid_window (due_at);
