-- +goose Up

-- Очередь аукциона и права отдельно от круга (ADR-064, пункты 7–9 и 15;
-- PER-527, PER-541).
--
-- Отказ по очереди — declined только этой заявки: отказ в аукцион больше не
-- блокирует. Ключ очереди в хранилище — по-прежнему круг заявки:
-- requested_role = 'member' — очередь сообщества, 'guest' — очередь аукциона,
-- которая выдаёт право auction и круг guest, если круга ещё нет. Исход blocked
-- остаётся только у заявок, отказанных до этой миграции, и только на guest.
ALTER TABLE identity_applications
    DROP CONSTRAINT identity_applications_refusal_circle_check;
ALTER TABLE identity_applications
    ADD CONSTRAINT identity_applications_refusal_circle_check
        CHECK (outcome IS DISTINCT FROM 'blocked' OR requested_role = 'guest');

-- Поводы right_granted и right_revoked: право выдано или отозвано отдельно от
-- круга — модерация аукциона участнику, право аукциона гостю, у которого круг
-- уже есть. Право события лежит своей колонкой, а не в role: role называет
-- круг, и словари не смешиваются. Ограничения пересоздаются, а не дописываются,
-- как в 013: без своей ветки в identity_outbox_snapshot_check выражение CASE
-- дало бы NULL, и CHECK пропустил бы строку молча.
ALTER TABLE identity_outbox
    ADD COLUMN access_right TEXT,
    DROP CONSTRAINT identity_outbox_occasion_check,
    DROP CONSTRAINT identity_outbox_snapshot_check;

ALTER TABLE identity_outbox
    ADD CONSTRAINT identity_outbox_occasion_check
        CHECK (occasion IN (
            'profile_registered', 'role_granted', 'role_revoked',
            'profile_blocked', 'profile_unblocked', 'application_submitted',
            'application_admitted', 'right_granted', 'right_revoked')),
    -- Пустое право отвергается явно: IN на NULL даёт NULL, а CHECK пропускает NULL.
    ADD CONSTRAINT identity_outbox_access_right_presence
        CHECK (
            (occasion IN ('right_granted', 'right_revoked') AND access_right IS NOT NULL
                AND access_right IN ('hub', 'auction', 'manage_membership', 'moderate_auction'))
            OR (occasion NOT IN ('right_granted', 'right_revoked') AND access_right IS NULL)
        ),
    ADD CONSTRAINT identity_outbox_snapshot_check
        CHECK (
            CASE occasion
                WHEN 'profile_registered' THEN version = 1 AND NOT blocked
                WHEN 'role_granted' THEN role = ANY (global_roles) AND NOT blocked
                WHEN 'role_revoked' THEN NOT (role = ANY (global_roles))
                WHEN 'profile_blocked' THEN blocked AND cardinality(global_roles) = 0
                WHEN 'profile_unblocked' THEN NOT blocked
                WHEN 'application_submitted' THEN NOT blocked AND NOT (role = ANY (global_roles))
                WHEN 'application_admitted' THEN role = ANY (global_roles) AND NOT blocked
                WHEN 'right_granted' THEN access_right = ANY (rights) AND NOT blocked
                WHEN 'right_revoked' THEN NOT (access_right = ANY (COALESCE(rights, '{}')))
            END
        );

-- Новая колонка входит в сравниваемый кортеж неизменяемой строки, как circle и
-- rights в 014: без неё правка повода вместе с отметкой прошла бы молча.
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
             NEW.traceparent, NEW.circle, NEW.rights, NEW.access_right)
            IS NOT DISTINCT FROM
            (OLD.event_id, OLD.position, OLD.identity_id, OLD.version, OLD.occasion,
             OLD.role, OLD.global_roles, OLD.blocked, OLD.occurred_at, OLD.tx_id,
             OLD.traceparent, OLD.circle, OLD.rights, OLD.access_right)
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'identity_outbox row is immutable except for the publication mark'
        USING ERRCODE = 'ID004';
END;
$$;
-- +goose StatementEnd

-- +goose Down

-- Строки outbox неизменяемы и не удаляются (ID004, ID005), поэтому поводы прав
-- остаются, а ограничения 013 и 014 возвращаются NOT VALID: новые строки они
-- держат, старые не перепроверяют. Колонка права остаётся по той же причине:
-- её удаление переписало бы строки. Отказы declined на guest остаются, и
-- ограничение отказа по кругу возвращается NOT VALID.

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
             NEW.traceparent, NEW.circle, NEW.rights)
            IS NOT DISTINCT FROM
            (OLD.event_id, OLD.position, OLD.identity_id, OLD.version, OLD.occasion,
             OLD.role, OLD.global_roles, OLD.blocked, OLD.occurred_at, OLD.tx_id,
             OLD.traceparent, OLD.circle, OLD.rights)
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'identity_outbox row is immutable except for the publication mark'
        USING ERRCODE = 'ID004';
END;
$$;
-- +goose StatementEnd

ALTER TABLE identity_outbox
    DROP CONSTRAINT identity_outbox_occasion_check,
    DROP CONSTRAINT identity_outbox_access_right_presence,
    DROP CONSTRAINT identity_outbox_snapshot_check;

ALTER TABLE identity_outbox
    ADD CONSTRAINT identity_outbox_occasion_check
        CHECK (occasion IN (
            'profile_registered', 'role_granted', 'role_revoked',
            'profile_blocked', 'profile_unblocked', 'application_submitted',
            'application_admitted')) NOT VALID,
    ADD CONSTRAINT identity_outbox_snapshot_check
        CHECK (
            CASE occasion
                WHEN 'profile_registered' THEN version = 1 AND NOT blocked
                WHEN 'role_granted' THEN role = ANY (global_roles) AND NOT blocked
                WHEN 'role_revoked' THEN NOT (role = ANY (global_roles))
                WHEN 'profile_blocked' THEN blocked AND cardinality(global_roles) = 0
                WHEN 'profile_unblocked' THEN NOT blocked
                WHEN 'application_submitted' THEN NOT blocked AND NOT (role = ANY (global_roles))
                WHEN 'application_admitted' THEN role = ANY (global_roles) AND NOT blocked
            END
        ) NOT VALID;

ALTER TABLE identity_applications
    DROP CONSTRAINT identity_applications_refusal_circle_check;
ALTER TABLE identity_applications
    ADD CONSTRAINT identity_applications_refusal_circle_check
        CHECK ((outcome IS DISTINCT FROM 'blocked' OR requested_role = 'guest')
           AND (outcome IS DISTINCT FROM 'declined' OR requested_role = 'member')) NOT VALID;
