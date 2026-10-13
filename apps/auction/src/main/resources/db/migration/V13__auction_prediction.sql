-- Прогнозы аукциона (ADR-067, docs/decisions/ADR-067-auction-predictions-two-rounds.md):
-- строки состояния, а не журнал, потому что журнал не усекается, а прогнозы
-- стираются по запросу субъекта (п. 10). Журнал игры `predictions|<auction_id>`
-- несёт только ход раундов, без участников и ответов. Пишет строки только entity
-- прогнозов: она решает, открыт ли раунд.
--
-- Строка — ответ участника на одну номинацию раунда; прогноз раунда — его строки.
-- Ровно одно из двух: лот или неотрицательное число. CHECK повторяет инварианты
-- типов намеренно: тип защищает только код сервиса.
CREATE TABLE auction_prediction (
    auction_id     uuid   NOT NULL,
    round          text   NOT NULL CHECK (round IN ('catalog', 'final')),
    participant_id uuid   NOT NULL,
    nomination     text   NOT NULL,
    lot_id         uuid,
    number         bigint CHECK (number >= 0),
    PRIMARY KEY (auction_id, round, participant_id, nomination),
    CHECK ((lot_id IS NULL) <> (number IS NULL))
);

-- Окно отправок: повтор `op_id` получает исходный ответ и после закрытия раунда.
-- Несёт участника, поэтому стирается вместе с его прогнозами.
CREATE TABLE auction_prediction_op (
    auction_id     uuid NOT NULL,
    op_id          uuid NOT NULL,
    participant_id uuid NOT NULL,
    round          text NOT NULL CHECK (round IN ('catalog', 'final')),
    PRIMARY KEY (auction_id, op_id)
);

-- Стирание субъекта идёт по участнику во всех аукционах.
CREATE INDEX auction_prediction_participant ON auction_prediction (participant_id);

CREATE INDEX auction_prediction_op_participant ON auction_prediction_op (participant_id);
