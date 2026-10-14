-- Итоги прогнозов аукциона (ADR-067, docs/decisions/ADR-067-auction-predictions-two-rounds.md):
-- строки состояния, а не журнал, потому что журнал не усекается, а имя угадавшего
-- стирается по запросу субъекта (п. 10). Журнал итогов `results|<auction_id>`
-- несёт только номинации и число угадавших, без участников и имён.
--
-- Строка — результат участника по одной номинации: угадал или нет, у числа —
-- отклонение, и имя на момент подсчёта. CHECK повторяет инварианты типа
-- намеренно: тип защищает только код сервиса.
CREATE TABLE auction_result (
    auction_id     uuid    NOT NULL,
    participant_id uuid    NOT NULL,
    nomination     text    NOT NULL,
    guessed        boolean NOT NULL,
    deviation      bigint,
    name           text    NOT NULL,
    PRIMARY KEY (auction_id, participant_id, nomination),
    CHECK (deviation IS NULL OR NOT guessed)
);

-- Стирание субъекта идёт по участнику во всех аукционах.
CREATE INDEX auction_result_participant ON auction_result (participant_id);
