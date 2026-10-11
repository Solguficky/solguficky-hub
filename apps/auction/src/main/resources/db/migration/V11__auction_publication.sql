-- Публикация фактов аукциона в шину (integration.md, «Аукцион на шине»,
-- PER-334): своя проекция журнала аукционов auction-publication со своим
-- offset в pekko_projection_offset_store.

-- Свёрнутый аукцион проекции публикации — та же форма, что auction_view, но
-- отдельная строка: read model двигает другая проекция со своим offset, и её
-- снимок может быть впереди или позади публикуемого события. version — номер
-- последнего применённого события журнала аукциона.
--
-- Outbox своей таблицы не получает: факты аукциона ложатся в lot_outbox рядом
-- с фактами лота, и релей их не различает: тип сообщения называет subject.
-- Проекции аукциона и лотов двигают свои offset независимо, поэтому порядка
-- между фактом аукциона и фактом его лота на шине нет (integration.md).
CREATE TABLE auction_publication (
  auction_id uuid PRIMARY KEY,
  meetup_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  state jsonb NOT NULL
);
