-- Сводка перебитий и ответов автоставки (PER-596) вместо окна по лоту.
--
-- Окно теперь одно на человека: его открывает первое перебитие или ответ своей
-- автоставки на любом лоте, а в конце уходит одна сводка lot_activity_digest
-- со строкой на лот и вид — включая лоты, где лидерство уже вернулось.
--
-- Источник момента — строка окна, а не таймер процесса: окно, наступившее за
-- время простоя, подбирает первый проход после подъёма. Закрытое окно
-- удаляется вместе со строками, а не копится историей: что было отправлено,
-- записано в notification.
CREATE TABLE IF NOT EXISTS outbid_digest
(
    recipient_id uuid        NOT NULL,

    -- Повод сводки: закрытие окна даёт ровно одну сводку с этим поводом, и
    -- повтор закрытия гасит ключ повода в notification.
    digest_id    uuid        NOT NULL,
    opened_at    timestamptz NOT NULL,
    due_at       timestamptz NOT NULL,

    CONSTRAINT outbid_digest_pkey PRIMARY KEY (recipient_id),
    CONSTRAINT outbid_digest_digest_id_key UNIQUE (digest_id)
);

-- Выборка прохода: наступившие окна.
CREATE INDEX IF NOT EXISTS outbid_digest_due ON outbid_digest (due_at);

-- Строка окна: лот и вид события. Внешнего ключа на окно нет намеренно:
-- закрытие сначала удаляет окно, затем его строки — в этом порядке берёт
-- блокировки и ставка, — а ключ без отложенной проверки отверг бы удаление
-- окна со строками. Строку без окна не пишет ни один путь: ставка открывает
-- окно той же транзакцией до строки.
CREATE TABLE IF NOT EXISTS outbid_digest_line
(
    recipient_id      uuid        NOT NULL,
    lot_id            uuid        NOT NULL,
    kind              text        NOT NULL,
    added_at          timestamptz NOT NULL,

    -- Последняя применённая ставка лота — любого участника: её лидер, повод и
    -- цена. Ведёт ли человек лот, сводка считает на закрытии сравнением с
    -- лидером: строка перебития, где лидер он сам, — лидерство вернулось, и
    -- лот всё равно в сводке. Версия держит переупорядочивание: старшая
    -- ставка не перетирается младшей, пришедшей позже, а новая строка
    -- начинается с самой свежей ставки, известной другим строкам лота.
    last_leader_id    uuid        NOT NULL,
    last_event_id     uuid        NOT NULL,
    last_version      bigint      NOT NULL,
    price_minor_units bigint      NOT NULL,
    price_currency    text        NOT NULL,

    CONSTRAINT outbid_digest_line_pkey PRIMARY KEY (recipient_id, lot_id, kind),
    CONSTRAINT outbid_digest_line_kind_known CHECK (kind IN ('outbid', 'proxy_raised'))
);

-- Ставка обновляет строки своего лота у всех окон сразу.
CREATE INDEX IF NOT EXISTS outbid_digest_line_lot ON outbid_digest_line (lot_id);

-- Открытые окна прежней формы переходят в новые, а не теряются: окно человека
-- закрывается в самый ранний момент его окон, строка перебития несёт
-- последнюю ставку лота. Окно, где лидерство вернулось, прежде молчало бы, а
-- теперь даёт строку — так и обещает сводка. Лидера прежнее окно не хранило,
-- только «перебит ли»: перебитому пишется нулевой идентификатор — «лидер не
-- он», — а вернувшему лидерство он сам.
DO $$
BEGIN
    IF to_regclass('outbid_window') IS NOT NULL THEN
        INSERT INTO outbid_digest (recipient_id, digest_id, opened_at, due_at)
        SELECT recipient_id, gen_random_uuid(), min(opened_at), min(due_at)
        FROM outbid_window
        GROUP BY recipient_id
        ON CONFLICT (recipient_id) DO NOTHING;

        INSERT INTO outbid_digest_line (
            recipient_id, lot_id, kind, added_at, last_leader_id, last_event_id, last_version,
            price_minor_units, price_currency)
        SELECT recipient_id, lot_id, 'outbid', opened_at,
            CASE WHEN outbid THEN '00000000-0000-0000-0000-000000000000'::uuid ELSE recipient_id END,
            last_event_id, last_version,
            price_minor_units, price_currency
        FROM outbid_window
        ON CONFLICT (recipient_id, lot_id, kind) DO NOTHING;

        DROP TABLE outbid_window;
    END IF;
END
$$;

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_known;
ALTER TABLE notification ADD CONSTRAINT notification_type_known CHECK (type IN (
    'meetup_published', 'meetup_changed', 'meetup_material', 'meetup_unpublished',
    'meetup_reminder', 'organizer_message', 'community_announcement', 'lot_outbid',
    'access_requested', 'lot_purchased', 'access_granted', 'preset_granted',
    'lot_proxy_raised', 'circle_changed', 'lot_activity_digest'
));

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_cause_kind_known;
ALTER TABLE notification ADD CONSTRAINT notification_cause_kind_known CHECK (
    cause_kind IN ('meetup_event', 'reminder_task', 'command_request', 'auction_lot_event', 'identity_event',
                   'outbid_digest')
);
