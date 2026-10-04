-- Проекция журнала аукционов в read model (ADR-047, дополнение 2026-10-03):
-- аукцион сходки, списки по статусу и реестр лотов. Offset — в той же
-- pekko_projection_offset_store под своим именем проекции.

-- Снимок аукциона — JSON модели хранения snapshot (ADR-058). version — номер
-- последнего применённого события журнала аукциона. meetup_id уникален: у
-- сходки не больше одного аукциона (И-21); держит это выведение auction_id из
-- meetup_id, а индекс служит чтению аукциона сходки. status — имя статуса
-- AuctionSnapshot, по нему перечисляются активные и прошедшие.
CREATE TABLE auction_view (
  auction_id uuid PRIMARY KEY,
  meetup_id uuid NOT NULL UNIQUE,
  version bigint NOT NULL CHECK (version > 0),
  status text NOT NULL,
  state jsonb NOT NULL
);

-- ListAuctions: аукционы статуса по возрастанию auction_id.
CREATE INDEX auction_view_status_idx ON auction_view (status, auction_id);

-- Реестр лотов аукциона: строка на лот, который сейчас в реестре. ListAuctionLots
-- аукциона сходки идёт по нему, а не по lot_view.auction_id: снятый лот
-- остаётся рождённым в аукционе, но из реестра уходит.
CREATE TABLE auction_lot (
  auction_id uuid NOT NULL REFERENCES auction_view (auction_id),
  lot_id uuid NOT NULL,
  PRIMARY KEY (auction_id, lot_id)
);
