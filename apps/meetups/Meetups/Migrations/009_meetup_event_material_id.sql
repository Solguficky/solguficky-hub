-- Идентификатор материала — данные повода, которых снимок выразить не может.
-- Контракт `meetups.v1` несёт `material_id` в двух поводах, а удалённого
-- материала в снимке после события уже нет. Без колонки запись журнала перестала
-- бы быть самодостаточной: адаптеру публикации пришлось бы восстанавливать повод
-- по соседней строке, а retention журнала однажды отнял бы и её.
--
-- Колонка, а не ключ внутри payload: payload — снимок (ADR-031), и правило «id
-- есть ровно у событий материала» схема проверяет только у колонки.
ALTER TABLE meetup_events
    ADD COLUMN IF NOT EXISTS material_id UUID;

-- Триггер неизменяемости снимается до заполнения и восстанавливается уже с новой
-- колонкой: при повторном прогоне в нём стоит `material_id`, и UPDATE ниже упал
-- бы с MT001 даже на пустом наборе строк, если бы набор вдруг оказался не пуст.
DROP TRIGGER IF EXISTS meetup_events_record_immutable ON meetup_events;

-- Строки, записанные до этой миграции, получают идентификатор из собственной
-- истории: каждая версия сходки лежит в журнале полным снимком, поэтому материал,
-- который есть в версии N и отсутствует в N-1, и есть прикреплённый, а обратный —
-- удалённый. Подзапрос, вернувший больше одной строки, или повод без пары остановят
-- миграцию — CHECK ниже не примет пустое значение, — и это намеренно: догадка здесь
-- навсегда записала бы в неизменяемую историю чужой материал.
UPDATE meetup_events AS event
SET material_id = (
    SELECT (current_material ->> 'id')::uuid
    FROM jsonb_array_elements(
        CASE event.event_type
            WHEN 'meetup_material_attached' THEN event.payload -> 'materials'
            ELSE previous.payload -> 'materials'
        END
    ) AS current_material
    WHERE NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
            CASE event.event_type
                WHEN 'meetup_material_attached' THEN previous.payload -> 'materials'
                ELSE event.payload -> 'materials'
            END
        ) AS other_material
        WHERE other_material ->> 'id' = current_material ->> 'id'
    )
)
FROM meetup_events AS previous
WHERE previous.meetup_id = event.meetup_id
  AND previous.version = event.version - 1
  AND event.event_type IN ('meetup_material_attached', 'meetup_material_removed')
  AND event.material_id IS NULL;

-- Определение повторяет 008 и добавляет `material_id`: колонка — часть записи
-- события, а не подвижная отметка, и двигаться после вставки не должна.
CREATE OR REPLACE TRIGGER meetup_events_record_immutable
BEFORE UPDATE OF
    event_id,
    meetup_id,
    version,
    event_type,
    payload,
    performed_by,
    occurred_at,
    request_id,
    material_id
ON meetup_events
FOR EACH ROW
EXECUTE FUNCTION reject_meetup_event_record_change();

-- Идентификатор есть ровно у поводов материала: пустой в них — потерянный повод, а
-- заполненный у остальных — значение, которому потребитель не найдёт места.
ALTER TABLE meetup_events
    DROP CONSTRAINT IF EXISTS meetup_events_material_id_occasion;

ALTER TABLE meetup_events
    ADD CONSTRAINT meetup_events_material_id_occasion
    CHECK (
        (event_type IN ('meetup_material_attached', 'meetup_material_removed'))
        = (material_id IS NOT NULL)
    );
