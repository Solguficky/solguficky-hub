-- Счёт виден с продажи, но общий срок известен только после всего аукциона.
ALTER TABLE auction_invoice ALTER COLUMN payment_due_at DROP NOT NULL;

-- Проекция сохраняет фактический момент окончания, а не ориентировочное время финала.
CREATE TABLE auction_payment_clock (
    auction_id uuid PRIMARY KEY,
    payment_due_at timestamptz NOT NULL
);
