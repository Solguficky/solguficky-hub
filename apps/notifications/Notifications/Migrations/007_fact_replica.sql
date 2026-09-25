-- Реплика чужих фактов (ADR-028, PER-215): сходки из Meetups и люди из
-- Identity, собранные только из их событий. Обратного вызова в соседей на пути
-- доставки нет, поэтому всё, от чего зависит решение «кому положено», лежит
-- здесь.
--
-- Строка реплики — последний снимок, а не история: событие несёт состояние
-- целиком, и применённое событие перезаписывает строку, если его версия новее.
-- Версия стоит в строке, а не в отдельной таблице курсоров: порядок обещан
-- только внутри одного агрегата (docs/architecture/integration.md), поэтому
-- сравнивать новое событие есть с чем только в строке этого же агрегата.
--
-- Ссылочной целостности с чужими базами нет, как и в 004: идентификаторы здесь
-- голые uuid.

CREATE TABLE IF NOT EXISTS meetup_replica
(
    meetup_id            uuid        NOT NULL,
    version              bigint      NOT NULL,

    -- Автор — единственный организатор, которого снимок сегодня называет.
    author               uuid        NOT NULL,

    -- Пять информационных атрибутов. Решению «кому положено» они нужны не все,
    -- но изменение сведений отличается от изменения состояния сравнением снимка
    -- с репликой (PER-218), а заполнить атрибуты задним числом нечем, пока нет
    -- пересборки (PER-37). Заголовок к тому же рисует tombstone.
    title                text        NOT NULL,
    description          text        NOT NULL,
    venue                text        NOT NULL,
    kind                 text        NOT NULL,
    calendar_link        text        NOT NULL,

    lifecycle            text        NOT NULL,
    visibility           text        NOT NULL,

    -- Отметка первой публикации отличает повторную публикацию от первой
    -- (PER-216): снятие с публикации её не сбрасывает.
    first_published_at   timestamptz NULL,

    -- Расписание разложено так же, как у владельца (Meetups, 001_meetups_schema):
    -- локальные дата и время сообщества без зоны.
    schedule_form        text        NOT NULL,
    schedule_precision   text        NULL,
    schedule_start_date  date        NULL,
    schedule_start_time  time        NULL,
    schedule_end_date    date        NULL,
    schedule_end_time    time        NULL,

    -- Момент коммита события у владельца, а не момент доставки. По нему
    -- считается возраст последнего применённого события.
    occurred_at          timestamptz NOT NULL,
    applied_at           timestamptz NOT NULL,

    CONSTRAINT meetup_replica_pkey PRIMARY KEY (meetup_id),
    CONSTRAINT meetup_replica_version_positive CHECK (version >= 1),
    CONSTRAINT meetup_replica_lifecycle_known CHECK (lifecycle IN ('planned', 'held', 'cancelled')),
    CONSTRAINT meetup_replica_visibility_known CHECK (visibility IN ('hidden', 'visible')),
    CONSTRAINT meetup_replica_schedule_form_known CHECK (schedule_form IN ('no_date', 'tentative', 'fixed')),
    CONSTRAINT meetup_replica_schedule_precision_known CHECK (
        schedule_precision IS NULL OR schedule_precision IN ('day', 'day_start', 'interval')
    ),
    CONSTRAINT meetup_replica_schedule_shape CHECK (
        (schedule_form = 'no_date'
            AND schedule_precision IS NULL
            AND schedule_start_date IS NULL AND schedule_start_time IS NULL
            AND schedule_end_date IS NULL AND schedule_end_time IS NULL)
        OR (schedule_form <> 'no_date' AND schedule_precision = 'day'
            AND schedule_start_date IS NOT NULL AND schedule_start_time IS NULL
            AND schedule_end_date IS NULL AND schedule_end_time IS NULL)
        OR (schedule_form <> 'no_date' AND schedule_precision = 'day_start'
            AND schedule_start_date IS NOT NULL AND schedule_start_time IS NOT NULL
            AND schedule_end_date IS NULL AND schedule_end_time IS NULL)
        OR (schedule_form <> 'no_date' AND schedule_precision = 'interval'
            AND schedule_start_date IS NOT NULL AND schedule_start_time IS NOT NULL
            AND schedule_end_date IS NOT NULL AND schedule_end_time IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS identity_replica
(
    identity_id  uuid        NOT NULL,
    version      bigint      NOT NULL,

    -- Активные глобальные роли именами, без обещанного порядка. Пустой набор —
    -- состояние, а не отсутствие: так выглядит и ещё не допущенный, и
    -- заблокированный человек.
    global_roles text[]      NOT NULL,

    -- Блокировка выключает пригодность к доставке, но не трогает подписки и
    -- настройки: возврат допуска обязан вернуть прежний выбор человека.
    blocked      boolean     NOT NULL,

    occurred_at  timestamptz NOT NULL,
    applied_at   timestamptz NOT NULL,

    CONSTRAINT identity_replica_pkey PRIMARY KEY (identity_id),
    CONSTRAINT identity_replica_version_positive CHECK (version >= 1),
    CONSTRAINT identity_replica_roles_known CHECK (
        global_roles <@ ARRAY['admin', 'maintainer', 'member', 'public']::text[]
    )
);

-- Ключи дедупликации потребителя (docs/architecture/integration.md, раздел
-- «Дедупликация»). Пишутся той же транзакцией, что и эффект события, и
-- записываются даже для устаревшего события, которое реплику не меняет: иначе
-- его нельзя подтвердить, и шина возвращала бы его снова.
--
-- Для самой реплики хватило бы сравнения версий, но поводы (PER-216, PER-218)
-- отсекают повтор по event_id: запоздавшее событие реплику не трогает, а поводом
-- остаётся.
CREATE TABLE IF NOT EXISTS consumed_event
(
    source      text        NOT NULL,
    event_id    uuid        NOT NULL,
    consumed_at timestamptz NOT NULL,

    CONSTRAINT consumed_event_pkey PRIMARY KEY (source, event_id),
    CONSTRAINT consumed_event_source_known CHECK (source IN ('meetups', 'identity'))
);

-- Чистке нужен порядок по моменту записи: ключ держится не меньше окна
-- хранения стрима, и выборка старше порога идёт по этому индексу.
CREATE INDEX IF NOT EXISTS consumed_event_consumed_at_idx ON consumed_event (consumed_at);
