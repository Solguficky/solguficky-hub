-- Материалы сходки — одна упорядоченная коллекция в той же строке состояния, а не
-- вторая таблица. Причина: снимок состояния и тело события остаются одним
-- определением, а запись — одним UPDATE с прежней проверкой версии, поэтому
-- транзакция «состояние и событие» не удлиняется и второй путь чтения, способный
-- обойти предикат видимости, не появляется.
--
-- Массив, а не объект: порядок коллекции и есть порядок элементов. Позиция лежит
-- внутри элемента явно (PER-200), но целостность элементов — уникальность
-- идентификатора и позиции — держит домен, а не CHECK: схема проверяет форму, а
-- битый элемент и так падает как malformed row, не доезжая до потребителя.
ALTER TABLE meetups
    ADD COLUMN IF NOT EXISTS materials JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Снятие перед установкой, как у перечисления поводов ниже: скрипт обязан
-- переживать повторный прогон без журнала (SchemaTests проверяют это свойство), а
-- у ADD CONSTRAINT формы IF NOT EXISTS нет.
ALTER TABLE meetups
    DROP CONSTRAINT IF EXISTS meetups_materials_array;

ALTER TABLE meetups
    ADD CONSTRAINT meetups_materials_array
        CHECK (jsonb_typeof(materials) = 'array');

-- Журнал получает два новых повода: прикрепление и удаление материала. Ограничение
-- перечисляет типы поимённо, поэтому расширяется здесь, а не в 001, и несёт также
-- meetup_held из 005 — DROP+ADD того же ограничения переписывает список целиком.
ALTER TABLE meetup_events
    DROP CONSTRAINT meetup_events_type_check;

ALTER TABLE meetup_events
    ADD CONSTRAINT meetup_events_type_check
    CHECK (event_type IN (
        'meetup_created',
        'meetup_changed',
        'meetup_published',
        'meetup_unpublished',
        'meetup_republished',
        'meetup_cancelled',
        'meetup_held',
        'meetup_material_attached',
        'meetup_material_removed'
    ));
