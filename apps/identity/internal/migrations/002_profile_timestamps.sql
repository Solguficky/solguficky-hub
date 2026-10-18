-- +goose Up

ALTER TABLE profiles
    ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- +goose Down

ALTER TABLE profiles
    DROP COLUMN IF EXISTS updated_at,
    DROP COLUMN IF EXISTS created_at;
