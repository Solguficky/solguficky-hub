-- +goose Up

-- Контекст трассировки запроса, записавшего событие, — заголовок W3C traceparent.
-- Релей публикует строку позже и в другом трейсе, и спан публикации ссылается на
-- трейс запроса только через эту колонку: другого носителя между транзакцией
-- запроса и тиком релея нет. В сообщение шины значение не уходит.
--
-- NULL — строка записана до этой миграции или вне записываемого спана Identity:
-- фикстурой, прямым SQL, без экспорта трейсов или со спаном, отброшенным
-- сэмплером. Формат проверяет схема: разобрать строку релей обязан, а мусор в
-- ней превратился бы в молча потерянную ссылку.
ALTER TABLE identity_outbox
    ADD COLUMN traceparent TEXT,
    ADD CONSTRAINT identity_outbox_traceparent_check
        CHECK (traceparent ~ '^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$');

-- Строка остаётся неизменяемой, кроме отметки публикации: новая колонка входит
-- в сравниваемый кортеж. Без неё правка traceparent вместе с отметкой прошла бы
-- молча.
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
             NEW.traceparent)
            IS NOT DISTINCT FROM
            (OLD.event_id, OLD.position, OLD.identity_id, OLD.version, OLD.occasion,
             OLD.role, OLD.global_roles, OLD.blocked, OLD.occurred_at, OLD.tx_id,
             OLD.traceparent)
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
             NEW.role, NEW.global_roles, NEW.blocked, NEW.occurred_at, NEW.tx_id)
            IS NOT DISTINCT FROM
            (OLD.event_id, OLD.position, OLD.identity_id, OLD.version, OLD.occasion,
             OLD.role, OLD.global_roles, OLD.blocked, OLD.occurred_at, OLD.tx_id)
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'identity_outbox row is immutable except for the publication mark'
        USING ERRCODE = 'ID004';
END;
$$;
-- +goose StatementEnd

ALTER TABLE identity_outbox
    DROP CONSTRAINT IF EXISTS identity_outbox_traceparent_check,
    DROP COLUMN IF EXISTS traceparent;
