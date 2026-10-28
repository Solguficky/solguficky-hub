-- Внутренний статус закрытого обязательства (PER-694). Публичный статус
-- и факт вводятся отдельно в PER-805; старые строки и условия не меняются.
ALTER TABLE auction_invoice DROP CONSTRAINT auction_invoice_status_check;
ALTER TABLE auction_invoice ADD CONSTRAINT auction_invoice_status_check
    CHECK (status IN ('AwaitingPayment', 'Paid', 'HandedOver', 'Unredeemed'));
