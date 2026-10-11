-- Снимок «номер — имя» розыгрыша среди участников (ADR-066, п. 12,
-- docs/decisions/ADR-066-auction-raffle-commit-reveal-with-beacon.md): строка
-- состояния, а не журнал, потому что журнал не усекается, а имена стираются.
-- Номера, N и итог остаются в журнале розыгрыша; здесь стирается только имя.
--
-- Строка пишется один раз при фиксации пула и повтором не перезаписывается.
-- erase_after назначается после жеребьёвки; display_name после него — NULL.
CREATE TABLE raffle_ticket (
    auction_id   uuid        NOT NULL,
    number       integer     NOT NULL CHECK (number > 0),
    display_name text,
    erase_after  timestamptz,
    PRIMARY KEY (auction_id, number)
);

-- Стирание по сроку идёт только по строкам, где имя ещё есть.
CREATE INDEX raffle_ticket_erase_after
    ON raffle_ticket (erase_after)
    WHERE display_name IS NOT NULL;
