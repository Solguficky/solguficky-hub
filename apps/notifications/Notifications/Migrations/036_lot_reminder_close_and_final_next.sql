-- Второй момент напоминания о дедлайне избранного лота и сообщение «твой лот
-- следующий» в живом финале (ADR-063, дополнение 2026-10-20).
--
-- Задание лота становится двухвидовым: у лота два момента — за час и за 15
-- минут до дедлайна. Вид добавлен колонкой, а не второй таблицей: ключ грина —
-- лот, и одна живая строка на лот и вид держит ту же единственность, что была
-- до этого. Прежние строки — часовое напоминание.
ALTER TABLE lot_reminder_task ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'hour';

ALTER TABLE lot_reminder_task DROP CONSTRAINT IF EXISTS lot_reminder_task_kind_known;
ALTER TABLE lot_reminder_task ADD CONSTRAINT lot_reminder_task_kind_known CHECK (kind IN ('hour', 'close'));

-- Живое задание на лот и вид ровно одно.
DROP INDEX IF EXISTS lot_reminder_task_one_live_per_lot;
CREATE UNIQUE INDEX IF NOT EXISTS lot_reminder_task_one_live_per_lot_kind
    ON lot_reminder_task (lot_id, kind)
    WHERE state = 'scheduled';

-- Ближний момент для лотов, открытых до выката: прежние строки — часовое
-- напоминание, а второй момент у них не появился бы сам (заводит его грин по
-- событию лота, а события после выката может не быть). Срок ближнего момента
-- — 15 минут, как у настройки по умолчанию; смена настройки уже созданные
-- задания не пересчитывает, и здесь то же правило.
INSERT INTO lot_reminder_task (task_id, lot_id, kind, deadline, due_at, state, created_at)
SELECT gen_random_uuid(), lot_id, 'close', deadline, deadline - interval '15 minutes', 'scheduled', now()
FROM lot_reminder_task
WHERE kind = 'hour' AND deadline > now()
ON CONFLICT DO NOTHING;

-- Ответ на «срабатывало ли по этому виду»: без вида он спросил бы и про
-- часовое напоминание, а второй момент после первого завести можно.
DROP INDEX IF EXISTS lot_reminder_task_fired;
CREATE INDEX IF NOT EXISTS lot_reminder_task_fired
    ON lot_reminder_task (lot_id, kind)
    WHERE state = 'fired';

-- Ход живого финала: лот состава, его место в порядке финала и момент, когда
-- его взяли в работу. Порядок и моменты нужны, чтобы сказать «твой лот
-- следующий» и оценить, сколько он протянет.
CREATE TABLE IF NOT EXISTS auction_final_lot
(
    auction_id   uuid        NOT NULL,
    lot_id       uuid        NOT NULL,
    place        integer     NOT NULL,
    activated_at timestamptz,

    CONSTRAINT auction_final_lot_pkey PRIMARY KEY (auction_id, lot_id),
    CONSTRAINT auction_final_lot_place_unique UNIQUE (auction_id, place)
);

-- Момент, когда лот взяли в работу: по нему считается, сколько лот шёл.
CREATE INDEX IF NOT EXISTS auction_final_lot_activated
    ON auction_final_lot (auction_id, place)
    WHERE activated_at IS NOT NULL;

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_known;
ALTER TABLE notification ADD CONSTRAINT notification_type_known CHECK (type IN (
    'meetup_published', 'meetup_changed', 'meetup_material', 'meetup_unpublished',
    'meetup_reminder', 'organizer_message', 'community_announcement', 'lot_outbid',
    'access_requested', 'lot_purchased', 'access_granted', 'preset_granted',
    'lot_proxy_raised', 'circle_changed', 'lot_activity_digest',
    'auction_final_lineup', 'auction_final_started', 'lot_reminder', 'raffle_result',
    'prediction_results', 'release_summary', 'auction_cancelled',
    'lot_deadline_close', 'auction_final_lot_next'
));
