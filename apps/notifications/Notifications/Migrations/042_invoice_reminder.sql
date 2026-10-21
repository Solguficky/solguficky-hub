-- Напоминание о неоплаченном счёте (PER-330).
--
-- Отдельная пара «таблица задания + грин» по образцу напоминания о дедлайне
-- лота: ключ — счёт, а не лот, и правило срабатывания у счёта своё. Сходочная
-- таблица `reminder_task` и лотовая `lot_reminder_task` не трогаются: их грины,
-- store и индексы остаются теми, что работают, и счётный путь не может их
-- сломать.
--
-- Реплика счёта нужна по двум причинам. Первая: сумма, срок оплаты и адресат
-- нужны самому факту напоминания — канал читает их из сообщения, а не у
-- Auction. Вторая: факты счёта идут разными subject'ами, порядок доставки не
-- обещан, и поздний `invoice_issued`, пришедший после `invoice_paid`, не должен
-- воскресить задания. Версия реплики растёт по журналу счёта, поэтому
-- поздний факт её не откатывает.
--
-- Моменты счёта неизменны: сумма не меняется никогда, а срок оплаты задан при
-- выставлении счёта и потом не меняется. Поэтому задание на счёт и вид
-- заводится один раз и не пересоздаётся.
CREATE TABLE IF NOT EXISTS invoice_replica
(
    invoice_id         uuid        NOT NULL,
    version            bigint      NOT NULL,
    status             text        NOT NULL,
    winner_id          uuid        NOT NULL,
    lot_id             uuid        NOT NULL,
    auction_id         uuid        NOT NULL,
    amount_minor_units bigint      NOT NULL,
    amount_currency    text        NOT NULL,
    payment_due_at     timestamptz NOT NULL,

    -- Момент выставления счёта. Его знает только факт `invoice_issued`, и он
    -- же считает первый из двух напоминаний, поэтому пустое значение у счёта,
    -- чей факт выставления не дошёл, — не пустое, а отсутствующее.
    issued_at          timestamptz,
    applied_at         timestamptz NOT NULL,

    CONSTRAINT invoice_replica_pkey PRIMARY KEY (invoice_id),

    CONSTRAINT invoice_replica_status_known CHECK (
        status IN ('awaiting_payment', 'paid')
    )
);

CREATE TABLE IF NOT EXISTS invoice_reminder_task
(
    task_id    uuid        NOT NULL,
    invoice_id uuid        NOT NULL,
    kind       text        NOT NULL,
    due_at     timestamptz NOT NULL,
    state      text        NOT NULL,

    created_at timestamptz NOT NULL,
    fired_at   timestamptz,
    reason     text,

    CONSTRAINT invoice_reminder_task_pkey PRIMARY KEY (task_id),

    CONSTRAINT invoice_reminder_task_kind_known CHECK (
        kind IN ('after_win', 'before_due')
    ),

    CONSTRAINT invoice_reminder_task_state_known CHECK (
        state IN ('scheduled', 'fired', 'cancelled')
    ),

    CONSTRAINT invoice_reminder_task_fired_at_matches_state CHECK (
        (state = 'fired' AND fired_at IS NOT NULL)
        OR (state <> 'fired' AND fired_at IS NULL)
    )
);

-- Живое задание на счёт и вид ровно одно, и это ограничение схемы, а не
-- соглашение в коде. Завершённые задания остаются строками и копят историю.
CREATE UNIQUE INDEX IF NOT EXISTS invoice_reminder_task_one_live_per_invoice_kind
    ON invoice_reminder_task (invoice_id, kind)
    WHERE state = 'scheduled';

-- Выборка sweeper'а: наступившие среди живых.
CREATE INDEX IF NOT EXISTS invoice_reminder_task_due
    ON invoice_reminder_task (due_at)
    WHERE state = 'scheduled';

-- Ответ на «было ли задание по этому виду»: строки не чистятся, поэтому
-- история счёта растёт, и без индекса вопрос просматривал бы её целиком.
CREATE INDEX IF NOT EXISTS invoice_reminder_task_by_invoice
    ON invoice_reminder_task (invoice_id, kind);

COMMENT ON TABLE invoice_reminder_task IS
    'Материализованное задание напоминания о неоплаченном счёте: два на счёт, по виду момента. Источник устойчивости момента, а не reminder Orleans.';

COMMENT ON TABLE invoice_replica IS
    'Последний записанный снимок счёта из фактов AUCTION_EVENTS: статус, адресат, сумма и срок оплаты.';

-- Причина снятия неотправленного факта: счёт оплатили, а напоминание о
-- неоплаченном счёте ещё стояло в очереди релея.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_withdrawal_reason_known;
ALTER TABLE notification ADD CONSTRAINT notification_withdrawal_reason_known CHECK (
    withdrawal_reason IN ('meetup_cancelled', 'expired', 'application_closed', 'auction_hidden', 'invoice_paid')
);

-- Типы вестей добавлены к известным, иначе первое же напоминание о счёте
-- нарушило бы ограничение на типе.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_known;
ALTER TABLE notification ADD CONSTRAINT notification_type_known CHECK (type IN (
    'meetup_published', 'meetup_changed', 'meetup_material', 'meetup_unpublished',
    'meetup_reminder', 'organizer_message', 'community_announcement', 'lot_outbid',
    'access_requested', 'lot_purchased', 'access_granted', 'preset_granted',
    'lot_proxy_raised', 'circle_changed', 'lot_activity_digest',
    'auction_final_lineup', 'auction_final_started', 'lot_reminder', 'raffle_result',
    'prediction_results', 'release_summary', 'auction_cancelled',
    'lot_deadline_close', 'auction_final_lot_next', 'step_window_started',
    'lot_lead_restored', 'auction_published', 'auction_trading_opened',
    'invoice_reminder', 'invoice_due_reminder'
 ));
