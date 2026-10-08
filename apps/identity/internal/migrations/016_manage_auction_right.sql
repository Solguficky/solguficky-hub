-- +goose Up

-- Право администрировать аукцион — каталог лотов (ADR-064, пункт 7; PER-528).
-- Auction пускает в каталог по праву, а не по роли admin. Право приходит только
-- с кругом admin: записью оно не выдаётся, поэтому словарь identity_rights и
-- поводы right_granted и right_revoked его не принимают. Мейнтейнер с выданным
-- управлением составом его не получает (решение владельца по PER-528), а
-- проекция global_roles не меняется: admin в ней по-прежнему по кругу или по
-- управлению составом.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION identity_access_rights(subject UUID)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
    SELECT COALESCE(array_agg(DISTINCT access_right ORDER BY access_right), '{}')
    FROM (
        SELECT by_circle.access_right
        FROM identity_roles r
        CROSS JOIN LATERAL unnest(CASE r.role
            WHEN 'admin' THEN ARRAY['hub', 'auction', 'manage_membership', 'moderate_auction', 'manage_auction']
            WHEN 'member' THEN ARRAY['hub', 'auction']
            WHEN 'maintainer' THEN ARRAY['hub', 'auction']
            ELSE ARRAY[]::TEXT[]
        END) AS by_circle(access_right)
        WHERE r.identity_id = subject AND r.revoked_at IS NULL
        UNION
        SELECT g.access_right
        FROM identity_rights g
        WHERE g.identity_id = subject AND g.revoked_at IS NULL
    ) AS held
    WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = subject AND p.blocked);
$$;
-- +goose StatementEnd

-- Снимок outbox несёт права целиком, и у администратора теперь их пять.
ALTER TABLE identity_outbox
    DROP CONSTRAINT identity_outbox_rights_check;
ALTER TABLE identity_outbox
    ADD CONSTRAINT identity_outbox_rights_check
        CHECK (rights <@ ARRAY['hub', 'auction', 'manage_membership', 'moderate_auction', 'manage_auction']::TEXT[]);

-- +goose Down

-- Строки outbox неизменяемы и не удаляются (ID004, ID005): снимки с новым
-- правом остаются, и ограничение возвращается NOT VALID, как в откатах 013–015.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION identity_access_rights(subject UUID)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
    SELECT COALESCE(array_agg(DISTINCT access_right ORDER BY access_right), '{}')
    FROM (
        SELECT by_circle.access_right
        FROM identity_roles r
        CROSS JOIN LATERAL unnest(CASE r.role
            WHEN 'admin' THEN ARRAY['hub', 'auction', 'manage_membership', 'moderate_auction']
            WHEN 'member' THEN ARRAY['hub', 'auction']
            WHEN 'maintainer' THEN ARRAY['hub', 'auction']
            ELSE ARRAY[]::TEXT[]
        END) AS by_circle(access_right)
        WHERE r.identity_id = subject AND r.revoked_at IS NULL
        UNION
        SELECT g.access_right
        FROM identity_rights g
        WHERE g.identity_id = subject AND g.revoked_at IS NULL
    ) AS held
    WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = subject AND p.blocked);
$$;
-- +goose StatementEnd

ALTER TABLE identity_outbox
    DROP CONSTRAINT identity_outbox_rights_check;
ALTER TABLE identity_outbox
    ADD CONSTRAINT identity_outbox_rights_check
        CHECK (rights <@ ARRAY['hub', 'auction', 'manage_membership', 'moderate_auction']::TEXT[]) NOT VALID;
