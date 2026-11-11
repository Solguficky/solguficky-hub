-- +goose Up

-- Право заводить сходку и быть её организатором (ADR-076, п. 1; PER-743).
-- Идёт с кругом member: держатели круга получают его выводом прав, без строк и
-- событий, как перенос 017 и право 019, — реплика потребителя узнаёт о новом
-- снимке со следующим событием человека. Наборы его не несут, а записью оно не
-- выдаётся: ограничение identity_rights остаётся прежним и строку с ним не
-- примет, а таблица records сервиса отвергает GrantRight.

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION identity_carried_rights(subject UUID)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
    SELECT COALESCE(array_agg(DISTINCT access_right ORDER BY access_right), '{}')
    FROM (
        SELECT by_circle.access_right
        FROM identity_circles c
        CROSS JOIN LATERAL unnest(CASE c.circle
            WHEN 'member' THEN ARRAY['access_hub', 'place_bids', 'organize_meetups']
            ELSE ARRAY[]::TEXT[]
        END) AS by_circle(access_right)
        WHERE c.identity_id = subject AND c.revoked_at IS NULL
        UNION
        SELECT by_preset.access_right
        FROM identity_presets p
        CROSS JOIN LATERAL unnest(CASE p.preset
            WHEN 'admin' THEN ARRAY['admit_bidders', 'manage_members', 'manage_meetups', 'run_auctions']
            WHEN 'maintainer' THEN ARRAY['grant_admins']
            ELSE ARRAY[]::TEXT[]
        END) AS by_preset(access_right)
        WHERE p.identity_id = subject AND p.revoked_at IS NULL
    ) AS carried
    WHERE NOT EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = subject AND pr.blocked);
$$;
-- +goose StatementEnd

-- Словарь снимков outbox расширяется; ограничение повода right_granted и
-- right_revoked прежнее — организатор права записью не получает. Ограничения
-- остаются NOT VALID, как в 017 и 019: проверяются новые строки.
ALTER TABLE identity_outbox DROP CONSTRAINT identity_outbox_rights_check;
ALTER TABLE identity_outbox
    ADD CONSTRAINT identity_outbox_rights_check
        CHECK (rights <@ ARRAY['access_hub', 'place_bids', 'admit_bidders', 'manage_members',
                               'manage_meetups', 'grant_admins', 'run_auctions',
                               'organize_meetups']::TEXT[]
           AND presets <@ ARRAY['admin', 'maintainer']::TEXT[]) NOT VALID;

-- +goose Down

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION identity_carried_rights(subject UUID)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
    SELECT COALESCE(array_agg(DISTINCT access_right ORDER BY access_right), '{}')
    FROM (
        SELECT by_circle.access_right
        FROM identity_circles c
        CROSS JOIN LATERAL unnest(CASE c.circle
            WHEN 'member' THEN ARRAY['access_hub', 'place_bids']
            ELSE ARRAY[]::TEXT[]
        END) AS by_circle(access_right)
        WHERE c.identity_id = subject AND c.revoked_at IS NULL
        UNION
        SELECT by_preset.access_right
        FROM identity_presets p
        CROSS JOIN LATERAL unnest(CASE p.preset
            WHEN 'admin' THEN ARRAY['admit_bidders', 'manage_members', 'manage_meetups', 'run_auctions']
            WHEN 'maintainer' THEN ARRAY['grant_admins']
            ELSE ARRAY[]::TEXT[]
        END) AS by_preset(access_right)
        WHERE p.identity_id = subject AND p.revoked_at IS NULL
    ) AS carried
    WHERE NOT EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = subject AND pr.blocked);
$$;
-- +goose StatementEnd

-- Строки outbox неизменяемы (ID004, ID005), поэтому ограничение возвращается
-- NOT VALID поверх снимков с новым правом, как в откате 019.
ALTER TABLE identity_outbox DROP CONSTRAINT identity_outbox_rights_check;
ALTER TABLE identity_outbox
    ADD CONSTRAINT identity_outbox_rights_check
        CHECK (rights <@ ARRAY['access_hub', 'place_bids', 'admit_bidders', 'manage_members',
                               'manage_meetups', 'grant_admins', 'run_auctions']::TEXT[]
           AND presets <@ ARRAY['admin', 'maintainer']::TEXT[]) NOT VALID;
