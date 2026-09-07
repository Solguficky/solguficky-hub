CREATE TABLE IF NOT EXISTS meetup_outbox (
    event_id UUID PRIMARY KEY REFERENCES meetup_events (event_id),
    meetup_id UUID NOT NULL REFERENCES meetups (id),
    version INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    performed_by UUID NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    dispatched_at TIMESTAMPTZ,
    -- Порядок стабильного обхода, но не high-water cursor: identity выдаёт
    -- значение до коммита, поэтому меньшая позиция может стать видимой позже.
    position BIGINT GENERATED ALWAYS AS IDENTITY,
    CONSTRAINT meetup_outbox_version_positive
        CHECK (version >= 1),
    CONSTRAINT meetup_outbox_type_check
        CHECK (event_type IN ('meetup_created', 'meetup_changed', 'meetup_published')),
    CONSTRAINT meetup_outbox_payload_object
        CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT meetup_outbox_meetup_version_key
        UNIQUE (meetup_id, version),
    CONSTRAINT meetup_outbox_position_key
        UNIQUE (position)
);

-- Полный record в outbox не принимается на доверии от приложения: триггер
-- копирует его из уже записанного события журнала по event_id. Так relay не
-- зависит от журнала при чтении, но дублированные поля не могут разойтись.
CREATE OR REPLACE FUNCTION copy_meetup_outbox_record()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.event_id IS DISTINCT FROM OLD.event_id THEN
        RAISE EXCEPTION 'meetup_outbox.event_id is immutable'
            USING ERRCODE = '23514';
    END IF;

    SELECT
        meetup_id,
        version,
        event_type,
        payload,
        performed_by,
        occurred_at
    INTO
        NEW.meetup_id,
        NEW.version,
        NEW.event_type,
        NEW.payload,
        NEW.performed_by,
        NEW.occurred_at
    FROM meetup_events
    WHERE event_id = NEW.event_id;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS meetup_outbox_copy_record ON meetup_outbox;

CREATE TRIGGER meetup_outbox_copy_record
BEFORE INSERT OR UPDATE OF
    event_id,
    meetup_id,
    version,
    event_type,
    payload,
    performed_by,
    occurred_at
ON meetup_outbox
FOR EACH ROW
EXECUTE FUNCTION copy_meetup_outbox_record();

-- Outbox копирует канонические поля в момент вставки, поэтому эти поля
-- журнала после этого неизменяемы. Retention отдельным решением сможет
-- заменить это правило своей миграцией; UPDATE не является retention.
CREATE OR REPLACE FUNCTION reject_meetup_event_record_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'meetup_events event record is immutable'
        USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS meetup_events_record_immutable ON meetup_events;

CREATE TRIGGER meetup_events_record_immutable
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
EXECUTE FUNCTION reject_meetup_event_record_update();

CREATE INDEX IF NOT EXISTS meetup_outbox_pending_dispatch
    ON meetup_outbox (position)
    WHERE dispatched_at IS NULL;
