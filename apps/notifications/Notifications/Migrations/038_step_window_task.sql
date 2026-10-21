-- Окна сниженного шага в реплике лота и задание начала окна (PER-614, ADR-047,
-- дополнение 2026-10-12, «Сообщение о начале окна»).
--
-- Окна приходят данными снимка `LotState.step_windows`: объявленные — в
-- `lot_opened`, запущенные — в `step_window_added`. Реплика держит их строкой
-- той же транзакции и под тем же условием версии, что и остальной снимок:
-- второй таблицы у лота не появляется, а порядок и повтор факта держит один
-- upsert.
ALTER TABLE lot_replica ADD COLUMN IF NOT EXISTS step_windows jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Задание начала окна — одно на аукцион и момент начала, а не на лот: сообщение
-- одно на человека и начало окна, сколько бы лотов окна он ни отметил.
CREATE TABLE IF NOT EXISTS step_window_task
(
    task_id    uuid        NOT NULL,
    auction_id uuid        NOT NULL,

    -- Начало окна и посчитанный от него момент срабатывания. Хранятся оба:
    -- due_at нужен sweeper'у, starts_at называет окно в сообщении и сверяет
    -- реплики лотов, чьи окна начинаются в этот момент.
    starts_at  timestamptz NOT NULL,
    due_at     timestamptz NOT NULL,

    state      text        NOT NULL,

    created_at timestamptz NOT NULL,
    fired_at   timestamptz,
    reason     text,

    CONSTRAINT step_window_task_pkey PRIMARY KEY (task_id),

    CONSTRAINT step_window_task_state_known CHECK (
        state IN ('scheduled', 'fired', 'cancelled')
    ),

    CONSTRAINT step_window_task_fired_at_matches_state CHECK (
        (state = 'fired' AND fired_at IS NOT NULL)
        OR (state <> 'fired' AND fired_at IS NULL)
    ),

    -- Одно задание на аукцион и начало окна — навсегда, а не только живое.
    -- Окна лота только дописываются (И-21), поэтому повторный факт того же
    -- окна задания не заводит, а сработавшая строка остаётся и не даёт завести
    -- второе: ключ повода — её идентификатор, и он же держит сообщение одним на
    -- человека, аукцион и начало.
    CONSTRAINT step_window_task_once UNIQUE (auction_id, starts_at)
);

-- Выборка sweeper'а: наступившие среди живых.
CREATE INDEX IF NOT EXISTS step_window_task_due
    ON step_window_task (due_at)
    WHERE state = 'scheduled';

COMMENT ON TABLE step_window_task IS
    'Материализованное задание сообщения о начале окна сниженного шага: одно на аукцион и момент начала. Источник устойчивости момента, а не reminder Orleans.';

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_known;
ALTER TABLE notification ADD CONSTRAINT notification_type_known CHECK (type IN (
    'meetup_published', 'meetup_changed', 'meetup_material', 'meetup_unpublished',
    'meetup_reminder', 'organizer_message', 'community_announcement', 'lot_outbid',
    'access_requested', 'lot_purchased', 'access_granted', 'preset_granted',
    'lot_proxy_raised', 'circle_changed', 'lot_activity_digest',
    'auction_final_lineup', 'auction_final_started', 'lot_reminder', 'raffle_result',
    'prediction_results', 'release_summary', 'auction_cancelled',
    'lot_deadline_close', 'auction_final_lot_next', 'step_window_started'
));
