-- Read model счетов проданных лотов (PER-338, integration.md, «Счета»): строка
-- на счёт, которую пишет проекция `invoice-view` журнала счетов одной
-- транзакцией с offset. Источник истины — журнал `invoice|<invoice_id>`; строка
-- отдаёт чтения `ListMyInvoices` и `ListAuctionInvoices` и согласована в
-- конечном счёте.
--
-- Сумма — цена продажи в минорных единицах с валютой; положительной её не
-- требует ни тип, ни торги — лот со стартовой ценой 0 продаётся за 0, — и CHECK
-- на знак остановил бы проекцию на такой продаже. Способ получения пуст,
-- пока победитель его не выбрал. `version` — номер последнего события журнала
-- счёта в строке: повтор события строку не откатывает. CHECK повторяет
-- инварианты типа намеренно: тип защищает только код сервиса.
CREATE TABLE auction_invoice (
    invoice_id     uuid        PRIMARY KEY,
    auction_id     uuid        NOT NULL,
    lot_id         uuid        NOT NULL,
    winner_id      uuid        NOT NULL,
    amount_minor   bigint      NOT NULL,
    currency       text        NOT NULL,
    payment_due_at timestamptz NOT NULL,
    status         text        NOT NULL,
    fulfillment    text,
    version        bigint      NOT NULL,
    CHECK (status IN ('AwaitingPayment', 'Paid', 'HandedOver')),
    CHECK (fulfillment IS NULL OR fulfillment IN ('Pickup', 'Delivery', 'Digital')),
    CHECK (version > 0)
);

-- Сводка организатора — все счета аукциона, счета победителя — его счета в аукционе.
CREATE INDEX auction_invoice_auction_winner ON auction_invoice (auction_id, winner_id);
