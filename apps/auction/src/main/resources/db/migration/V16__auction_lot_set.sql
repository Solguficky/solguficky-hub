-- Коллекционные сеты лотов аукциона (ADR-073, docs/decisions/ADR-073-auction-lot-sets.md;
-- PER-508). Источник правды — журнал аукциона: сет пишет проекция auction-view
-- той же транзакцией, что auction_view и offset, а снимок лота читает его по
-- лоту. Лот входит не больше чем в один сет аукциона.
--
-- lot_ids — лоты в порядке организатора; сет меньше чем из двух лотов неполный,
-- и снимок лота его не показывает. settled — итог записан; collector_id —
-- собравший, только у собранного сета. lot_set_id выбирает вызывающий, и
-- уникален он только внутри аукциона: агрегат другого аукциона его не видит.
--
-- Перестройки нет: до этой миграции сетов не было ни в одном журнале.
CREATE TABLE auction_lot_set (
  auction_id uuid NOT NULL REFERENCES auction_view (auction_id),
  lot_set_id uuid NOT NULL,
  name text NOT NULL,
  lot_ids uuid[] NOT NULL,
  settled boolean NOT NULL,
  collector_id uuid,
  PRIMARY KEY (auction_id, lot_set_id),
  CHECK (settled OR collector_id IS NULL)
);

-- Сет лота: GetLot и ListAuctionLots ищут сет по лоту.
CREATE INDEX auction_lot_set_lots_idx ON auction_lot_set USING gin (lot_ids);
