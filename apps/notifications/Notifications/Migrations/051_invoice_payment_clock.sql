-- Пустой срок означает, что аукцион ещё идёт. Напоминать до старта срока нельзя.
ALTER TABLE invoice_replica ALTER COLUMN payment_due_at DROP NOT NULL;
