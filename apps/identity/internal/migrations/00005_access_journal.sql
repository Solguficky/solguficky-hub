-- +goose Up

-- Журнал доступа — append-only история решений о человеке: кто, когда и какое
-- состояние изменил. Людей называет внутренний identity_id, Telegram-данные в
-- журнал не входят. Внешнего ключа на profiles нет намеренно: журнал переживает
-- профиль как история UUID (ADR-038), а не удаляется каскадом вместе с ним.
CREATE TABLE identity_access_journal (
    id UUID PRIMARY KEY,
    identity_id UUID NOT NULL,
    actor_id UUID,
    action TEXT NOT NULL,
    role TEXT,
    occurred_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT identity_access_journal_action_check
        CHECK (action IN ('grant', 'revoke', 'block', 'unblock')),
    CONSTRAINT identity_access_journal_role_presence
        CHECK (
            (action IN ('grant', 'revoke') AND role IS NOT NULL)
            OR (action IN ('block', 'unblock') AND role IS NULL)
        )
);

CREATE INDEX identity_access_journal_identity_occurred
    ON identity_access_journal (identity_id, occurred_at);

-- Append-only держится схемой, а не соглашением: строка журнала неизменяема и не
-- удаляется, а TRUNCATE не проходит через построчный триггер и закрыт отдельно.
-- Коды ID001/ID002 свои, а не 23514: с кодом CHECK-нарушения попытка переписать
-- историю неотличима от нарушения обычного ограничения схемы. Класс ID не занят.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION reject_identity_access_journal_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'identity_access_journal cannot be truncated'
            USING ERRCODE = 'ID002';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'identity_access_journal row cannot be deleted'
            USING ERRCODE = 'ID002';
    END IF;

    RAISE EXCEPTION 'identity_access_journal row is immutable'
        USING ERRCODE = 'ID001';
END;
$$;
-- +goose StatementEnd

CREATE OR REPLACE TRIGGER identity_access_journal_immutable
BEFORE UPDATE
ON identity_access_journal
FOR EACH ROW
EXECUTE FUNCTION reject_identity_access_journal_change();

CREATE OR REPLACE TRIGGER identity_access_journal_undeletable
BEFORE DELETE
ON identity_access_journal
FOR EACH ROW
EXECUTE FUNCTION reject_identity_access_journal_change();

CREATE OR REPLACE TRIGGER identity_access_journal_untruncatable
BEFORE TRUNCATE
ON identity_access_journal
FOR EACH STATEMENT
EXECUTE FUNCTION reject_identity_access_journal_change();

-- Sweep: до этого ограничения выдача роли не проверяла блокировку, и
-- заблокированный профиль мог держать активную роль. Миграция приводит данные к
-- инварианту и записывает системный отзыв актором NULL. GREATEST держит
-- `revoked_at >= granted_at`: выдача могла записать granted_at позже now() этой
-- транзакции, и голый now() уронил бы ограничение вместе со всей миграцией.
WITH revoked AS (
    UPDATE identity_roles
    SET revoked_at = GREATEST(now(), granted_at)
    WHERE revoked_at IS NULL
      AND identity_id IN (SELECT id FROM profiles WHERE blocked)
    RETURNING identity_id, role
)
INSERT INTO identity_access_journal (id, identity_id, actor_id, action, role, occurred_at)
SELECT gen_random_uuid(), identity_id, NULL, 'revoke', role, now() FROM revoked;

-- Проверка блокировки на выдаче живёт и в коде, и здесь. Триггер делает инвариант
-- неустранимым для любого пути выдачи, включая будущую автовыдачу и правку SQL
-- напрямую, и закрывает возврат доступа через revoked_at = NULL. ID003 —
-- «профиль заблокирован», отличимо от нарушения ограничения схемы.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION reject_blocked_identity_role_grant()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.revoked_at IS NULL
       AND (SELECT profiles.blocked FROM profiles WHERE profiles.id = NEW.identity_id) THEN
        RAISE EXCEPTION 'identity is blocked'
            USING ERRCODE = 'ID003';
    END IF;
    RETURN NEW;
END;
$$;
-- +goose StatementEnd

CREATE OR REPLACE TRIGGER identity_roles_blocked_guard
BEFORE INSERT OR UPDATE
ON identity_roles
FOR EACH ROW
EXECUTE FUNCTION reject_blocked_identity_role_grant();

-- +goose Down

DROP TRIGGER IF EXISTS identity_roles_blocked_guard ON identity_roles;
DROP FUNCTION IF EXISTS reject_blocked_identity_role_grant();

DROP TRIGGER IF EXISTS identity_access_journal_untruncatable ON identity_access_journal;
DROP TRIGGER IF EXISTS identity_access_journal_undeletable ON identity_access_journal;
DROP TRIGGER IF EXISTS identity_access_journal_immutable ON identity_access_journal;
DROP FUNCTION IF EXISTS reject_identity_access_journal_change();

DROP TABLE IF EXISTS identity_access_journal;
