-- Сквозной идентификатор запроса, породившего событие (PER-227). Он живёт в
-- строке журнала, а не только в логе границы: между коммитом команды и
-- публикацией лежит задержка, и релей узнаёт значение только отсюда.
--
-- NULL допустим и означает «граница значения не получила»: вызов без заголовка
-- (ручная диагностика) и все строки, записанные до этой миграции. Пустая строка
-- значением не считается, а предел длины держит недоверенный заголовок от
-- разрастания журнала. Граница (`RequestId.create`) проверяет то же правило
-- строже: любой пробельный символ, а не только пробел, и длину в единицах UTF-16,
-- а не в символах. Поэтому всё, что приняла граница, схема примет; обратное не
-- обещано, и строку, записанную в обход границы, релей прочтёт как «id нет».
ALTER TABLE meetup_events
    ADD COLUMN IF NOT EXISTS request_id TEXT NULL;

ALTER TABLE meetup_events
    DROP CONSTRAINT IF EXISTS meetup_events_request_id_check;

ALTER TABLE meetup_events
    ADD CONSTRAINT meetup_events_request_id_check
    CHECK (request_id IS NULL OR (length(btrim(request_id)) > 0 AND length(request_id) <= 128));

-- Триггер неизменяемости перечисляет колонки по имени, поэтому новая колонка
-- без явного шага осталась бы изменяемой: UPDATE тихо переписал бы, с каким
-- запросом связан факт. Определение повторяет 003 и добавляет одну колонку.
DROP TRIGGER IF EXISTS meetup_events_record_immutable ON meetup_events;

CREATE OR REPLACE TRIGGER meetup_events_record_immutable
BEFORE UPDATE OF
    event_id,
    meetup_id,
    version,
    event_type,
    payload,
    performed_by,
    occurred_at,
    request_id
ON meetup_events
FOR EACH ROW
EXECUTE FUNCTION reject_meetup_event_record_change();
