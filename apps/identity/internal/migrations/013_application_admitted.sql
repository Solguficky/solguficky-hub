-- +goose Up

-- Повод application_admitted (PER-442): администратор допустил человека по
-- заявке — решением открытой или пересмотром отказанной. Выдачи круга идут
-- своими role_granted раньше в той же транзакции, поэтому снимок уже держит
-- круг заявки и не заблокирован.
--
-- Ограничения пересоздаются, а не дописываются, как в 012: так видно, что
-- каждое из трёх знает новый повод. Без своей ветки в
-- identity_outbox_snapshot_check выражение CASE дало бы NULL, и CHECK пропустил
-- бы строку молча.
ALTER TABLE identity_outbox
    DROP CONSTRAINT identity_outbox_occasion_check,
    DROP CONSTRAINT identity_outbox_role_presence,
    DROP CONSTRAINT identity_outbox_snapshot_check;

ALTER TABLE identity_outbox
    ADD CONSTRAINT identity_outbox_occasion_check
        CHECK (occasion IN (
            'profile_registered', 'role_granted', 'role_revoked',
            'profile_blocked', 'profile_unblocked', 'application_submitted',
            'application_admitted')),
    -- У заявки и допуска по ней роль — круг заявки: заявку принимают только хаб
    -- и аукцион. Пустая роль отвергается явно: IN на NULL даёт NULL, а CHECK
    -- пропускает NULL.
    ADD CONSTRAINT identity_outbox_role_presence
        CHECK (
            (occasion IN ('role_granted', 'role_revoked')
                AND role IN ('maintainer', 'admin', 'member', 'public'))
            OR (occasion IN ('application_submitted', 'application_admitted')
                AND role IS NOT NULL AND role IN ('member', 'public'))
            OR (occasion NOT IN ('role_granted', 'role_revoked',
                    'application_submitted', 'application_admitted')
                AND role IS NULL)
        ),
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
            END
        );

-- +goose Down

-- Строки outbox неизменяемы и не удаляются (ID004, ID005), поэтому уже
-- записанные допуски остаются. Ограничения 012 возвращаются NOT VALID: они
-- снова держат каждую новую строку, а старые не перепроверяют.
ALTER TABLE identity_outbox
    DROP CONSTRAINT identity_outbox_occasion_check,
    DROP CONSTRAINT identity_outbox_role_presence,
    DROP CONSTRAINT identity_outbox_snapshot_check;

ALTER TABLE identity_outbox
    ADD CONSTRAINT identity_outbox_occasion_check
        CHECK (occasion IN (
            'profile_registered', 'role_granted', 'role_revoked',
            'profile_blocked', 'profile_unblocked', 'application_submitted')) NOT VALID,
    ADD CONSTRAINT identity_outbox_role_presence
        CHECK (
            (occasion IN ('role_granted', 'role_revoked')
                AND role IN ('maintainer', 'admin', 'member', 'public'))
            OR (occasion = 'application_submitted' AND role IS NOT NULL
                AND role IN ('member', 'public'))
            OR (occasion NOT IN ('role_granted', 'role_revoked', 'application_submitted')
                AND role IS NULL)
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
            END
        ) NOT VALID;
