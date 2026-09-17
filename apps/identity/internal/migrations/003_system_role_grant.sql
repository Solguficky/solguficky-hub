-- +goose Up

ALTER TABLE identity_roles ALTER COLUMN granted_by DROP NOT NULL;

-- +goose Down

ALTER TABLE identity_roles ALTER COLUMN granted_by SET NOT NULL;
