-- +goose Up

-- Одна активная роль-круг и права, которые Identity из неё выводит (ADR-064,
-- пункты 6–10; PER-526). До этой миграции круги были вложенными строками:
-- участник держал member и public, администратор — admin и, смотря по пути
-- выдачи, ещё member и public. Теперь у человека одна активная строка
-- identity_roles, а то, что ему можно, — права: часть приходит с кругом, часть
-- выдаётся отдельной записью identity_rights.
--
-- Порядок кругов: guest < member = maintainer < admin. Мейнтейнер — технический
-- круг с правами участника, а не администратор домена; управление составом и
-- модерацию аукциона ему выдают отдельно (пункт 7).

-- Заблокированный профиль активных ролей не держит: так его оставляет
-- блокировка, а выдачу заблокированному закрывает ID003. Строка, оставшаяся
-- мимо этих путей, уронила бы перенос ниже отказом триггера без указания
-- профиля; здесь отказ называет причину.
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

-- Перенос не меняет того, что потребители видят в global_roles: поле строится
-- из круга и прав функцией identity_global_roles ниже, и для каждого человека
-- оно после переноса то же, что было набором строк до него. Поэтому перенос
-- событий не пишет, а щит ID006 на время переноса выключен: иначе он требовал
-- бы события на каждую тронутую строку. Новые поля снимка — role и rights —
-- потребитель получит со следующим событием человека.
ALTER TABLE identity_roles DISABLE TRIGGER identity_roles_announced;

CREATE TABLE identity_rights (
    id UUID PRIMARY KEY,
    identity_id UUID NOT NULL REFERENCES profiles (id),
    access_right TEXT NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL,
    granted_by UUID REFERENCES profiles (id),
    revoked_at TIMESTAMPTZ,
    CONSTRAINT identity_rights_access_right_check
        CHECK (access_right IN ('hub', 'auction', 'manage_membership', 'moderate_auction')),
    CONSTRAINT identity_rights_revoked_after_granted
        CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);

CREATE UNIQUE INDEX identity_rights_active_identity_right
    ON identity_rights (identity_id, access_right)
    WHERE revoked_at IS NULL;

-- Право выданной записью сохраняет то, что человек имел до переноса. Гость —
-- тот, у кого из прежних строк был только public: с ней он торговал в боте
-- аукциона, и после переноса это право аукциона. Держатель admin и maintainer
-- остаётся мейнтейнером (решение владельца по PER-526) и сохраняет управление
-- составом и модерацию аукциона записями: право назначать администраторов
-- даёт ему круг maintainer, а не admin.
INSERT INTO identity_rights (id, identity_id, access_right, granted_at, granted_by)
SELECT gen_random_uuid(), r.identity_id, 'auction', now(), NULL
FROM identity_roles r
WHERE r.role = 'public' AND r.revoked_at IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM identity_roles stronger
      WHERE stronger.identity_id = r.identity_id AND stronger.revoked_at IS NULL
        AND stronger.role IN ('member', 'admin', 'maintainer'));

INSERT INTO identity_rights (id, identity_id, access_right, granted_at, granted_by)
SELECT gen_random_uuid(), m.identity_id, granted.access_right, now(), NULL
FROM identity_roles m
JOIN identity_roles a ON a.identity_id = m.identity_id AND a.role = 'admin' AND a.revoked_at IS NULL
CROSS JOIN (VALUES ('manage_membership'::TEXT), ('moderate_auction'::TEXT)) AS granted(access_right)
WHERE m.role = 'maintainer' AND m.revoked_at IS NULL;

-- Остаётся одна строка — та, что выше по старшинству переноса: maintainer, затем
-- admin, member, public. Остальные отзываются, а не удаляются: строка роли —
-- история выдачи.
UPDATE identity_roles r
SET revoked_at = GREATEST(now(), r.granted_at)
WHERE r.revoked_at IS NULL
  AND EXISTS (
      SELECT 1 FROM identity_roles kept
      WHERE kept.identity_id = r.identity_id AND kept.revoked_at IS NULL AND kept.id <> r.id
        AND array_position(ARRAY['public', 'member', 'admin', 'maintainer'], kept.role)
            > array_position(ARRAY['public', 'member', 'admin', 'maintainer'], r.role));

-- Имя круга меняется во всей истории строк, а не только в активных: словарь
-- схемы один. Журнал доступа неизменяем и хранит прежнее имя, как и outbox.
ALTER TABLE identity_roles DROP CONSTRAINT identity_roles_role_check;
UPDATE identity_roles SET role = 'guest' WHERE role = 'public';
ALTER TABLE identity_roles
    ADD CONSTRAINT identity_roles_role_check
        CHECK (role IN ('maintainer', 'admin', 'member', 'guest'));

-- Одна активная роль на человека держится схемой: вторая активная строка
-- отвергается уникальностью, а не ревью выдачи.
CREATE UNIQUE INDEX identity_roles_one_active
    ON identity_roles (identity_id)
    WHERE revoked_at IS NULL;

ALTER TABLE identity_roles ENABLE TRIGGER identity_roles_announced;

-- Щиты identity_roles действуют и на права: выдача заблокированному отвергается
-- (ID003), а выдача и отзыв без события той же транзакции не фиксируются (ID006).
CREATE OR REPLACE TRIGGER identity_rights_blocked_guard
BEFORE INSERT OR UPDATE
ON identity_rights
FOR EACH ROW
EXECUTE FUNCTION reject_blocked_identity_role_grant();

CREATE CONSTRAINT TRIGGER identity_rights_announced
AFTER INSERT OR UPDATE
ON identity_rights
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION reject_unannounced_identity_change();

ALTER TABLE identity_applications
    DROP CONSTRAINT identity_applications_requested_role_check,
    DROP CONSTRAINT identity_applications_refusal_circle_check;
UPDATE identity_applications SET requested_role = 'guest' WHERE requested_role = 'public';
ALTER TABLE identity_applications
    ADD CONSTRAINT identity_applications_requested_role_check
        CHECK (requested_role IN ('member', 'guest')),
    -- Отказ зависит от круга (ADR-060, пункт 12): в guest — блокировка, в
    -- member — declined. Отказ по очереди без блокировки — PER-527.
    ADD CONSTRAINT identity_applications_refusal_circle_check
        CHECK ((outcome IS DISTINCT FROM 'blocked' OR requested_role = 'guest')
           AND (outcome IS DISTINCT FROM 'declined' OR requested_role = 'member'));

ALTER TABLE allowed_usernames DROP CONSTRAINT allowed_usernames_grants_role_check;
UPDATE allowed_usernames SET grants_role = 'guest' WHERE grants_role = 'public';
ALTER TABLE allowed_usernames
    ADD CONSTRAINT allowed_usernames_grants_role_check
        CHECK (grants_role IN ('member', 'guest'));

-- Вывод прав — одно место для всех читателей: ответы gRPC, проверка роли и
-- снимок outbox берут его отсюда, и второго счётчика допуска нет (ADR-064,
-- «Обоснование»). Заблокированный прав не получает, даже если строка осталась
-- мимо блокировки: страховка поверх инварианта, как в CheckGlobalRole.
--
-- Участник и мейнтейнер получают хаб и аукцион по кругу, администратор — все
-- четыре права, гость — только выданные записями (пункт 7).
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

-- global_roles до снятия поля — проекция круга и прав на прежние вложенные
-- имена, а не строки хранилища (решение владельца по PER-526). Потребители,
-- которые ещё пускают по роли, видят тот же набор, что видели до одной
-- роли-круга: участник — member и guest, администратор — admin, member и guest.
-- Гость попадает в набор по праву аукциона, участник — по праву хаба, admin — по
-- кругу администратора или по выданному управлению составом: так мигрированный
-- мейнтейнер сохраняет админские экраны ботов, которые проверяют admin.
--
-- Функция удаляется вместе с полем, когда потребители перейдут на rights.
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

-- Снимок outbox несёт круг и права, как IdentityState. Строки до этой миграции
-- их не несут: NULL — «снимок записан до одной роли-круга», и релей публикует
-- такой снимок с пустыми полями. Имя public остаётся допустимым в истории:
-- строки outbox неизменяемы (ID004), а новые несут guest.
ALTER TABLE identity_outbox
    ADD COLUMN circle TEXT,
    ADD COLUMN rights TEXT[],
    ADD CONSTRAINT identity_outbox_circle_check
        CHECK (circle IN ('maintainer', 'admin', 'member', 'guest')),
    ADD CONSTRAINT identity_outbox_rights_check
        CHECK (rights <@ ARRAY['hub', 'auction', 'manage_membership', 'moderate_auction']::TEXT[]),
    DROP CONSTRAINT identity_outbox_global_roles_check,
    DROP CONSTRAINT identity_outbox_role_presence;

ALTER TABLE identity_outbox
    ADD CONSTRAINT identity_outbox_global_roles_check
        CHECK (global_roles <@ ARRAY['maintainer', 'admin', 'member', 'guest', 'public']::TEXT[]),
    ADD CONSTRAINT identity_outbox_role_presence
        CHECK (
            (occasion IN ('role_granted', 'role_revoked')
                AND role IN ('maintainer', 'admin', 'member', 'guest', 'public'))
            OR (occasion IN ('application_submitted', 'application_admitted')
                AND role IS NOT NULL AND role IN ('member', 'guest', 'public'))
            OR (occasion NOT IN ('role_granted', 'role_revoked',
                    'application_submitted', 'application_admitted')
                AND role IS NULL)
        );

-- Новые колонки входят в сравниваемый кортеж неизменяемой строки, как
-- traceparent в 008: без них правка снимка вместе с отметкой прошла бы молча.
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
             NEW.traceparent, NEW.circle, NEW.rights)
            IS NOT DISTINCT FROM
            (OLD.event_id, OLD.position, OLD.identity_id, OLD.version, OLD.occasion,
             OLD.role, OLD.global_roles, OLD.blocked, OLD.occurred_at, OLD.tx_id,
             OLD.traceparent, OLD.circle, OLD.rights)
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'identity_outbox row is immutable except for the publication mark'
        USING ERRCODE = 'ID004';
END;
$$;
-- +goose StatementEnd

-- +goose Down

-- Откат приближённый: отозванные переносом строки не возвращаются, потому что
-- после него нельзя отличить их от отозванных решением. Возвращаются имя public,
-- прежние ограничения и вложенность у оставшихся кругов: участнику — public,
-- администратору без других строк — ничего, как было у выданного GrantAdminRole.

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
             NEW.traceparent)
            IS NOT DISTINCT FROM
            (OLD.event_id, OLD.position, OLD.identity_id, OLD.version, OLD.occasion,
             OLD.role, OLD.global_roles, OLD.blocked, OLD.occurred_at, OLD.tx_id,
             OLD.traceparent)
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'identity_outbox row is immutable except for the publication mark'
        USING ERRCODE = 'ID004';
END;
$$;
-- +goose StatementEnd

ALTER TABLE identity_outbox
    DROP CONSTRAINT identity_outbox_role_presence,
    DROP CONSTRAINT identity_outbox_global_roles_check,
    DROP CONSTRAINT identity_outbox_rights_check,
    DROP CONSTRAINT identity_outbox_circle_check,
    DROP COLUMN rights,
    DROP COLUMN circle;

DROP FUNCTION IF EXISTS identity_global_roles(UUID);
DROP FUNCTION IF EXISTS identity_access_rights(UUID);

ALTER TABLE allowed_usernames DROP CONSTRAINT allowed_usernames_grants_role_check;
UPDATE allowed_usernames SET grants_role = 'public' WHERE grants_role = 'guest';
ALTER TABLE allowed_usernames
    ADD CONSTRAINT allowed_usernames_grants_role_check
        CHECK (grants_role IN ('member', 'public'));

ALTER TABLE identity_applications
    DROP CONSTRAINT identity_applications_requested_role_check,
    DROP CONSTRAINT identity_applications_refusal_circle_check;
UPDATE identity_applications SET requested_role = 'public' WHERE requested_role = 'guest';
ALTER TABLE identity_applications
    ADD CONSTRAINT identity_applications_requested_role_check
        CHECK (requested_role IN ('member', 'public')),
    ADD CONSTRAINT identity_applications_refusal_circle_check
        CHECK ((outcome IS DISTINCT FROM 'blocked' OR requested_role = 'public')
           AND (outcome IS DISTINCT FROM 'declined' OR requested_role = 'member'));

DROP TABLE identity_rights;

ALTER TABLE identity_roles DISABLE TRIGGER identity_roles_announced;
DROP INDEX identity_roles_one_active;
ALTER TABLE identity_roles DROP CONSTRAINT identity_roles_role_check;
UPDATE identity_roles SET role = 'public' WHERE role = 'guest';
INSERT INTO identity_roles (id, identity_id, role, granted_at, granted_by)
SELECT gen_random_uuid(), identity_id, 'public', now(), NULL
FROM identity_roles
WHERE role = 'member' AND revoked_at IS NULL;
ALTER TABLE identity_roles
    ADD CONSTRAINT identity_roles_role_check
        CHECK (role IN ('maintainer', 'admin', 'member', 'public'));
ALTER TABLE identity_roles ENABLE TRIGGER identity_roles_announced;

ALTER TABLE identity_outbox
    ADD CONSTRAINT identity_outbox_global_roles_check
        CHECK (global_roles <@ ARRAY['maintainer', 'admin', 'member', 'public']::TEXT[]),
    ADD CONSTRAINT identity_outbox_role_presence
        CHECK (
            (occasion IN ('role_granted', 'role_revoked')
                AND role IN ('maintainer', 'admin', 'member', 'public'))
            OR (occasion IN ('application_submitted', 'application_admitted')
                AND role IS NOT NULL AND role IN ('member', 'public'))
            OR (occasion NOT IN ('role_granted', 'role_revoked',
                    'application_submitted', 'application_admitted')
                AND role IS NULL)
        );
