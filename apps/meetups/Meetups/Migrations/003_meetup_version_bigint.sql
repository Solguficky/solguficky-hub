-- Версия агрегата хранится шире, чем помещается в INTEGER. Домен и контракт
-- `meetups.v1` описывают версию как int64, поэтому запись в INTEGER означала бы
-- сужение на каждой команде: предел недостижим практически, но расхождение
-- ширины пришлось бы держать в голове у каждого, кто пишет путь записи. Дешевле
-- один раз согласовать хранение с доменом, чем возвращаться к проверяемому
-- преобразованию в каждом адаптере.
--
-- Формы IF NOT EXISTS у смены типа нет, но скрипт идемпотентен по результату:
-- перевод уже переведённой колонки в BIGINT ничего не меняет, снятие триггера
-- защищено IF EXISTS, а восстановление идёт через CREATE OR REPLACE.

ALTER TABLE meetups
    ALTER COLUMN version TYPE BIGINT;

-- `version` перечислена в определении триггера неизменяемости записи, а колонку,
-- на которую триггер ссылается по имени, PostgreSQL менять не даёт: `0A000,
-- cannot alter type of a column used in a trigger definition`. Поэтому снятие
-- триггера — обязательный явный шаг миграции, а не побочный эффект; ADR-035
-- предсказывал ровно это для будущей миграции retention. Восстановление ниже
-- повторяет определение из 002 дословно: расхождение здесь тихо открыло бы
-- журнал на запись.
DROP TRIGGER IF EXISTS meetup_events_record_immutable ON meetup_events;

ALTER TABLE meetup_events
    ALTER COLUMN version TYPE BIGINT;

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
