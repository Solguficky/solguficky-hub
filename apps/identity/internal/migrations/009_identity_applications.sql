-- +goose Up

-- Заявка — ожидание человеком круга (ADR-060, пункты 6–14). Она не журнал и не
-- источник истины о допуске: роли по-прежнему читаются из identity_roles, а
-- выдача и блокировка пишут журнал доступа и outbox как раньше. Создание заявки и
-- её закрытие роль не меняют, поэтому событий у заявки нет и щит ID006 её не
-- касается.
--
-- Строка живёт в двух состояниях: открытая (outcome NULL) и решённая. Решение —
-- условный переход «открытая → решённая», после него строка остаётся историей:
-- источник и имя обнуляются (пункт 20), исход не переписывается.
--
-- created_at хранится с точностью до миллисекунды: курсор очереди несёт ровно
-- миллисекунды, и более тонкое значение стояло бы после курсора само за собой.
-- decided_at хранится полностью: это now() решающей транзакции, и отказ в public
-- узнаёт свою блокировку по совпадению с моментом записи block в журнале доступа.
--
-- refusal_lifted_at — момент, когда круг отказанной заявки выдан после отказа
-- любым путём. Его ставит выдача под блокировкой строки профиля, поэтому признак
-- не зависит от того, какая транзакция началась раньше: сравнение granted_at с
-- decided_at этого не гарантирует, потому что now() — начало транзакции.
--
-- Внешнего ключа на decided_by нет по той же причине, что у журнала доступа:
-- история решения переживает профиль решившего (ADR-038).
CREATE TABLE identity_applications (
    id UUID PRIMARY KEY,
    identity_id UUID NOT NULL REFERENCES profiles (id),
    requested_role TEXT NOT NULL,
    source_code TEXT,
    first_name TEXT,
    created_at TIMESTAMPTZ(3) NOT NULL,
    outcome TEXT,
    decided_by UUID,
    decided_at TIMESTAMPTZ,
    refusal_lifted_at TIMESTAMPTZ,
    CONSTRAINT identity_applications_requested_role_check
        CHECK (requested_role IN ('member', 'public')),
    CONSTRAINT identity_applications_outcome_check
        CHECK (outcome IN ('admitted', 'declined', 'blocked', 'closed_by_grant', 'closed_by_block')),
    CONSTRAINT identity_applications_decision_check
        CHECK ((outcome IS NULL) = (decided_at IS NULL)),
    CONSTRAINT identity_applications_open_undecided_check
        CHECK (outcome IS NOT NULL OR decided_by IS NULL),
    -- Решение администратора всегда называет решившего. Закрытие выдачей или
    -- блокировкой может прийти без него: белый список и maintainer профиля не имеют.
    CONSTRAINT identity_applications_decider_check
        CHECK (outcome NOT IN ('admitted', 'declined', 'blocked') OR decided_by IS NOT NULL),
    CONSTRAINT identity_applications_erased_check
        CHECK (outcome IS NULL OR (source_code IS NULL AND first_name IS NULL)),
    -- Отказ зависит от круга (пункт 12): в public — блокировка, в member — declined.
    CONSTRAINT identity_applications_refusal_circle_check
        CHECK ((outcome IS DISTINCT FROM 'blocked' OR requested_role = 'public')
           AND (outcome IS DISTINCT FROM 'declined' OR requested_role = 'member')),
    CONSTRAINT identity_applications_lifted_check
        CHECK (refusal_lifted_at IS NULL OR outcome IN ('declined', 'blocked'))
);

-- На пару «человек, круг» открыта не больше одной заявки (пункт 6).
CREATE UNIQUE INDEX identity_applications_open_identity_role
    ON identity_applications (identity_id, requested_role)
    WHERE outcome IS NULL;

CREATE INDEX identity_applications_queue
    ON identity_applications (created_at, id)
    WHERE outcome IS NULL;

-- Ожидающие хаба до миграции — незаблокированные профили без активных ролей —
-- получают заявку на member без источника и имени (пункт 11). Идентификатор —
-- UUIDv7 из момента создания профиля, как у заявок, которые создаёт код: 48 бит
-- миллисекунд поверх случайного UUID и версия 7 в старшем полубайте байта 6.
INSERT INTO identity_applications (id, identity_id, requested_role, created_at)
SELECT
    encode(
        set_bit(set_bit(
            overlay(uuid_send(gen_random_uuid())
                placing substring(int8send(floor(extract(epoch FROM p.created_at) * 1000)::BIGINT) FROM 3)
                FROM 1 FOR 6),
            52, 1), 53, 1),
        'hex')::UUID,
    p.id,
    'member',
    date_trunc('milliseconds', p.created_at)
FROM profiles p
WHERE NOT p.blocked
  AND NOT EXISTS (
      SELECT 1 FROM identity_roles r
      WHERE r.identity_id = p.id AND r.revoked_at IS NULL);

-- +goose Down

DROP TABLE IF EXISTS identity_applications;
