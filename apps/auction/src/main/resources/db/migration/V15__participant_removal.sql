-- Снятие участника с лота (ADR-072, docs/decisions/ADR-072-auction-participant-removal-from-lot.md;
-- PER-658). Снятые ставки остаются в хронологии с пометкой и больше не
-- считаются: ни числом ставок, ни статистикой, ни сводкой дня. Участие снятого
-- тоже помечается, и уникальные участники лота считаются без него.
--
-- Перестройки нет, в отличие от V9 и V12: команда снятия до этой миграции
-- снаружи не приходила, поэтому ParticipantRemoved нет ни в одном журнале, и
-- false верно для каждой уже записанной строки.
ALTER TABLE lot_bid ADD COLUMN removed boolean NOT NULL DEFAULT false;

ALTER TABLE lot_participant ADD COLUMN removed boolean NOT NULL DEFAULT false;

-- Запись снятия в хронологии лота под номером события ParticipantRemoved: цена
-- и лидер, с которыми лот пошёл дальше. Кого сняли, говорят помеченные строки
-- lot_bid, поэтому участника здесь нет; кто снял и почему, не хранится вовсе.
-- Лидера нет, когда снятие оставило лот без лидера.
CREATE TABLE lot_removal (
    lot_id      uuid        NOT NULL,
    sequence    bigint      NOT NULL,
    minor_units bigint      NOT NULL,
    currency    text        NOT NULL,
    leader_id   uuid,
    occurred_at timestamptz NOT NULL,
    PRIMARY KEY (lot_id, sequence)
);
