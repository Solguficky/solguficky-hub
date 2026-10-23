-- +goose Up

-- Право вести аукцион (ADR-065, дополнение 2026-10-18; ADR-070; PER-651).
-- Набор admin несёт его вместе с прежними тремя правами, поэтому держатели
-- набора получают его выводом прав, без строк и событий: реплика потребителя
-- узнаёт о новом снимке со следующим событием человека, как после переноса
-- 017. Участнику право выдаётся поштучной записью, как admit_bidders.

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

ALTER TABLE identity_rights DROP CONSTRAINT identity_rights_access_right_check;
ALTER TABLE identity_rights
    ADD CONSTRAINT identity_rights_access_right_check
        CHECK (access_right IN ('place_bids', 'admit_bidders', 'run_auctions')
            OR (revoked_at IS NOT NULL AND access_right IN (
                'access_hub', 'manage_members', 'manage_meetups', 'grant_admins')));

-- Словарь outbox расширяется: строки истории его подмножество, но ограничения
-- остаются NOT VALID, как в 017, — проверяются новые строки.
ALTER TABLE identity_outbox
    DROP CONSTRAINT identity_outbox_rights_check,
    DROP CONSTRAINT identity_outbox_access_right_presence;
ALTER TABLE identity_outbox
    ADD CONSTRAINT identity_outbox_rights_check
        CHECK (rights <@ ARRAY['access_hub', 'place_bids', 'admit_bidders', 'manage_members',
                               'manage_meetups', 'grant_admins', 'run_auctions']::TEXT[]
           AND presets <@ ARRAY['admin', 'maintainer']::TEXT[]) NOT VALID,
    ADD CONSTRAINT identity_outbox_access_right_presence
        CHECK (
            (occasion IN ('right_granted', 'right_revoked') AND access_right IS NOT NULL
                AND access_right IN ('place_bids', 'admit_bidders', 'run_auctions'))
            OR (occasion NOT IN ('right_granted', 'right_revoked') AND access_right IS NULL)
        ) NOT VALID;

-- +goose Down

-- Живые записи run_auctions снимаются без события, как перенос 017: щит ID006
-- на время отката выключен. Строки outbox неизменяемы (ID004, ID005), и
-- ограничения возвращаются NOT VALID поверх снимков с новым правом.
ALTER TABLE identity_rights DISABLE TRIGGER identity_rights_announced;
UPDATE identity_rights
SET revoked_at = GREATEST(now(), granted_at)
WHERE revoked_at IS NULL AND access_right = 'run_auctions';
ALTER TABLE identity_rights ENABLE TRIGGER identity_rights_announced;

ALTER TABLE identity_rights DROP CONSTRAINT identity_rights_access_right_check;
ALTER TABLE identity_rights
    ADD CONSTRAINT identity_rights_access_right_check
        CHECK (access_right IN ('place_bids', 'admit_bidders')
            OR (revoked_at IS NOT NULL AND access_right IN (
                'access_hub', 'manage_members', 'manage_meetups', 'grant_admins', 'run_auctions')));

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
            WHEN 'admin' THEN ARRAY['admit_bidders', 'manage_members', 'manage_meetups']
            WHEN 'maintainer' THEN ARRAY['grant_admins']
            ELSE ARRAY[]::TEXT[]
        END) AS by_preset(access_right)
        WHERE p.identity_id = subject AND p.revoked_at IS NULL
    ) AS carried
    WHERE NOT EXISTS (SELECT 1 FROM profiles pr WHERE pr.id = subject AND pr.blocked);
$$;
-- +goose StatementEnd

ALTER TABLE identity_outbox
    DROP CONSTRAINT identity_outbox_rights_check,
    DROP CONSTRAINT identity_outbox_access_right_presence;
ALTER TABLE identity_outbox
    ADD CONSTRAINT identity_outbox_rights_check
        CHECK (rights <@ ARRAY['access_hub', 'place_bids', 'admit_bidders', 'manage_members',
                               'manage_meetups', 'grant_admins']::TEXT[]
           AND presets <@ ARRAY['admin', 'maintainer']::TEXT[]) NOT VALID,
    ADD CONSTRAINT identity_outbox_access_right_presence
        CHECK (
            (occasion IN ('right_granted', 'right_revoked') AND access_right IS NOT NULL
                AND access_right IN ('place_bids', 'admit_bidders'))
            OR (occasion NOT IN ('right_granted', 'right_revoked') AND access_right IS NULL)
        ) NOT VALID;
