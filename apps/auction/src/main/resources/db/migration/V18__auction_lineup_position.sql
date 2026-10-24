-- Место лота в составе финала (PER-712). Снимок Finished состав не несёт, и
-- поток WatchAuction завершённого аукциона берёт состав из auction_lineup —
-- в порядке выхода, как в контракте AuctionWatch.lineup. Позицию пишет
-- проекция auction-view на заморозке, с нуля, той же транзакцией, что строку.
ALTER TABLE auction_lineup ADD COLUMN position integer CHECK (position >= 0);

-- Перестройки нет: аукцион, состав которого ещё в снимке (LineupFrozen, Final),
-- получает позиции из него; у завершённого до миграции порядок уже не
-- восстановить из read model, и чтение ставит строки без позиции по lot_id.
UPDATE auction_lineup l
SET position = o.ordinality - 1
FROM auction_view v,
  jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(v.state -> 'order') = 'array' THEN v.state -> 'order' ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS o(lot_id, ordinality)
WHERE v.auction_id = l.auction_id
  AND o.lot_id::uuid = l.lot_id;
