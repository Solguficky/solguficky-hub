-- Предел попыток выноса строки в шину и вычеркнутые строки (PER-458).
--
-- Строку, которую шина отвергает всегда, релей повторял бесконечно, и она
-- держала очередь. Теперь отказ, названный свойством самой строки
-- (Facts/BusRejection), считается попыткой, а исчерпавшая предел строка
-- вычёркивается: из очереди выходит, в шину не уходит никогда и называет
-- ошибку. Временный отказ шины попытку не тратит.
--
-- Вычеркнутая — третий исход строки, а не причина снятия. Снятый факт не
-- потерян: его не нужно было доставлять. Вычеркнутый потерян, и смешать их
-- значило бы смешать в одном счётчике то, что ждёт разбора, с тем, что не
-- ждёт.

ALTER TABLE notification ADD COLUMN IF NOT EXISTS dispatch_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE notification ADD COLUMN IF NOT EXISTS rejected_at timestamptz NULL;
ALTER TABLE notification ADD COLUMN IF NOT EXISTS rejection_error text NULL;

-- Ограничения пересоздаются, а не дописываются, как в 009 и 010: так скрипт
-- идемпотентен.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_dispatch_attempts_nonnegative;
ALTER TABLE notification ADD CONSTRAINT notification_dispatch_attempts_nonnegative CHECK (dispatch_attempts >= 0);

-- Вычеркнутая без ошибки неотличима от ошибки записи.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_rejection_has_error;
ALTER TABLE notification ADD CONSTRAINT notification_rejection_has_error CHECK (
    (rejected_at IS NULL) = (rejection_error IS NULL)
);

-- У строки не больше одного исхода: вынесена, снята или вычеркнута. Заменяет
-- notification_withdrawn_not_dispatched из 010, который держал только первую
-- пару. Запрос очереди, забывший про вычеркнутые, падает здесь, а не уносит
-- строку в шину молча.
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_withdrawn_not_dispatched;
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_single_outcome;
ALTER TABLE notification ADD CONSTRAINT notification_single_outcome CHECK (
    num_nonnulls(dispatched_at, withdrawn_at, rejected_at) <= 1
);

-- Очередь релея и оба снятия — при отмене и при закрытой заявке — больше не
-- видят вычеркнутого. Предикат
-- частичного индекса на месте не изменить, поэтому индексы удаляются и
-- строятся заново с новым предикатом.
DROP INDEX IF EXISTS notification_pending_idx;

CREATE INDEX IF NOT EXISTS notification_pending_idx
    ON notification (created_at)
    WHERE dispatched_at IS NULL AND withdrawn_at IS NULL AND rejected_at IS NULL;

DROP INDEX IF EXISTS notification_pending_meetup_idx;

CREATE INDEX IF NOT EXISTS notification_pending_meetup_idx
    ON notification (meetup_id)
    WHERE dispatched_at IS NULL AND withdrawn_at IS NULL AND rejected_at IS NULL;

DROP INDEX IF EXISTS notification_pending_applicant_idx;

CREATE INDEX IF NOT EXISTS notification_pending_applicant_idx
    ON notification (applicant_id)
    WHERE dispatched_at IS NULL AND withdrawn_at IS NULL AND rejected_at IS NULL AND applicant_id IS NOT NULL;

-- Чистка по горизонту хранения (NotificationPruner) индекса не получает:
-- она идёт раз в час по таблице в десятки поводов в день, умноженных на
-- аудиторию сообщества, и последовательный просмотр ей дешевле, чем индекс,
-- который пришлось бы вести на каждой отметке релея.
