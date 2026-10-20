-- Выпуск «Что нового» как данные среды (PER-628, ADR-069, п. 2–4).
--
-- Три таблицы, а не одна: признак «поверхность уже принималась» хранится
-- отдельно от записей (п. 3), чтобы пустой первый набор не превращал следующую
-- запись во второй «первый приём». Текста записей здесь нет — он живёт в
-- образе бота, а сервис помнит только идентификаторы.

-- Поверхность бота, хотя бы раз передавшая набор. Строка — и признак первого
-- приёма, и последний набор, и момент следующей сводки. Момент лежит строкой,
-- а не таймером процесса: час, пропущенный за простой, подбирает первый проход
-- после подъёма, как окна сводки перебитий.
CREATE TABLE IF NOT EXISTS release_surface
(
    surface           text        NOT NULL,
    first_reported_at timestamptz NOT NULL,
    reported_at       timestamptz NOT NULL,

    -- Последний набор в порядке образа. Сводка объявляет только записи из него:
    -- откат образа убирает запись из набора, и она ждёт выкладки, где снова есть.
    record_ids        text[]      NOT NULL,
    next_summary_at   timestamptz NOT NULL,

    CONSTRAINT release_surface_pkey PRIMARY KEY (surface),
    CONSTRAINT release_surface_known CHECK (surface IN ('hub', 'auction'))
);

-- Выборка прохода: поверхности с наступившим часом.
CREATE INDEX IF NOT EXISTS release_surface_due ON release_surface (next_summary_at);

-- Сводка: записи одного дня поверхности. Не переписывается, поэтому соседей
-- сводки чтение вычисляет, а не хранит.
CREATE TABLE IF NOT EXISTS release_summary
(
    summary_id    uuid        NOT NULL,
    surface       text        NOT NULL,
    summarized_at timestamptz NOT NULL,
    record_ids    text[]      NOT NULL,

    CONSTRAINT release_summary_pkey PRIMARY KEY (summary_id),
    CONSTRAINT release_summary_surface_fkey FOREIGN KEY (surface) REFERENCES release_surface (surface),
    CONSTRAINT release_summary_not_empty CHECK (cardinality(record_ids) > 0)
);

-- Листание поверхности: UUIDv7 растёт со временем, и порядок ключа — порядок сводок.
CREATE INDEX IF NOT EXISTS release_summary_surface ON release_summary (surface, summary_id);

-- Запись по паре «поверхность, идентификатор»: когда впервые увидена и
-- объявлена ли. Объявленная без сводки — набор первого приёма: announced_at
-- есть, summary_id нет.
CREATE TABLE IF NOT EXISTS release_record
(
    surface       text        NOT NULL,
    record_id     text        NOT NULL,
    first_seen_at timestamptz NOT NULL,

    -- Место в наборе, где запись увидена впервые: записи одного отчёта делят
    -- момент, и сводка держит их в порядке образа.
    seen_position integer     NOT NULL,
    announced_at  timestamptz,
    summary_id    uuid,

    CONSTRAINT release_record_pkey PRIMARY KEY (surface, record_id),
    CONSTRAINT release_record_surface_fkey FOREIGN KEY (surface) REFERENCES release_surface (surface),
    CONSTRAINT release_record_summary_fkey FOREIGN KEY (summary_id) REFERENCES release_summary (summary_id),
    CONSTRAINT release_record_summary_announced CHECK (summary_id IS NULL OR announced_at IS NOT NULL)
);

-- Сводка собирает только необъявленные записи поверхности.
CREATE INDEX IF NOT EXISTS release_record_pending ON release_record (surface) WHERE announced_at IS NULL;

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_known;
ALTER TABLE notification ADD CONSTRAINT notification_type_known CHECK (type IN (
    'meetup_published', 'meetup_changed', 'meetup_material', 'meetup_unpublished',
    'meetup_reminder', 'organizer_message', 'community_announcement', 'lot_outbid',
    'access_requested', 'lot_purchased', 'access_granted', 'preset_granted',
    'lot_proxy_raised', 'circle_changed', 'lot_activity_digest',
    'auction_final_lineup', 'auction_final_started', 'lot_reminder', 'raffle_result',
    'prediction_results', 'release_summary'
));

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_cause_kind_known;
ALTER TABLE notification ADD CONSTRAINT notification_cause_kind_known CHECK (
    cause_kind IN ('meetup_event', 'reminder_task', 'command_request', 'auction_lot_event', 'identity_event',
                   'outbid_digest', 'auction_event', 'auction_raffle_event', 'auction_prediction_results_event',
                   'release_summary')
);
