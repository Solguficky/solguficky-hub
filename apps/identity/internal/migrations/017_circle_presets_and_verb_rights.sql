-- +goose Up

-- Круг без ранга, наборы и права с глаголом (RFC-016; ADR о наборах). Круг —
-- только аудитория: member или guest, ровно один или никакого. Допуск решают
-- права: часть приходит с кругом, часть — с живыми наборами admin и maintainer,
-- часть выдаётся поштучной записью. Слово «роль» уходит из хранилища: таблица
-- кругов, ключ очереди заявки, круг белого списка и журнал доступа называют то,
-- что хранят.
--
-- Перенос данных stage событий не пишет, как перенос 014: щиты ID006 на время
-- переноса выключены. Реплика потребителя узнаёт о новом снимке со следующим
-- событием человека.

-- Заблокированный профиль активного круга не держит; строка мимо блокировки
-- уронила бы перенос отказом без указания профиля.
-- +goose StatementBegin
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM identity_roles r JOIN profiles p ON p.id = r.identity_id
        WHERE p.blocked AND r.revoked_at IS NULL
    ) THEN
        RAISE EXCEPTION 'a blocked profile holds an active role: revoke it before migrating';
    END IF;
END;
$$;
-- +goose StatementEnd

ALTER TABLE identity_roles DISABLE TRIGGER identity_roles_announced;
ALTER TABLE identity_roles DISABLE TRIGGER identity_roles_blocked_guard;
ALTER TABLE identity_rights DISABLE TRIGGER identity_rights_announced;

-- Наборы — живые строки, как круги и записи: выдача и снятие — отметки, а не
-- удаление, и у заблокированного активного набора нет.
CREATE TABLE identity_presets (
    id UUID PRIMARY KEY,
    identity_id UUID NOT NULL REFERENCES profiles (id),
    preset TEXT NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL,
    granted_by UUID REFERENCES profiles (id),
    revoked_at TIMESTAMPTZ,
    CONSTRAINT identity_presets_preset_check
        CHECK (preset IN ('admin', 'maintainer')),
    CONSTRAINT identity_presets_revoked_after_granted
        CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);

CREATE UNIQUE INDEX identity_presets_active_identity_preset
    ON identity_presets (identity_id, preset)
    WHERE revoked_at IS NULL;

-- Перенос stage (вопрос О-6): круг admin — участник с набором admin; круг
-- maintainer — участник с наборами maintainer и admin, потому что мейнтейнер
-- stage ведёт и сходки, а выдать admin себе он смог бы и сам.
INSERT INTO identity_presets (id, identity_id, preset, granted_at, granted_by)
SELECT gen_random_uuid(), r.identity_id, granted.preset, now(), NULL
FROM identity_roles r
CROSS JOIN LATERAL unnest(CASE r.role
    WHEN 'admin' THEN ARRAY['admin']
    WHEN 'maintainer' THEN ARRAY['maintainer', 'admin']
END) AS granted(preset)
WHERE r.revoked_at IS NULL AND r.role IN ('admin', 'maintainer');

UPDATE identity_roles
SET revoked_at = GREATEST(now(), granted_at)
WHERE revoked_at IS NULL AND role IN ('admin', 'maintainer');

INSERT INTO identity_roles (id, identity_id, role, granted_at, granted_by)
SELECT gen_random_uuid(), p.identity_id, 'member', now(), NULL
FROM (SELECT DISTINCT identity_id FROM identity_presets) AS p
WHERE NOT EXISTS (
    SELECT 1 FROM identity_roles r
    WHERE r.identity_id = p.identity_id AND r.revoked_at IS NULL);

-- Таблица кругов называется тем, что хранит. Строки истории сохраняют прежние
-- имена admin и maintainer: активной строки с ними больше нет, и ограничение
-- держит это для будущих строк.
ALTER TABLE identity_roles RENAME TO identity_circles;
ALTER TABLE identity_circles RENAME COLUMN role TO circle;
ALTER TABLE identity_circles DROP CONSTRAINT identity_roles_role_check;
ALTER TABLE identity_circles
    ADD CONSTRAINT identity_circles_circle_check
        CHECK (circle IN ('member', 'guest')
            OR (revoked_at IS NOT NULL AND circle IN ('admin', 'maintainer')));
ALTER TABLE identity_circles
    RENAME CONSTRAINT identity_roles_revoked_after_granted TO identity_circles_revoked_after_granted;
ALTER INDEX identity_roles_active_identity_role RENAME TO identity_circles_active_identity_circle;
ALTER INDEX identity_roles_one_active RENAME TO identity_circles_one_active;
ALTER TRIGGER identity_roles_announced ON identity_circles RENAME TO identity_circles_announced;
ALTER TRIGGER identity_roles_blocked_guard ON identity_circles RENAME TO identity_circles_blocked_guard;

-- Права с глаголом. История переименовывается целиком: словарь схемы один.
-- Записью выдаются только place_bids гостю и admit_bidders участнику; записи
-- управления, которые теперь несёт набор admin, и admit_bidders у держателя
-- набора снимаются, а hub приходит с кругом и записью не бывает.
ALTER TABLE identity_rights DROP CONSTRAINT identity_rights_access_right_check;

UPDATE identity_rights
SET revoked_at = GREATEST(now(), granted_at)
WHERE revoked_at IS NULL
  AND (access_right IN ('hub', 'manage_membership', 'manage_auction')
       OR (access_right = 'moderate_auction' AND EXISTS (
           SELECT 1 FROM identity_presets p
           WHERE p.identity_id = identity_rights.identity_id AND p.revoked_at IS NULL)));

UPDATE identity_rights SET access_right = CASE access_right
    WHEN 'hub' THEN 'access_hub'
    WHEN 'auction' THEN 'place_bids'
    WHEN 'manage_membership' THEN 'manage_members'
    WHEN 'moderate_auction' THEN 'admit_bidders'
    WHEN 'manage_auction' THEN 'manage_meetups'
END;

ALTER TABLE identity_rights
    ADD CONSTRAINT identity_rights_access_right_check
        CHECK (access_right IN ('place_bids', 'admit_bidders')
            OR (revoked_at IS NOT NULL AND access_right IN (
                'access_hub', 'manage_members', 'manage_meetups', 'grant_admins')));

ALTER TABLE identity_circles ENABLE TRIGGER identity_circles_announced;
ALTER TABLE identity_circles ENABLE TRIGGER identity_circles_blocked_guard;
ALTER TABLE identity_rights ENABLE TRIGGER identity_rights_announced;

-- Щиты кругов и записей действуют и на наборы: выдача заблокированному
-- отвергается (ID003), выдача и снятие без события той же транзакции не
-- фиксируются (ID006).
CREATE OR REPLACE TRIGGER identity_presets_blocked_guard
BEFORE INSERT OR UPDATE
ON identity_presets
FOR EACH ROW
EXECUTE FUNCTION reject_blocked_identity_role_grant();

CREATE CONSTRAINT TRIGGER identity_presets_announced
AFTER INSERT OR UPDATE
ON identity_presets
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION reject_unannounced_identity_change();

-- Ключ очереди заявки — очередь, а не круг: community и auction.
ALTER TABLE identity_applications
    DROP CONSTRAINT identity_applications_requested_role_check,
    DROP CONSTRAINT identity_applications_refusal_circle_check;
ALTER TABLE identity_applications RENAME COLUMN requested_role TO queue;
UPDATE identity_applications
SET queue = CASE queue WHEN 'member' THEN 'community' ELSE 'auction' END;
ALTER TABLE identity_applications
    ADD CONSTRAINT identity_applications_queue_check
        CHECK (queue IN ('community', 'auction')),
    -- Исход blocked остался только у отказов в аукцион до PER-527.
    ADD CONSTRAINT identity_applications_refusal_queue_check
        CHECK (outcome IS DISTINCT FROM 'blocked' OR queue = 'auction');
ALTER INDEX identity_applications_open_identity_role RENAME TO identity_applications_open_identity_queue;

-- Белый список выдаёт круг.
ALTER TABLE allowed_usernames RENAME COLUMN grants_role TO grants_circle;
ALTER TABLE allowed_usernames
    RENAME CONSTRAINT allowed_usernames_grants_role_check TO allowed_usernames_grants_circle_check;

-- Журнал доступа называет круг или набор. Строки неизменяемы (ID001) и хранят
-- прежние имена кругов admin и maintainer; новая строка выдачи или отзыва
-- называет ровно одно из двух.
ALTER TABLE identity_access_journal RENAME COLUMN role TO circle;
ALTER TABLE identity_access_journal
    ADD COLUMN preset TEXT,
    DROP CONSTRAINT identity_access_journal_role_presence;
ALTER TABLE identity_access_journal
    ADD CONSTRAINT identity_access_journal_subject_presence
        CHECK (
            (action IN ('grant', 'revoke') AND num_nonnulls(circle, preset) = 1)
            OR (action IN ('block', 'unblock') AND circle IS NULL AND preset IS NULL)
        ),
    ADD CONSTRAINT identity_access_journal_preset_check
        CHECK (preset IN ('admin', 'maintainer'));

-- Вывод прав — одно место для всех читателей (ответы, проверка права, снимок
-- outbox). Права круга и наборов — identity_carried_rights: их запись не
-- снимает. Права друг друга не подразумевают; заблокированный прав не держит.
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

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION identity_access_rights(subject UUID)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
    SELECT COALESCE(array_agg(DISTINCT access_right ORDER BY access_right), '{}')
    FROM (
        SELECT unnest(identity_carried_rights(subject)) AS access_right
        UNION
        SELECT g.access_right
        FROM identity_rights g
        WHERE g.identity_id = subject AND g.revoked_at IS NULL
    ) AS held
    WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = subject AND p.blocked);
$$;
-- +goose StatementEnd

-- Наборы для показа людям; у заблокированного их нет, как и прав, даже если
-- строка осталась мимо блокировки.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION identity_active_presets(subject UUID)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
    SELECT COALESCE(array_agg(preset ORDER BY preset), '{}')
    FROM identity_presets
    WHERE identity_id = subject AND revoked_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = subject AND p.blocked);
$$;
-- +goose StatementEnd

DROP FUNCTION identity_global_roles(UUID);

-- Outbox. Неотправленные строки прежнего словаря новый контракт выразить не
-- может (поводов role_granted и role_revoked в нём нет), поэтому они получают
-- отметку публикации без публикации: следующий снимок человека несёт его
-- состояние целиком. Отметку неизменяемость строки допускает (ID004).
UPDATE identity_outbox
SET published_at = GREATEST(now(), occurred_at)
WHERE published_at IS NULL;

ALTER TABLE identity_outbox
    ALTER COLUMN global_roles DROP NOT NULL,
    ADD COLUMN presets TEXT[],
    ADD COLUMN preset TEXT,
    ADD COLUMN previous_circle TEXT,
    ADD COLUMN queue TEXT,
    DROP CONSTRAINT identity_outbox_occasion_check,
    DROP CONSTRAINT identity_outbox_role_presence,
    DROP CONSTRAINT identity_outbox_global_roles_check,
    DROP CONSTRAINT identity_outbox_snapshot_check,
    DROP CONSTRAINT identity_outbox_access_right_presence,
    DROP CONSTRAINT identity_outbox_rights_check,
    DROP CONSTRAINT identity_outbox_circle_check;

-- Ограничения нового словаря — NOT VALID: строки истории неизменяемы и несут
-- прежний, а новые строки и любая будущая отметка публикации проверяются. Все
-- строки истории уже отмечены выше, поэтому отметка их больше не трогает.
ALTER TABLE identity_outbox
    ADD CONSTRAINT identity_outbox_occasion_check
        CHECK (occasion IN (
            'profile_registered', 'profile_blocked', 'profile_unblocked',
            'application_submitted', 'application_admitted',
            'right_granted', 'right_revoked',
            'circle_changed', 'preset_granted', 'preset_revoked')) NOT VALID,
    ADD CONSTRAINT identity_outbox_role_absence
        CHECK (role IS NULL AND global_roles IS NULL) NOT VALID,
    ADD CONSTRAINT identity_outbox_snapshot_presence
        CHECK (rights IS NOT NULL AND presets IS NOT NULL) NOT VALID,
    ADD CONSTRAINT identity_outbox_circle_check
        CHECK (circle IN ('member', 'guest') AND previous_circle IN ('member', 'guest')) NOT VALID,
    ADD CONSTRAINT identity_outbox_rights_check
        CHECK (rights <@ ARRAY['access_hub', 'place_bids', 'admit_bidders', 'manage_members',
                               'manage_meetups', 'grant_admins']::TEXT[]
           AND presets <@ ARRAY['admin', 'maintainer']::TEXT[]) NOT VALID,
    -- Пустое значение отвергается явно: IN на NULL даёт NULL, а CHECK его пропускает.
    ADD CONSTRAINT identity_outbox_access_right_presence
        CHECK (
            (occasion IN ('right_granted', 'right_revoked') AND access_right IS NOT NULL
                AND access_right IN ('place_bids', 'admit_bidders'))
            OR (occasion NOT IN ('right_granted', 'right_revoked') AND access_right IS NULL)
        ) NOT VALID,
    ADD CONSTRAINT identity_outbox_preset_presence
        CHECK (
            (occasion IN ('preset_granted', 'preset_revoked') AND preset IS NOT NULL
                AND preset IN ('admin', 'maintainer'))
            OR (occasion NOT IN ('preset_granted', 'preset_revoked') AND preset IS NULL)
        ) NOT VALID,
    ADD CONSTRAINT identity_outbox_queue_presence
        CHECK (
            (occasion IN ('application_submitted', 'application_admitted') AND queue IS NOT NULL
                AND queue IN ('community', 'auction'))
            OR (occasion NOT IN ('application_submitted', 'application_admitted') AND queue IS NULL)
        ) NOT VALID,
    ADD CONSTRAINT identity_outbox_previous_circle_presence
        CHECK (occasion = 'circle_changed' OR previous_circle IS NULL) NOT VALID,
    ADD CONSTRAINT identity_outbox_snapshot_check
        CHECK (
            CASE occasion
                WHEN 'profile_registered' THEN version = 1 AND NOT blocked
                WHEN 'profile_blocked' THEN blocked AND circle IS NULL
                    AND cardinality(presets) = 0 AND cardinality(rights) = 0
                WHEN 'profile_unblocked' THEN NOT blocked
                WHEN 'application_submitted' THEN NOT blocked
                WHEN 'application_admitted' THEN NOT blocked
                WHEN 'right_granted' THEN access_right = ANY (rights) AND NOT blocked
                WHEN 'right_revoked' THEN NOT (access_right = ANY (rights))
                WHEN 'circle_changed' THEN circle IS NOT NULL AND NOT blocked
                    AND circle IS DISTINCT FROM previous_circle
                WHEN 'preset_granted' THEN preset = ANY (presets) AND NOT blocked
                WHEN 'preset_revoked' THEN NOT (preset = ANY (presets))
            END
        ) NOT VALID;

-- Новые колонки входят в сравниваемый кортеж неизменяемой строки, как circle и
-- rights в 014: без них правка снимка вместе с отметкой прошла бы молча.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION reject_identity_outbox_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'identity_outbox cannot be truncated'
            USING ERRCODE = 'ID005';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'identity_outbox row cannot be deleted'
            USING ERRCODE = 'ID005';
    END IF;

    IF OLD.published_at IS NULL
        AND NEW.published_at IS NOT NULL
        AND (NEW.event_id, NEW.position, NEW.identity_id, NEW.version, NEW.occasion,
             NEW.role, NEW.global_roles, NEW.blocked, NEW.occurred_at, NEW.tx_id,
             NEW.traceparent, NEW.circle, NEW.rights, NEW.access_right,
             NEW.presets, NEW.preset, NEW.previous_circle, NEW.queue)
            IS NOT DISTINCT FROM
            (OLD.event_id, OLD.position, OLD.identity_id, OLD.version, OLD.occasion,
             OLD.role, OLD.global_roles, OLD.blocked, OLD.occurred_at, OLD.tx_id,
             OLD.traceparent, OLD.circle, OLD.rights, OLD.access_right,
             OLD.presets, OLD.preset, OLD.previous_circle, OLD.queue)
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'identity_outbox row is immutable except for the publication mark'
        USING ERRCODE = 'ID004';
END;
$$;
-- +goose StatementEnd

-- +goose Down

-- Откат приближённый, как у 014: наборы сворачиваются обратно в круги (maintainer
-- сильнее admin), записи переименовываются обратно, а строки outbox и журнала
-- нового словаря остаются — они неизменяемы, — и прежние ограничения
-- возвращаются NOT VALID.

ALTER TABLE identity_circles DISABLE TRIGGER identity_circles_announced;
ALTER TABLE identity_circles DISABLE TRIGGER identity_circles_blocked_guard;
ALTER TABLE identity_rights DISABLE TRIGGER identity_rights_announced;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION reject_identity_outbox_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'identity_outbox cannot be truncated'
            USING ERRCODE = 'ID005';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'identity_outbox row cannot be deleted'
            USING ERRCODE = 'ID005';
    END IF;

    IF OLD.published_at IS NULL
        AND NEW.published_at IS NOT NULL
        AND (NEW.event_id, NEW.position, NEW.identity_id, NEW.version, NEW.occasion,
             NEW.role, NEW.global_roles, NEW.blocked, NEW.occurred_at, NEW.tx_id,
             NEW.traceparent, NEW.circle, NEW.rights, NEW.access_right)
            IS NOT DISTINCT FROM
            (OLD.event_id, OLD.position, OLD.identity_id, OLD.version, OLD.occasion,
             OLD.role, OLD.global_roles, OLD.blocked, OLD.occurred_at, OLD.tx_id,
             OLD.traceparent, OLD.circle, OLD.rights, OLD.access_right)
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'identity_outbox row is immutable except for the publication mark'
        USING ERRCODE = 'ID004';
END;
$$;
-- +goose StatementEnd

UPDATE identity_outbox
SET published_at = GREATEST(now(), occurred_at)
WHERE published_at IS NULL;

ALTER TABLE identity_outbox
    DROP CONSTRAINT identity_outbox_occasion_check,
    DROP CONSTRAINT identity_outbox_role_absence,
    DROP CONSTRAINT identity_outbox_snapshot_presence,
    DROP CONSTRAINT identity_outbox_circle_check,
    DROP CONSTRAINT identity_outbox_rights_check,
    DROP CONSTRAINT identity_outbox_access_right_presence,
    DROP CONSTRAINT identity_outbox_preset_presence,
    DROP CONSTRAINT identity_outbox_queue_presence,
    DROP CONSTRAINT identity_outbox_previous_circle_presence,
    DROP CONSTRAINT identity_outbox_snapshot_check;

ALTER TABLE identity_outbox
    ADD CONSTRAINT identity_outbox_occasion_check
        CHECK (occasion IN (
            'profile_registered', 'role_granted', 'role_revoked',
            'profile_blocked', 'profile_unblocked', 'application_submitted',
            'application_admitted', 'right_granted', 'right_revoked')) NOT VALID,
    ADD CONSTRAINT identity_outbox_role_presence
        CHECK (
            (occasion IN ('role_granted', 'role_revoked')
                AND role IN ('maintainer', 'admin', 'member', 'guest', 'public'))
            OR (occasion IN ('application_submitted', 'application_admitted')
                AND role IS NOT NULL AND role IN ('member', 'guest', 'public'))
            OR (occasion NOT IN ('role_granted', 'role_revoked',
                    'application_submitted', 'application_admitted')
                AND role IS NULL)
        ) NOT VALID,
    ADD CONSTRAINT identity_outbox_global_roles_check
        CHECK (global_roles <@ ARRAY['maintainer', 'admin', 'member', 'guest', 'public']::TEXT[]) NOT VALID,
    ADD CONSTRAINT identity_outbox_circle_check
        CHECK (circle IN ('maintainer', 'admin', 'member', 'guest')) NOT VALID,
    ADD CONSTRAINT identity_outbox_rights_check
        CHECK (rights <@ ARRAY['hub', 'auction', 'manage_membership', 'moderate_auction', 'manage_auction']::TEXT[]) NOT VALID,
    ADD CONSTRAINT identity_outbox_access_right_presence
        CHECK (
            (occasion IN ('right_granted', 'right_revoked') AND access_right IS NOT NULL
                AND access_right IN ('hub', 'auction', 'manage_membership', 'moderate_auction'))
            OR (occasion NOT IN ('right_granted', 'right_revoked') AND access_right IS NULL)
        ) NOT VALID,
    ADD CONSTRAINT identity_outbox_snapshot_check
        CHECK (
            CASE occasion
                WHEN 'profile_registered' THEN version = 1 AND NOT blocked
                WHEN 'role_granted' THEN role = ANY (global_roles) AND NOT blocked
                WHEN 'role_revoked' THEN NOT (role = ANY (global_roles))
                WHEN 'profile_blocked' THEN blocked AND cardinality(global_roles) = 0
                WHEN 'profile_unblocked' THEN NOT blocked
                WHEN 'application_submitted' THEN NOT blocked AND NOT (role = ANY (global_roles))
                WHEN 'application_admitted' THEN role = ANY (global_roles) AND NOT blocked
                WHEN 'right_granted' THEN access_right = ANY (rights) AND NOT blocked
                WHEN 'right_revoked' THEN NOT (access_right = ANY (COALESCE(rights, '{}')))
            END
        ) NOT VALID;

ALTER TABLE identity_outbox
    DROP COLUMN queue,
    DROP COLUMN previous_circle,
    DROP COLUMN preset,
    DROP COLUMN presets;

DROP FUNCTION identity_active_presets(UUID);


ALTER TABLE identity_access_journal
    DROP CONSTRAINT identity_access_journal_preset_check,
    DROP CONSTRAINT identity_access_journal_subject_presence;
ALTER TABLE identity_access_journal RENAME COLUMN circle TO role;
ALTER TABLE identity_access_journal
    ADD CONSTRAINT identity_access_journal_role_presence
        CHECK (
            (action IN ('grant', 'revoke') AND role IS NOT NULL)
            OR (action IN ('block', 'unblock') AND role IS NULL)
        ) NOT VALID;
ALTER TABLE identity_access_journal DROP COLUMN preset;

ALTER TABLE allowed_usernames
    RENAME CONSTRAINT allowed_usernames_grants_circle_check TO allowed_usernames_grants_role_check;
ALTER TABLE allowed_usernames RENAME COLUMN grants_circle TO grants_role;

ALTER INDEX identity_applications_open_identity_queue RENAME TO identity_applications_open_identity_role;
ALTER TABLE identity_applications
    DROP CONSTRAINT identity_applications_refusal_queue_check,
    DROP CONSTRAINT identity_applications_queue_check;
UPDATE identity_applications
SET queue = CASE queue WHEN 'community' THEN 'member' ELSE 'guest' END;
ALTER TABLE identity_applications RENAME COLUMN queue TO requested_role;
ALTER TABLE identity_applications
    ADD CONSTRAINT identity_applications_requested_role_check
        CHECK (requested_role IN ('member', 'guest')),
    ADD CONSTRAINT identity_applications_refusal_circle_check
        CHECK (outcome IS DISTINCT FROM 'blocked' OR requested_role = 'guest');

ALTER TABLE identity_rights DROP CONSTRAINT identity_rights_access_right_check;
UPDATE identity_rights SET access_right = CASE access_right
    WHEN 'access_hub' THEN 'hub'
    WHEN 'place_bids' THEN 'auction'
    WHEN 'manage_members' THEN 'manage_membership'
    WHEN 'admit_bidders' THEN 'moderate_auction'
    WHEN 'manage_meetups' THEN 'manage_auction'
    ELSE 'manage_membership'
END;
ALTER TABLE identity_rights
    ADD CONSTRAINT identity_rights_access_right_check
        CHECK (access_right IN ('hub', 'auction', 'manage_membership', 'moderate_auction', 'manage_auction'));

ALTER TRIGGER identity_circles_blocked_guard ON identity_circles RENAME TO identity_roles_blocked_guard;
ALTER TRIGGER identity_circles_announced ON identity_circles RENAME TO identity_roles_announced;
ALTER INDEX identity_circles_one_active RENAME TO identity_roles_one_active;
ALTER INDEX identity_circles_active_identity_circle RENAME TO identity_roles_active_identity_role;
ALTER TABLE identity_circles
    RENAME CONSTRAINT identity_circles_revoked_after_granted TO identity_roles_revoked_after_granted;
ALTER TABLE identity_circles DROP CONSTRAINT identity_circles_circle_check;
ALTER TABLE identity_circles RENAME COLUMN circle TO role;
ALTER TABLE identity_circles RENAME TO identity_roles;

-- Наборы сворачиваются в круг: maintainer сильнее admin, а участник с набором
-- теряет строку member — круг у человека один.
UPDATE identity_roles r
SET revoked_at = GREATEST(now(), r.granted_at)
WHERE r.revoked_at IS NULL
  AND EXISTS (SELECT 1 FROM identity_presets p
              WHERE p.identity_id = r.identity_id AND p.revoked_at IS NULL);

INSERT INTO identity_roles (id, identity_id, role, granted_at, granted_by)
SELECT gen_random_uuid(), p.identity_id,
       CASE WHEN bool_or(p.preset = 'maintainer') THEN 'maintainer' ELSE 'admin' END,
       now(), NULL
FROM identity_presets p
WHERE p.revoked_at IS NULL
GROUP BY p.identity_id;

ALTER TABLE identity_roles
    ADD CONSTRAINT identity_roles_role_check
        CHECK (role IN ('maintainer', 'admin', 'member', 'guest'));

DROP TABLE identity_presets;

ALTER TABLE identity_roles ENABLE TRIGGER identity_roles_announced;
ALTER TABLE identity_roles ENABLE TRIGGER identity_roles_blocked_guard;
ALTER TABLE identity_rights ENABLE TRIGGER identity_rights_announced;

-- Тела SQL-функций проверяются при создании, поэтому прежний вывод прав
-- создаётся после того, как таблица снова называется identity_roles.
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

DROP FUNCTION identity_carried_rights(UUID);

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION identity_global_roles(subject UUID)
RETURNS TEXT[]
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
    WITH circle AS (
        SELECT role FROM identity_roles
        WHERE identity_id = subject AND revoked_at IS NULL
    ), rights AS (
        SELECT identity_access_rights(subject) AS held
    )
    SELECT COALESCE(array_agg(name ORDER BY name), '{}')
    FROM (
        SELECT 'admin' AS name FROM rights
        WHERE EXISTS (SELECT 1 FROM circle WHERE role = 'admin')
              AND cardinality(held) > 0
           OR 'manage_membership' = ANY (held)
        UNION SELECT 'maintainer' FROM rights
        WHERE EXISTS (SELECT 1 FROM circle WHERE role = 'maintainer') AND cardinality(held) > 0
        UNION SELECT 'member' FROM rights WHERE 'hub' = ANY (held)
        UNION SELECT 'guest' FROM rights WHERE 'auction' = ANY (held)
    ) AS projected;
$$;
-- +goose StatementEnd

-- global_roles остаётся без NOT NULL: строки нового словаря неизменяемы и
-- несут NULL, а прежний код пишет его всегда.
