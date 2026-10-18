-- Избранные лоты аукциона и реплика лота (PER-522, ADR-063).
--
-- Реплика — снимок лота из публичных фактов AUCTION_EVENTS: дедлайн, лидер и
-- положение. Порядок держит версия: снимок пишется, только если его версия
-- старше записанной, иначе повторный lot_opened откатил бы продлённый дедлайн.
-- Задание напоминания (PER-496) берёт дедлайн отсюда.
CREATE TABLE IF NOT EXISTS lot_replica
(
    lot_id      uuid        NOT NULL,
    version     bigint      NOT NULL,
    status      text        NOT NULL,

    -- Нет у лота без торгов, у лота, который ведёт человек, и у удержанного
    -- для финала. Пустое значение пишется явно: «дедлайна нет», а не «прежний».
    deadline    timestamptz NULL,
    leader_id   uuid        NULL,

    -- Момент первого конечного снимка (sold, unsold, withdrawn); от него идёт
    -- срок хранения реплики и отметок. Конечное положение не меняется, поэтому
    -- и момент, раз записанный, не переписывается.
    terminal_at timestamptz NULL,

    occurred_at timestamptz NOT NULL,
    applied_at  timestamptz NOT NULL,

    CONSTRAINT lot_replica_pkey PRIMARY KEY (lot_id),

    CONSTRAINT lot_replica_status_known CHECK (status IN (
        'draft', 'scheduled', 'trading', 'held', 'sold', 'unsold', 'withdrawn'
    )),

    CONSTRAINT lot_replica_terminal CHECK (
        (status IN ('sold', 'unsold', 'withdrawn')) = (terminal_at IS NOT NULL)
    )
);

-- Выборка чистки: лоты, срок хранения которых вышел.
CREATE INDEX IF NOT EXISTS lot_replica_terminal_at ON lot_replica (terminal_at)
    WHERE terminal_at IS NOT NULL;

-- Отметка «человек следит за лотом». Снятие не удаляет строку, а ставит
-- removed_at: снятие помнится до конца срока хранения, и автодобавление по
-- ставке на этом лоте его не отменяет — ни следующей ставкой, ни ответом
-- прокси-лимита, ни повтором старого bid_placed. Вернуть отметку может только
-- сам человек.
CREATE TABLE IF NOT EXISTS lot_favorite
(
    identity_id uuid        NOT NULL,
    lot_id      uuid        NOT NULL,

    -- Момент последней постановки: ручной или по ставке. Порядок списка.
    followed_at timestamptz NOT NULL,
    removed_at  timestamptz NULL,

    CONSTRAINT lot_favorite_pkey PRIMARY KEY (identity_id, lot_id)
);

-- Разворот напоминания по лоту (PER-496) и чистка по лоту.
CREATE INDEX IF NOT EXISTS lot_favorite_lot ON lot_favorite (lot_id);
