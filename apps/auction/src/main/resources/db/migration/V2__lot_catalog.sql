-- Каталожные атрибуты лота: строка состояния, а не журнал (ADR-057,
-- docs/decisions/ADR-057-auction-lot-catalog-as-state.md). Условия торгов
-- сюда не попадают — они живут только в журнале лота.
--
-- CHECK повторяет инвариант LotTitle намеренно: тип защищает только код
-- сервиса, а в таблицу может писать и то, что его обходит.
CREATE TABLE lot_catalog (
    lot_id      uuid PRIMARY KEY,
    title       text NOT NULL CHECK (btrim(title) <> ''),
    description text NOT NULL
);
