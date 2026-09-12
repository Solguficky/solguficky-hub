-- Отметка публикации события наружу. Неотправленное выбирается по состоянию
-- строки, а не курсором по `position`: identity выдаёт номер до коммита,
-- поэтому строка с меньшим номером может стать видимой позже уже прочитанной,
-- и high-water mark потерял бы её навсегда. Отметка ставится после принятого
-- для transport подтверждения публикации и не означает ни доставку, ни
-- обработку потребителем.
ALTER TABLE meetup_events
    ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;

-- Индекс держит ровно набор неотправленного и задаёт порядок обхода внутри
-- него. Отправленная строка из индекса выпадает, поэтому он остаётся размером
-- с бэклог публикации, а не с историей.
CREATE INDEX IF NOT EXISTS meetup_events_pending_dispatch
    ON meetup_events (position)
    WHERE dispatched_at IS NULL;

-- Журнал одновременно история и очередь публикации, поэтому граница
-- изменяемости задана схемой, а не соглашением: двигаться может только
-- `dispatched_at`, сама запись события неизменяема и не удаляется. Retention
-- журнала в MVP не проектируется; когда он появится, он снимет эти триггеры
-- своей миграцией — UPDATE и DELETE поодиночке retention не являются.
--
-- Коды свои, а не 23514: с кодом CHECK-нарушения попытка переписать историю
-- неотличима от нарушения обычного ограничения схемы, и адаптер команд не смог
-- бы развести эти случаи. Класс `MT` в PostgreSQL не занят.
CREATE OR REPLACE FUNCTION reject_meetup_event_record_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'meetup_events cannot be truncated'
            USING ERRCODE = 'MT002';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'meetup_events row cannot be deleted'
            USING ERRCODE = 'MT002';
    END IF;

    RAISE EXCEPTION 'meetup_events event record is immutable'
        USING ERRCODE = 'MT001';
END;
$$;

-- Перечисление колонок здесь несущее, а не декоративное: оно и есть граница
-- между неизменяемой записью и подвижной отметкой. `position` в список не
-- входит — identity и без того не даёт себя обновить.
CREATE OR REPLACE TRIGGER meetup_events_record_immutable
BEFORE UPDATE OF
    event_id,
    meetup_id,
    version,
    event_type,
    payload,
    performed_by,
    occurred_at
ON meetup_events
FOR EACH ROW
EXECUTE FUNCTION reject_meetup_event_record_change();

CREATE OR REPLACE TRIGGER meetup_events_row_undeletable
BEFORE DELETE
ON meetup_events
FOR EACH ROW
EXECUTE FUNCTION reject_meetup_event_record_change();

-- TRUNCATE не проходит через строчный триггер: он не удаляет строки по одной,
-- и `FOR EACH ROW` на нём объявить нельзя вовсе. Без этого триггера защита выше
-- закрывала бы DELETE и пропускала способ стереть весь журнал одной командой.
CREATE OR REPLACE TRIGGER meetup_events_untruncatable
BEFORE TRUNCATE
ON meetup_events
FOR EACH STATEMENT
EXECUTE FUNCTION reject_meetup_event_record_change();
