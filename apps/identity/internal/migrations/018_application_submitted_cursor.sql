-- +goose Up

-- Новая заявка называет себя в событии (PER-634): идентификатор и момент
-- создания — курсор карточки, по которому бот получателя читает её из очереди
-- правами модератора. Строки, записанные до миграции и ещё не опубликованные,
-- колонок не несут и уходят прежним событием без курсора, поэтому
-- обязательности для application_submitted схема не ставит: пару держит
-- код записи, а схема — только то, что пара полна и стоит у своего повода.
ALTER TABLE identity_outbox
    ADD COLUMN application_id UUID,
    ADD COLUMN application_created_at TIMESTAMPTZ,
    ADD CONSTRAINT identity_outbox_application_presence
        CHECK (
            (application_id IS NULL) = (application_created_at IS NULL)
            AND (occasion = 'application_submitted' OR application_id IS NULL)
        );

-- Новые колонки входят в сравниваемый кортеж неизменяемой строки: без них
-- правка курсора вместе с отметкой прошла бы молча.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION reject_identity_outbox_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'identity_outbox cannot be truncated'
            USING ERRCODE = 'ID005';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'identity_outbox row cannot be deleted'
            USING ERRCODE = 'ID005';
    END IF;

    IF OLD.published_at IS NULL
        AND NEW.published_at IS NOT NULL
        AND (NEW.event_id, NEW.position, NEW.identity_id, NEW.version, NEW.occasion,
             NEW.role, NEW.global_roles, NEW.blocked, NEW.occurred_at, NEW.tx_id,
             NEW.traceparent, NEW.circle, NEW.rights, NEW.access_right,
             NEW.presets, NEW.preset, NEW.previous_circle, NEW.queue,
             NEW.application_id, NEW.application_created_at)
            IS NOT DISTINCT FROM
            (OLD.event_id, OLD.position, OLD.identity_id, OLD.version, OLD.occasion,
             OLD.role, OLD.global_roles, OLD.blocked, OLD.occurred_at, OLD.tx_id,
             OLD.traceparent, OLD.circle, OLD.rights, OLD.access_right,
             OLD.presets, OLD.preset, OLD.previous_circle, OLD.queue,
             OLD.application_id, OLD.application_created_at)
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'identity_outbox row is immutable except for the publication mark'
        USING ERRCODE = 'ID004';
END;
$$;
-- +goose StatementEnd

-- +goose Down

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION reject_identity_outbox_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'identity_outbox cannot be truncated'
            USING ERRCODE = 'ID005';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'identity_outbox row cannot be deleted'
            USING ERRCODE = 'ID005';
    END IF;

    IF OLD.published_at IS NULL
        AND NEW.published_at IS NOT NULL
        AND (NEW.event_id, NEW.position, NEW.identity_id, NEW.version, NEW.occasion,
             NEW.role, NEW.global_roles, NEW.blocked, NEW.occurred_at, NEW.tx_id,
             NEW.traceparent, NEW.circle, NEW.rights, NEW.access_right,
             NEW.presets, NEW.preset, NEW.previous_circle, NEW.queue)
            IS NOT DISTINCT FROM
            (OLD.event_id, OLD.position, OLD.identity_id, OLD.version, OLD.occasion,
             OLD.role, OLD.global_roles, OLD.blocked, OLD.occurred_at, OLD.tx_id,
             OLD.traceparent, OLD.circle, OLD.rights, OLD.access_right,
             OLD.presets, OLD.preset, OLD.previous_circle, OLD.queue)
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'identity_outbox row is immutable except for the publication mark'
        USING ERRCODE = 'ID004';
END;
$$;
-- +goose StatementEnd

-- Колонки снимаются вместе с курсором неопубликованных строк: событие уйдёт
-- без него, как до миграции.
ALTER TABLE identity_outbox
    DROP CONSTRAINT identity_outbox_application_presence,
    DROP COLUMN application_created_at,
    DROP COLUMN application_id;
