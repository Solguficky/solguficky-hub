-- +goose Up

CREATE TABLE profiles (
    id UUID PRIMARY KEY,
    telegram_user_id BIGINT NOT NULL,
    username TEXT,
    access_status TEXT NOT NULL,
    CONSTRAINT profiles_telegram_user_id_key UNIQUE (telegram_user_id),
    CONSTRAINT profiles_telegram_user_id_positive CHECK (telegram_user_id > 0),
    CONSTRAINT profiles_access_status_check CHECK (access_status IN ('pending', 'allowed', 'blocked'))
);

CREATE TABLE identity_roles (
    id UUID PRIMARY KEY,
    identity_id UUID NOT NULL REFERENCES profiles (id),
    role TEXT NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL,
    granted_by UUID NOT NULL REFERENCES profiles (id),
    revoked_at TIMESTAMPTZ,
    CONSTRAINT identity_roles_role_check CHECK (role IN ('admin')),
    CONSTRAINT identity_roles_revoked_after_granted CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);

CREATE UNIQUE INDEX identity_roles_active_identity_role
    ON identity_roles (identity_id, role)
    WHERE revoked_at IS NULL;

-- +goose Down

DROP TABLE IF EXISTS identity_roles;
DROP TABLE IF EXISTS profiles;
