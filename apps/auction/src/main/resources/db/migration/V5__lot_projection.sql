-- Проекция журнала лотов в read model (ADR-045): offset и read model в одной
-- базе и одной транзакции JdbcProjection.exactlyOnce.
--
-- Таблицы offset — DDL Pekko Projection JDBC 1.1.0
-- (examples/src/test/resources/create-table-postgres.sql в репозитории модуля),
-- перенесённый дословно, кроме IF NOT EXISTS: по той же причине, что в V1,
-- таблица без записи Flyway — чужая схема, и миграция на ней падает. Проекция
-- таблиц сама не создаёт.

CREATE TABLE pekko_projection_offset_store (
  projection_name VARCHAR(255) NOT NULL,
  projection_key VARCHAR(255) NOT NULL,
  current_offset VARCHAR(255) NOT NULL,
  manifest VARCHAR(4) NOT NULL,
  mergeable BOOLEAN NOT NULL,
  last_updated BIGINT NOT NULL,
  PRIMARY KEY(projection_name, projection_key)
);

CREATE INDEX projection_name_index ON pekko_projection_offset_store (projection_name);

CREATE TABLE pekko_projection_management (
  projection_name VARCHAR(255) NOT NULL,
  projection_key VARCHAR(255) NOT NULL,
  paused BOOLEAN NOT NULL,
  last_updated BIGINT NOT NULL,
  PRIMARY KEY(projection_name, projection_key)
);

-- Выборка по тегу у плагина журнала идёт условием на tag и порядком по
-- event_id, а ключ event_tag начинается с event_id. Без этого индекса чтение
-- проекции и метрика отставания просматривают всю таблицу тегов.
CREATE INDEX event_tag_tag_idx ON event_tag (tag, event_id);

-- Снимок лота — JSON модели хранения snapshot (ADR-058) той версии, до которой
-- дошла проекция. version — номер последнего применённого события журнала
-- лота: по нему обработчик пропускает повторную доставку.
CREATE TABLE lot_view (
  lot_id uuid PRIMARY KEY,
  auction_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  state jsonb NOT NULL
);

-- ListAuctionLots: лоты аукциона по возрастанию lot_id.
CREATE INDEX lot_view_auction_idx ON lot_view (auction_id, lot_id);

-- Хронология ставок лота (RFC-007, «Спор»): строка на событие BidPlaced, ключ —
-- его номер в журнале лота. Чтения по gRPC пока нет; таблица пишется в той же
-- транзакции, иначе заполнить её позже можно только перестройкой с нуля.
CREATE TABLE lot_bid (
  lot_id uuid NOT NULL,
  sequence bigint NOT NULL,
  bid_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  minor_units bigint NOT NULL,
  currency text NOT NULL,
  origin text NOT NULL,
  source text,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (lot_id, sequence)
);
