-- +goose Up

-- Повод application_submitted (ADR-062): открыта
-- новая заявка на круг. Доступ он не меняет, но версию профиля занимает, как
-- любое событие, — снимок у него тот же, что был до заявки.
--
-- Ограничения пересоздаются, а не дописываются: так видно, что каждое из трёх
-- знает новый повод. Без своей ветки в identity_outbox_snapshot_check выражение
-- CASE дало бы NULL, и CHECK пропустил бы строку молча.
ALTER TABLE identity_outbox
    DROP CONSTRAINT identity_outbox_occasion_check,
    DROP CONSTRAINT identity_outbox_role_presence,
    DROP CONSTRAINT identity_outbox_snapshot_check;

ALTER TABLE identity_outbox
    ADD CONSTRAINT identity_outbox_occasion_check
        CHECK (occasion IN (
            'profile_registered', 'role_granted', 'role_revoked',
            'profile_blocked', 'profile_unblocked', 'application_submitted')),
    -- У заявки роль — запрошенный круг: заявку принимают только хаб и аукцион.
    -- Пустая роль отвергается явно: IN на NULL даёт NULL, а CHECK пропускает
    -- NULL, и снимок её здесь не поймает, как у выдачи.
    ADD CONSTRAINT identity_outbox_role_presence
        CHECK (
            (occasion IN ('role_granted', 'role_revoked')
                AND role IN ('maintainer', 'admin', 'member', 'public'))
            OR (occasion = 'application_submitted' AND role IS NOT NULL
                AND role IN ('member', 'public'))
            OR (occasion NOT IN ('role_granted', 'role_revoked', 'application_submitted')
                AND role IS NULL)
        ),
    -- Заявку ставит только незаблокированный человек без запрошенного круга.
    -- Круги вложенные, а снимок плоский, поэтому строже «самой роли нет» схема
    -- не выразит: что у человека нет и более сильного круга, держит сервис.
    ADD CONSTRAINT identity_outbox_snapshot_check
        CHECK (
            CASE occasion
                WHEN 'profile_registered' THEN version = 1 AND NOT blocked
                WHEN 'role_granted' THEN role = ANY (global_roles) AND NOT blocked
                WHEN 'role_revoked' THEN NOT (role = ANY (global_roles))
                WHEN 'profile_blocked' THEN blocked AND cardinality(global_roles) = 0
                WHEN 'profile_unblocked' THEN NOT blocked
                WHEN 'application_submitted' THEN NOT blocked AND NOT (role = ANY (global_roles))
            END
        );

-- +goose Down

-- Строки outbox неизменяемы и не удаляются (ID004, ID005), поэтому уже
-- записанные заявки остаются. Прежние ограничения возвращаются NOT VALID: они
-- снова держат каждую новую строку, а старые не перепроверяют.
ALTER TABLE identity_outbox
    DROP CONSTRAINT identity_outbox_occasion_check,
    DROP CONSTRAINT identity_outbox_role_presence,
    DROP CONSTRAINT identity_outbox_snapshot_check;

ALTER TABLE identity_outbox
    ADD CONSTRAINT identity_outbox_occasion_check
        CHECK (occasion IN (
            'profile_registered', 'role_granted', 'role_revoked',
            'profile_blocked', 'profile_unblocked')) NOT VALID,
    ADD CONSTRAINT identity_outbox_role_presence
        CHECK (
            (occasion IN ('role_granted', 'role_revoked')
                AND role IN ('maintainer', 'admin', 'member', 'public'))
            OR (occasion NOT IN ('role_granted', 'role_revoked') AND role IS NULL)
        ) NOT VALID,
    ADD CONSTRAINT identity_outbox_snapshot_check
        CHECK (
            CASE occasion
                WHEN 'profile_registered' THEN version = 1 AND NOT blocked
                WHEN 'role_granted' THEN role = ANY (global_roles) AND NOT blocked
                WHEN 'role_revoked' THEN NOT (role = ANY (global_roles))
                WHEN 'profile_blocked' THEN blocked AND cardinality(global_roles) = 0
                WHEN 'profile_unblocked' THEN NOT blocked
            END
        ) NOT VALID;
