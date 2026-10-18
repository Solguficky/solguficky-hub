-- Публикация фактов лота в шину (integration.md, «Auction NATS»): своя
-- проекция журнала со своим offset в pekko_projection_offset_store и outbox,
-- который релей выносит в JetStream.

-- Свёрнутый лот проекции публикации — та же форма, что lot_view, но отдельная
-- строка: read model двигает другая проекция со своим offset, и её снимок может
-- быть впереди или позади публикуемого события. Снимок факта на шине — состояние
-- ровно после его события. version — номер последнего применённого события.
CREATE TABLE lot_publication (
  lot_id uuid PRIMARY KEY,
  auction_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version > 0),
  state jsonb NOT NULL
);

-- Факты, которые проекция записала, а шина ещё не подтвердила. Строку пишет
-- проекция одной транзакцией с offset, релей читает в порядке position и
-- удаляет после ack: журнал — источник истины, и опубликованная строка ничего не
-- несёт. payload — сериализованный auction.v1.LotEvent, event_id — его
-- Nats-Msg-Id. created_at — возраст ожидания для метрики, по часам базы.
CREATE TABLE lot_outbox (
  position bigserial PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  subject text NOT NULL,
  payload bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
