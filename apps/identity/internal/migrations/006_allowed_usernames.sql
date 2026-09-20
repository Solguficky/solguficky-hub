-- +goose Up

CREATE TABLE allowed_usernames (
    id UUID PRIMARY KEY,
    normalized_username TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    used_at TIMESTAMPTZ,
    used_by UUID,
    CONSTRAINT allowed_usernames_normalized_check
        CHECK (
            normalized_username <> ''
            AND normalized_username = lower(normalized_username)
            AND normalized_username NOT LIKE '@%'
        ),
    CONSTRAINT allowed_usernames_usage_check
        CHECK ((used_at IS NULL) = (used_by IS NULL))
);

CREATE UNIQUE INDEX allowed_usernames_active_username
    ON allowed_usernames (normalized_username)
    WHERE used_at IS NULL;

ALTER TABLE identity_access_journal
    ADD COLUMN reason TEXT,
    ADD CONSTRAINT identity_access_journal_reason_check
        CHECK (reason IS NULL OR (action = 'grant' AND reason = 'allowed_username'));

-- +goose Down

ALTER TABLE identity_access_journal
    DROP CONSTRAINT identity_access_journal_reason_check,
    DROP COLUMN reason;

DROP TABLE IF EXISTS allowed_usernames;
