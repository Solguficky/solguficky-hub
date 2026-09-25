-- Адресный факт «этому человеку положено это уведомление» (ADR-028, PER-216).
-- Таблица одновременно журнал фактов и outbox: факт пишется той же
-- транзакцией, что ключ дедупликации события и снимок реплики, а в шину его
-- выносит релей по dispatched_at. Публикация сразу после коммита без таблицы
-- теряла бы факт на падении между коммитом и отправкой.
--
-- Ссылочной целостности с чужими базами нет, как и в 004 и 007: получатель и
-- сходка — голые uuid.

CREATE TABLE IF NOT EXISTS notification
(
    -- UUIDv7 рождается в сервисе, а не в базе: uuidv7() есть только с
    -- PostgreSQL 18. Он же ключ дедупликации канала и Nats-Msg-Id публикации.
    notification_id uuid        NOT NULL,
    recipient_id    uuid        NOT NULL,

    -- Ветка oneof типа в contracts/proto/notifications/v1/notifications.proto.
    -- Список растёт вместе с поводами соседних срезов (PER-218 и дальше).
    type            text        NOT NULL,

    -- Ссылка на повод — ветка Cause того же контракта. Текстом, потому что
    -- идентификатор команды ручной рассылки задаёт вызывающий и uuid не обещан.
    cause_kind      text        NOT NULL,
    cause_id        text        NOT NULL,

    -- Сходка, к которой относится факт; пусто у объявления сообществу. Нужна
    -- второму ограничению ниже.
    meetup_id       uuid        NULL,

    -- Сериализованный notifications.v1.Notification. Карточка в нём — значение
    -- на момент повода, а не живая проекция: релей публикует ровно то, что
    -- было решено, и ему не нужно ни реплики, ни часов.
    payload         bytea       NOT NULL,

    request_id      text        NULL,
    created_at      timestamptz NOT NULL,

    -- Отметка подтверждённой публикации. Ставится после ack шины и не
    -- гарантирует доставку: сбой между публикацией и отметкой даёт повтор с тем
    -- же notification_id, который отсекает сервер в окне дедупликации, а за ним
    -- канал (docs/services/notifications.md, «Три границы надёжности»).
    dispatched_at   timestamptz NULL,

    CONSTRAINT notification_pkey PRIMARY KEY (notification_id),
    CONSTRAINT notification_type_known CHECK (type IN ('meetup_published')),
    CONSTRAINT notification_cause_kind_known CHECK (
        cause_kind IN ('meetup_event', 'reminder_task', 'command_request')
    ),

    -- Детерминированный ключ повода (ADR-028): тройка (тип, источник,
    -- получатель) из комментария к Cause. Держит повтор события и после того,
    -- как его ключ в consumed_event вычищен.
    CONSTRAINT notification_cause_once_per_recipient UNIQUE (type, cause_kind, cause_id, recipient_id)
);

-- Одна «новая сходка» на человека и сходку, каким бы событием она ни пришла.
-- Повторная публикация и так приходит другим поводом (meetup_republished), но
-- обещание «второго факта нет» держит схема, а не только словарь producer'а.
CREATE UNIQUE INDEX IF NOT EXISTS notification_meetup_published_once
    ON notification (meetup_id, recipient_id)
    WHERE type = 'meetup_published';

-- Очередь релея: неотправленное по порядку появления.
CREATE INDEX IF NOT EXISTS notification_pending_idx
    ON notification (created_at)
    WHERE dispatched_at IS NULL;

COMMENT ON TABLE notification IS
    'Адресные факты: одна строка — одно уведомление одному человеку. Журнал и outbox релея в events.notifications.notification_created.';
