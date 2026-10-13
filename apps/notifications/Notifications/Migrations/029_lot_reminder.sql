-- Задание напоминания о дедлайне избранного лота (PER-496, ADR-063, пункты 3-5).
--
-- Отдельная пара «таблица задания + грин» по образцу напоминания о сходке:
-- ключ — лот, а не сходка, и правило срабатывания у лота своё. Сходочная
-- таблица `reminder_task` не трогается: её грин, store и индекс остаются теми,
-- что работают, и лотовый путь не может их сломать.
--
-- Дедлайна у лота нет без торгов, у лота, который ведёт человек, и у
-- удержанного для финала (миграция 021): там пусто и в реплике, и значит
-- напоминать не о чем. Лот без дедлайна в снимке задания не порождает.
-- Сработавшее задание продлением не пересоздаётся (ADR-063, п.4): анти-снайп
-- продлевает в последние минуты, и второе напоминание пришло бы сразу после
-- первого. Поэтому реплика пишет дедлайн версией, а задание следует за ним,
-- только пока не сработало.
CREATE TABLE IF NOT EXISTS lot_reminder_task
(
    task_id       uuid        NOT NULL,
    lot_id        uuid        NOT NULL,

    -- Дедлайн лота и посчитанный от него момент срабатывания. Хранятся оба:
    -- due_at нужен sweeper'у, deadline — чтобы отличить «дедлайн не менялся»
    -- от «сдвинулся» без обратной арифметики.
    deadline      timestamptz NOT NULL,
    due_at        timestamptz NOT NULL,

    state         text        NOT NULL,

    created_at    timestamptz NOT NULL,
    fired_at      timestamptz,
    superseded_by uuid,
    reason        text,

    CONSTRAINT lot_reminder_task_pkey PRIMARY KEY (task_id),

    CONSTRAINT lot_reminder_task_state_known CHECK (
        state IN ('scheduled', 'fired', 'cancelled', 'superseded')
    ),

    CONSTRAINT lot_reminder_task_fired_at_matches_state CHECK (
        (state = 'fired' AND fired_at IS NOT NULL)
        OR (state <> 'fired' AND fired_at IS NULL)
    ),

    CONSTRAINT lot_reminder_task_superseded_by_matches_state CHECK (
        (state = 'superseded' AND superseded_by IS NOT NULL)
        OR (state <> 'superseded' AND superseded_by IS NULL)
    )
);

-- Живое задание на лот ровно одно, и это ограничение схемы, а не соглашение в
-- коде. Завершённые задания остаются строками и копят историю переносов.
CREATE UNIQUE INDEX IF NOT EXISTS lot_reminder_task_one_live_per_lot
    ON lot_reminder_task (lot_id)
    WHERE state = 'scheduled';

-- Выборка sweeper'а: наступившие среди живых.
CREATE INDEX IF NOT EXISTS lot_reminder_task_due
    ON lot_reminder_task (due_at)
    WHERE state = 'scheduled';

-- Ответ на «срабатывало ли вообще»: строки не чистятся, поэтому история лота
-- растёт, и без индекса вопрос просматривал бы её целиком.
CREATE INDEX IF NOT EXISTS lot_reminder_task_fired
    ON lot_reminder_task (lot_id)
    WHERE state = 'fired';

COMMENT ON TABLE lot_reminder_task IS
    'Материализованное задание напоминания о дедлайне лота: одно на лот. Источник устойчивости момента, а не reminder Orleans.';

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_known;
ALTER TABLE notification ADD CONSTRAINT notification_type_known CHECK (type IN (
    'meetup_published', 'meetup_changed', 'meetup_material', 'meetup_unpublished',
    'meetup_reminder', 'organizer_message', 'community_announcement', 'lot_outbid',
    'access_requested', 'lot_purchased', 'access_granted', 'preset_granted',
    'lot_proxy_raised', 'circle_changed', 'lot_activity_digest',
    'auction_final_lineup', 'auction_final_started', 'lot_reminder'
));
