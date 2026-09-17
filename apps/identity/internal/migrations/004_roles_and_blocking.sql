-- +goose Up

ALTER TABLE profiles
    ADD COLUMN blocked BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE identity_roles
    DROP CONSTRAINT identity_roles_role_check,
    ADD CONSTRAINT identity_roles_role_check
        CHECK (role IN ('maintainer', 'admin', 'солегуфик', 'комьюнити'));

UPDATE identity_roles AS roles
SET revoked_at = GREATEST(now(), roles.granted_at)
FROM profiles
WHERE roles.identity_id = profiles.id
  AND profiles.access_status IN ('pending', 'blocked')
  AND roles.revoked_at IS NULL;

INSERT INTO identity_roles (id, identity_id, role, granted_at, granted_by)
SELECT gen_random_uuid(), profiles.id, roles.role, profiles.created_at, NULL
FROM profiles
CROSS JOIN (VALUES ('солегуфик'::TEXT), ('комьюнити'::TEXT)) AS roles(role)
WHERE profiles.access_status = 'allowed'
ON CONFLICT (identity_id, role) WHERE revoked_at IS NULL DO NOTHING;

UPDATE profiles
SET blocked = true
WHERE access_status = 'blocked';

ALTER TABLE profiles
    DROP CONSTRAINT profiles_access_status_check,
    DROP COLUMN access_status;

-- +goose Down

ALTER TABLE profiles
    ADD COLUMN access_status TEXT NOT NULL DEFAULT 'pending';

UPDATE profiles
SET access_status = CASE
    WHEN blocked THEN 'blocked'
    WHEN EXISTS (
        SELECT 1
        FROM identity_roles
        WHERE identity_roles.identity_id = profiles.id
          AND identity_roles.role = 'солегуфик'
          AND identity_roles.revoked_at IS NULL
    ) THEN 'allowed'
    ELSE 'pending'
END;

ALTER TABLE profiles
    ALTER COLUMN access_status DROP DEFAULT;

DELETE FROM identity_roles
WHERE role IN ('maintainer', 'солегуфик', 'комьюнити');

ALTER TABLE identity_roles
    DROP CONSTRAINT identity_roles_role_check,
    ADD CONSTRAINT identity_roles_role_check
        CHECK (role IN ('admin'));

ALTER TABLE profiles
    DROP COLUMN blocked,
    ADD CONSTRAINT profiles_access_status_check
        CHECK (access_status IN ('pending', 'allowed', 'blocked'));
