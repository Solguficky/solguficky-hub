-- +goose Up

-- Список разрешённых ников — основание допуска, а не реестр identity. Строка
-- живёт в одном из трёх состояний: непогашенная, погашенная допуском
-- (used_at/used_by) и снятая администратором (removed_at/removed_by). Ни одно
-- из них не удаляет строку: решение о допуске человека в сообщество остаётся
-- видимым так же, как решения в identity_access_journal, у которого для ника
-- места нет — он называет людей внутренним identity_id, а ника у записи списка
-- ещё нет. Актор в created_by и removed_by пустой у операции maintainer'а, как
-- и performed_by журнала. Внешнего ключа на profiles нет намеренно: история
-- переживает профиль (ADR-038).
CREATE TABLE allowed_usernames (
    id UUID PRIMARY KEY,
    normalized_username TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID,
    used_at TIMESTAMPTZ,
    used_by UUID,
    removed_at TIMESTAMPTZ,
    removed_by UUID,
    -- Нормализованный ник — алфавит Telegram в нижнем регистре: пробел, `@` и
    -- прочий мусор не доедут до строки, которую не с чем сопоставить и не
    -- видно в списке.
    CONSTRAINT allowed_usernames_normalized_check
        CHECK (normalized_username ~ '^[a-z0-9_]+$'),
    CONSTRAINT allowed_usernames_usage_check
        CHECK ((used_at IS NULL) = (used_by IS NULL)),
    CONSTRAINT allowed_usernames_removal_check
        CHECK (removed_by IS NULL OR removed_at IS NOT NULL),
    CONSTRAINT allowed_usernames_single_outcome_check
        CHECK (used_at IS NULL OR removed_at IS NULL)
);

CREATE UNIQUE INDEX allowed_usernames_active_username
    ON allowed_usernames (normalized_username)
    WHERE used_at IS NULL AND removed_at IS NULL;

ALTER TABLE identity_access_journal
    ADD COLUMN reason TEXT,
    ADD CONSTRAINT identity_access_journal_reason_check
        CHECK (reason IS NULL OR (action = 'grant' AND reason = 'allowed_username'));

-- +goose Down

ALTER TABLE identity_access_journal
    DROP CONSTRAINT identity_access_journal_reason_check,
    DROP COLUMN reason;

DROP TABLE IF EXISTS allowed_usernames;
