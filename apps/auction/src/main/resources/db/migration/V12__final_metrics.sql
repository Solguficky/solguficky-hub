-- Метрики финала для прогнозов (PER-608, ADR-067 п. 6, номинации 2.3 и 2.4).
-- Цена удержания, номер возврата лота в торги и состав финала — факты, которых
-- нет в снимках read model после финала: цена удержания теряется с переходом
-- Held -> Trading, ставки финала отделяются от ставок недели только номером
-- события LotResumed, а состав заморозки снимок аукциона не несёт с перехода в
-- Finished. Пишут их проекции лота и аукциона теми же транзакциями, что offset.

-- Цена, с которой лот удержан в D 00:00 (HeldState.currentPrice на момент
-- LotHeldForFinal). Строки нет — лот в состав не входил.
CREATE TABLE lot_hold (
  lot_id uuid PRIMARY KEY,
  minor_units bigint NOT NULL,
  currency text NOT NULL
);

-- Номер события LotResumed: принятые ставки с номером больше него — ставки
-- финала. Строки нет — лот в финал не возвращался.
CREATE TABLE lot_resume (
  lot_id uuid PRIMARY KEY,
  sequence bigint NOT NULL
);

-- Состав финала из FinalLineupFrozen. Строка на лот состава; строки нет — лот
-- вне состава. Снимок аукциона состав не хранит с Finished, а подсчёт прогнозов
-- идёт как раз по Finished, поэтому состав живёт здесь, а не в auction_view.
CREATE TABLE auction_lineup (
  auction_id uuid NOT NULL REFERENCES auction_view (auction_id),
  lot_id uuid NOT NULL,
  PRIMARY KEY (auction_id, lot_id)
);

-- Перестройка проекции lot-view с нуля, как в V9: у лотов, чьи события
-- спроецированы до этой миграции, новых фактов нет. Очищаются и прежние факты
-- статистики: без этого строка лота, переигранная до первой ставки, показала бы
-- старых участников при ещё нулевом числе ставок. Журнал лота не усекается,
-- поэтому проекция без offset переигрывает потоки тегов с начала и пишет все
-- факты заново; лот, чьи события записаны без тега, не возвращается — до сброса
-- его в read model не было тоже.
DELETE FROM lot_bid;
DELETE FROM lot_view;
DELETE FROM lot_participant;
DELETE FROM lot_starting_price;
DELETE FROM lot_hold;
DELETE FROM lot_resume;
DELETE FROM pekko_projection_offset_store WHERE projection_name = 'lot-view';

-- Проекция аукционов перестраивается ради состава финала: строку
-- auction_lineup пишет она же. Дочерние таблицы очищаются раньше auction_view,
-- на которую ссылаются, и та же перестройка возвращает реестр auction_lot.
-- Проекцию публикации (lot-publication) сброс не трогает: у неё свой offset и
-- своя таблица, и факты в шину повторно не уходят.
DELETE FROM auction_lineup;
DELETE FROM auction_lot;
DELETE FROM auction_view;
DELETE FROM pekko_projection_offset_store WHERE projection_name = 'auction-view';
