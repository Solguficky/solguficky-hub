-- Условия лота в окне «Счастливых часов» (PER-788). Окно несёт шаг, стартовую
-- цену или оба (PER-785), а весть о начале окна обещает стартовую только лоту
-- без ставок и называет рядом обычную стартовую. Обычная стартовая лота в
-- торгах до первой ставки — его текущая цена (`LotTrading.current_price`),
-- поэтому реплика помнит текущую цену своего снимка; вне торгов её нет.
-- Окна в `step_windows` дописываются ключами `start_minor_units` и
-- `start_currency`, а ключи шага у окна только со стартовой пусты: формат
-- jsonb разбирает код, и старые строки читаются как окна с шагом.
ALTER TABLE lot_replica ADD COLUMN IF NOT EXISTS price_minor_units bigint NULL;
ALTER TABLE lot_replica ADD COLUMN IF NOT EXISTS price_currency text NULL;

ALTER TABLE lot_replica DROP CONSTRAINT IF EXISTS lot_replica_price_pair;
ALTER TABLE lot_replica ADD CONSTRAINT lot_replica_price_pair
    CHECK ((price_minor_units IS NULL) = (price_currency IS NULL));
