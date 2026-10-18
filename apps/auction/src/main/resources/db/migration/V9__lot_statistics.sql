-- Статистика лотов аукциона (PER-481, контракт GetAuctionLotStatistics).
-- Число ставок и последняя ставка выводятся из lot_bid, рост цены — из
-- снимка lot_view и стартовой цены. Здесь только факты, которых в read model
-- не было: их пишет проекция lot-view той же транзакцией, что offset.

-- Участники лота: авторы BidPlaced и владельцы принятых ProxyLimitSet. Отзыв
-- лимита участия не снимает, поэтому строка только добавляется; повтор гасит
-- первичный ключ.
CREATE TABLE lot_participant (
  lot_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  PRIMARY KEY (lot_id, participant_id)
);

-- Стартовая цена из LotOpened: после открытия торгов в снимке лота её нет.
-- Строки нет — лот ещё не открывался.
CREATE TABLE lot_starting_price (
  lot_id uuid PRIMARY KEY,
  minor_units bigint NOT NULL,
  currency text NOT NULL
);

-- Перестройка проекции lot-view с нуля: у лотов, чьи события спроецированы до
-- этой миграции, новых фактов нет, а прокси-лимит владельца без ставок есть
-- только в журнале. Журнал лота не усекается, поэтому проекция без offset
-- переигрывает потоки тегов с начала; лот, чьи события записаны без тега, не
-- возвращается — до сброса его в read model не было тоже. Пока проекция
-- догоняет, чтения лота, пульт и статистика отдают меньше лотов, а метрика
-- auction.lots.overdue не видит лотов, ещё не вернувшихся в lot_view;
-- догонку показывает auction.projection.events_behind. Проекцию публикации
-- (lot-publication) сброс не трогает: у неё свой offset и своя таблица, и
-- факты в шину повторно не уходят.
DELETE FROM lot_bid;
DELETE FROM lot_view;
DELETE FROM pekko_projection_offset_store WHERE projection_name = 'lot-view';
