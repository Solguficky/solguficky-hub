-- +goose Up

-- Круг записи белого списка (ADR-060, пункты 2, 4 и 5): запись хаба выдаёт
-- member и public, запись аукциона — public. Все записи до миграции заводил
-- администратор хаба, поэтому они получают member. Умолчание снимается сразу:
-- новая запись называет свой круг явно, и путь, который его забудет, упадёт на
-- NOT NULL, а не заведёт молча запись хаба.
--
-- Уникальность остаётся по нику среди непогашенных записей: один ник — одна
-- запись любого круга. Повышение аукционной записи до хаба — снятие одной и
-- заведение другой, а не перезапись круга: история «кто завёл в какой круг»
-- сохраняется.
ALTER TABLE allowed_usernames
    ADD COLUMN grants_role TEXT NOT NULL DEFAULT 'member',
    ADD CONSTRAINT allowed_usernames_grants_role_check
        CHECK (grants_role IN ('member', 'public'));

ALTER TABLE allowed_usernames ALTER COLUMN grants_role DROP DEFAULT;

-- +goose Down

ALTER TABLE allowed_usernames
    DROP CONSTRAINT allowed_usernames_grants_role_check,
    DROP COLUMN grants_role;
