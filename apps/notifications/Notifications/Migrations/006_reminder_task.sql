-- Доменная схема напоминания: материализованное задание и повод, который оно
-- порождает при срабатывании.
--
-- Почему задание живёт строкой, а не reminder'ом Orleans: reminder хранит
-- определение напоминания, но не конкретное срабатывание, поэтому тик,
-- пришедшийся на простой кластера, теряется и приходит только следующий. Для
-- напоминания за сутки «следующий период» смысла не имеет (ADR-029). Источник
-- истины — эта таблица; reminders служат механизмом пробуждения, а sweeper по
-- этой таблице обязателен для корректности, а не желателен.
--
-- Гранулярность — одно задание на сходку (PER-221, docs/services/notifications.md).
-- Строка привязана к сходке и её моменту начала, а не к человеку: аудитория
-- разворачивается в момент срабатывания, поэтому подписка, отписка и выключение
-- категории этих строк не трогают вовсе.

CREATE TABLE IF NOT EXISTS reminder_task
(
    -- Идентификатор задания объявлен наружу: Cause.reminder_task_id в
    -- contracts/proto/notifications/v1/notifications.proto ссылается именно на
    -- него. Поэтому ключ здесь не внутреннее дело таблицы и не меняется.
    task_id       uuid        NOT NULL,
    meetup_id     text        NOT NULL,

    -- Момент начала сходки и посчитанный от него момент срабатывания. Хранятся
    -- оба: due_at нужен sweeper'у для выборки, starts_at — чтобы отличить
    -- «расписание не менялось» от «сдвинулось» без обратной арифметики.
    starts_at     timestamptz NOT NULL,
    due_at        timestamptz NOT NULL,

    -- Четыре состояния из docs/services/notifications.md: запланировано,
    -- сработало, отменено, замещено.
    state         text        NOT NULL,

    created_at    timestamptz NOT NULL,
    fired_at      timestamptz,
    superseded_by uuid,
    reason        text,

    CONSTRAINT reminder_task_pkey PRIMARY KEY (task_id),

    CONSTRAINT reminder_task_state_known CHECK (state IN ('scheduled', 'fired', 'cancelled', 'superseded')),

    -- Сработавшее задание обязано нести момент срабатывания, несработавшее — не
    -- имеет права его нести. Иначе «сработало» превращается в необязательную
    -- пометку, и PER-223 нечем измерять лаг.
    CONSTRAINT reminder_task_fired_at_matches_state CHECK (
        (state = 'fired' AND fired_at IS NOT NULL)
        OR (state <> 'fired' AND fired_at IS NULL)
    ),

    -- Замещение обязано называть преемника: без ссылки история переноса
    -- нечитаема, а «замещено» неотличимо от «отменено».
    CONSTRAINT reminder_task_superseded_by_matches_state CHECK (
        (state = 'superseded' AND superseded_by IS NOT NULL)
        OR (state <> 'superseded' AND superseded_by IS NULL)
    )
);

-- Живое задание на сходку ровно одно, и это ограничение схемы, а не
-- соглашение в коде. Частичный индекс: завершённые задания остаются строками и
-- копятся историей переносов, мешать новому они не должны.
CREATE UNIQUE INDEX IF NOT EXISTS reminder_task_one_live_per_meetup
    ON reminder_task (meetup_id)
    WHERE state = 'scheduled';

-- Выборка sweeper'а: наступившие среди живых. Частичный индекс по тому же
-- предикату, что и запрос, иначе просмотр пойдёт по всей истории.
CREATE INDEX IF NOT EXISTS reminder_task_due
    ON reminder_task (due_at)
    WHERE state = 'scheduled';

COMMENT ON TABLE reminder_task IS
    'Материализованное задание напоминания: одно на сходку и её момент начала. Источник устойчивости момента, а не reminder Orleans.';

-- Повод, порождённый срабатыванием. Публикация в шину и разворот аудитории на
-- получателей — PER-72; здесь повод только фиксируется, чтобы срабатывание
-- было наблюдаемым фактом, а не строкой в логе.
CREATE TABLE IF NOT EXISTS notification_occasion
(
    occasion_id uuid        NOT NULL,

    -- Ключ идемпотентности: срабатывание идемпотентно по самому объекту
    -- задания (docs/services/notifications.md), поэтому одно задание даёт
    -- ровно один повод. Перенос создаёт новое задание — и, законно, новый
    -- повод: перенос после уже отправленного напоминания обязан напомнить снова.
    task_id     uuid        NOT NULL,
    meetup_id   text        NOT NULL,
    occurred_at timestamptz NOT NULL,

    CONSTRAINT notification_occasion_pkey PRIMARY KEY (occasion_id),
    CONSTRAINT notification_occasion_once_per_task UNIQUE (task_id),
    CONSTRAINT notification_occasion_task_fkey FOREIGN KEY (task_id) REFERENCES reminder_task (task_id)
);

COMMENT ON TABLE notification_occasion IS
    'Повод, порождённый сработавшим заданием. Один повод на задание; разворот на получателей и публикация в шину — PER-72.';
