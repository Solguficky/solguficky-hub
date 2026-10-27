-- Напоминание о неоплаченном счёте за 24 часа, за 12 часов и за час до срока
-- оплаты (PER-726) вместо пары PER-330 «через 12 часов после выставления» и
-- «за сутки до срока».
--
-- Виды новых моментов добавлены к известным, а старые остаются в ограничении:
-- сработавшие и снятые строки старой схемы — история счёта, и миграция их не
-- трогает.
ALTER TABLE invoice_reminder_task DROP CONSTRAINT IF EXISTS invoice_reminder_task_kind_known;
ALTER TABLE invoice_reminder_task ADD CONSTRAINT invoice_reminder_task_kind_known CHECK (
    kind IN ('after_win', 'before_due', 'before_24h', 'before_12h', 'before_1h')
);

-- Живые задания старой схемы пересчитываются под новую (решение владельца
-- 26.10.2026): счёт, у которого есть хоть одно несработавшее задание старого
-- вида, получает задания новых видов, а старые снимаются. Сработавшие
-- задания не трогаются: весть уже у человека.
--
-- Правило момента то же, что у грина (`InvoiceReminderMoments`): срок оплаты
-- минус упреждение вида, и момент пропускается, если он не позже выставления
-- счёта с допуском в час — он совпал бы с вестью о покупке. Сверх того здесь
-- пропускается момент, который уже прошёл: пересчёт не должен залпом
-- разослать напоминания в минуту выката.
--
-- Повтор безопасен: вставка гаснет на любой строке того же счёта и вида, а
-- снимаются только живые строки старых видов — после первого прогона их нет.
INSERT INTO invoice_reminder_task (task_id, invoice_id, kind, due_at, state, created_at)
SELECT gen_random_uuid(), replica.invoice_id, lead.kind, replica.payment_due_at - lead.ahead, 'scheduled', now()
FROM invoice_replica AS replica
CROSS JOIN (VALUES
    ('before_24h', interval '24 hours'),
    ('before_12h', interval '12 hours'),
    ('before_1h', interval '1 hour')
) AS lead (kind, ahead)
WHERE replica.status = 'awaiting_payment'
  AND replica.issued_at IS NOT NULL
  AND replica.payment_due_at - lead.ahead > replica.issued_at + interval '1 hour'
  AND replica.payment_due_at - lead.ahead > now()
  AND EXISTS (
      SELECT 1
      FROM invoice_reminder_task AS old
      WHERE old.invoice_id = replica.invoice_id
        AND old.kind IN ('after_win', 'before_due')
        AND old.state = 'scheduled'
  )
  AND NOT EXISTS (
      SELECT 1
      FROM invoice_reminder_task AS task
      WHERE task.invoice_id = replica.invoice_id
        AND task.kind = lead.kind
  )
ON CONFLICT DO NOTHING;

UPDATE invoice_reminder_task
SET state = 'cancelled', reason = 'rescheduled to due leads (PER-726)'
WHERE kind IN ('after_win', 'before_due')
  AND state = 'scheduled';

COMMENT ON TABLE invoice_reminder_task IS
    'Материализованное задание напоминания о неоплаченном счёте: до трёх на счёт — за 24 часа, за 12 часов и за час до срока оплаты. Источник устойчивости момента, а не reminder Orleans.';
