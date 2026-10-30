-- Пустой срок означает, что аукцион ещё идёт. Напоминать до старта срока нельзя.
ALTER TABLE invoice_replica ALTER COLUMN payment_due_at DROP NOT NULL;

-- Задание помнит срок, по которому оно было рассчитано: сдвиг due_at не меняет этот снимок.
ALTER TABLE invoice_reminder_task ADD COLUMN IF NOT EXISTS payment_due_at timestamptz;
UPDATE invoice_reminder_task t SET payment_due_at = i.payment_due_at
FROM invoice_replica i WHERE t.invoice_id = i.invoice_id AND t.state = 'scheduled' AND t.payment_due_at IS NULL;
