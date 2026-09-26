-- Срок годности и снятие неотправленных адресных фактов (PER-219).
--
-- Между порождением факта и выносом в шину проходит время: в норме один
-- период релея, при лежащей шине — сколько она лежит. Факт, который за это
-- время устарел или потерял сходку, в шину не уходит, но и не исчезает:
-- строка остаётся журналом и называет причину. Так снятый факт отличается от
-- потерянного — тот висит без обеих отметок, и его видно по возрасту
-- старейшего неотправленного.
--
-- Уже вынесенное в шину не трогается: отозвать его нечем, обратной связи с
-- каналом нет (ADR-028), а отзыва доставленного сообщения нет в продукте.

-- Момент, после которого факт доставлять не нужно; копия поля not_after из
-- payload. Колонка нужна релею: разбирать payload ради срока он не должен.
-- Пусто у строк до этой миграции — у них срока нет, как и в контракте.
ALTER TABLE notification ADD COLUMN IF NOT EXISTS not_after timestamptz NULL;

-- Отметка снятия и её причина. Снятая строка не выносится в шину никогда.
ALTER TABLE notification ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz NULL;
ALTER TABLE notification ADD COLUMN IF NOT EXISTS withdrawal_reason text NULL;

-- Ограничения пересоздаются, а не дописываются, как в 009: так скрипт
-- идемпотентен.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_withdrawal_reason_known;
ALTER TABLE notification ADD CONSTRAINT notification_withdrawal_reason_known CHECK (
    withdrawal_reason IN ('meetup_cancelled', 'expired')
);

-- Отметка и причина появляются вместе: снятие без причины неотличимо от
-- ошибки записи.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_withdrawal_has_reason;
ALTER TABLE notification ADD CONSTRAINT notification_withdrawal_has_reason CHECK (
    (withdrawn_at IS NULL) = (withdrawal_reason IS NULL)
);

-- «Снят, но вынесен в шину» — противоречие, и держит его схема, а не порядок
-- операций в коде: гонку снятия с релеем разводит блокировка строки, а это
-- ограничение ловит ошибку, если развести не удалось.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_withdrawn_not_dispatched;
ALTER TABLE notification ADD CONSTRAINT notification_withdrawn_not_dispatched CHECK (
    withdrawn_at IS NULL OR dispatched_at IS NULL
);

-- Очередь релея больше не содержит снятого. Предикат частичного индекса на
-- месте не меняется, поэтому индекс строится заново.
DROP INDEX IF EXISTS notification_pending_idx;

CREATE INDEX IF NOT EXISTS notification_pending_idx
    ON notification (created_at)
    WHERE dispatched_at IS NULL AND withdrawn_at IS NULL;

-- Снятие при отмене ищет неотправленное по сходке.
CREATE INDEX IF NOT EXISTS notification_pending_meetup_idx
    ON notification (meetup_id)
    WHERE dispatched_at IS NULL AND withdrawn_at IS NULL;
