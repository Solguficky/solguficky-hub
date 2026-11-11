-- Состав организаторов сходки (ADR-076, п. 3): упорядоченный массив внутренних
-- идентификаторов в той же строке состояния, что и материалы, по той же причине —
-- состояние и событие остаются одной транзакцией с прежней проверкой версии, и
-- второго пути чтения, способного обойти предикат видимости, не появляется.
--
-- Колонка заводится без NOT NULL, заполняется и только потом получает ограничение:
-- повторный прогон скрипта (SchemaTests проверяют это свойство) не должен снова
-- вписывать автора в состав, который администратор успел опустошить.
ALTER TABLE meetups
    ADD COLUMN IF NOT EXISTS organizers UUID[];

-- Сходка, заведённая до появления состава, получает в составе автора: так же её
-- правил бы автор, если бы состав существовал с рождения.
UPDATE meetups
SET organizers = ARRAY[author]
WHERE organizers IS NULL;

ALTER TABLE meetups
    ALTER COLUMN organizers SET NOT NULL;

-- Идентификатор человека в поводе состава. Снимок после снятия человека его уже не
-- содержит, поэтому, как `material_id`, это данные повода, которых снимок выразить
-- не может, и они лежат колонкой, а не ключом payload.
ALTER TABLE meetup_events
    ADD COLUMN IF NOT EXISTS person_id UUID;

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
    request_id,
    material_id,
    person_id
ON meetup_events
FOR EACH ROW
EXECUTE FUNCTION reject_meetup_event_record_change();

ALTER TABLE meetup_events
    DROP CONSTRAINT IF EXISTS meetup_events_type_check;

ALTER TABLE meetup_events
    ADD CONSTRAINT meetup_events_type_check
    CHECK (event_type IN (
        'meetup_created',
        'meetup_changed',
        'meetup_published',
        'meetup_unpublished',
        'meetup_republished',
        'meetup_publication_scheduled',
        'meetup_publication_cancelled',
        'meetup_cancelled',
        'meetup_held',
        'meetup_material_attached',
        'meetup_material_removed',
        'materials_reordered',
        'meetup_organizer_appointed',
        'meetup_organizer_dismissed'
    ));

-- Идентификатор есть ровно у поводов состава.
ALTER TABLE meetup_events
    DROP CONSTRAINT IF EXISTS meetup_events_person_id_occasion;

ALTER TABLE meetup_events
    ADD CONSTRAINT meetup_events_person_id_occasion
    CHECK (
        (event_type IN ('meetup_organizer_appointed', 'meetup_organizer_dismissed'))
        = (person_id IS NOT NULL)
    );
