-- +goose Up

-- Реестр каналов прихода (ADR-060, пункты 17–20): администратор заводит пару
-- «код → подпись», и модератор видит подпись на карточке заявки. Реестр — не
-- состояние доступа: роль он не меняет, поэтому событий у него нет и щит ID006
-- его не касается. Удаления канала нет: заявка ссылается на канал, а подпись
-- меняется переименованием.
--
-- Код — хвост payload deep link `s_<код>`: алфавит payload Telegram и его
-- 64 символа без префикса. Регистр значим, как в самом payload. Внешнего ключа
-- на created_by и renamed_by нет по той же причине, что у журнала доступа:
-- история переживает профиль (ADR-038).
CREATE TABLE source_channels (
    code TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID,
    renamed_at TIMESTAMPTZ,
    renamed_by UUID,
    CONSTRAINT source_channels_code_check
        CHECK (code ~ '^[A-Za-z0-9_-]{1,62}$'),
    -- Подпись хранится без пробелов по краям: иначе две подписи, которые
    -- модератор видит одинаково, различались бы в списке. Управляющие символы
    -- запрещены: подпись — одна строка экрана.
    CONSTRAINT source_channels_label_check
        CHECK (label = btrim(label) AND char_length(label) BETWEEN 1 AND 64
               AND label !~ '[[:cntrl:]]'),
    CONSTRAINT source_channels_rename_check
        CHECK (renamed_by IS NULL OR renamed_at IS NOT NULL)
);

-- Код разрешается при записи заявки (пункт 18), и сырой код в заявке не
-- хранится: ссылка на канал — известный источник, отметка source_unknown —
-- «неизвестный источник», ни того ни другого — человек пришёл без кода. Код
-- чужого формата или длиннее лимита каналом стать не может: строки, которая его
-- несла бы, в схеме больше нет. Канал, заведённый после прихода человека, его
-- заявку не подписывает.
ALTER TABLE identity_applications
    ADD COLUMN source_channel TEXT REFERENCES source_channels (code),
    ADD COLUMN source_unknown BOOLEAN NOT NULL DEFAULT false;

-- Реестр до этой миграции был пуст, поэтому любой записанный код неизвестен.
UPDATE identity_applications SET source_unknown = true WHERE source_code IS NOT NULL;

ALTER TABLE identity_applications
    DROP CONSTRAINT identity_applications_erased_check,
    DROP COLUMN source_code,
    ADD CONSTRAINT identity_applications_source_check
        CHECK (NOT (source_unknown AND source_channel IS NOT NULL)),
    ADD CONSTRAINT identity_applications_erased_check
        CHECK (outcome IS NULL
               OR (source_channel IS NULL AND NOT source_unknown AND first_name IS NULL));

-- +goose Down

-- Подпись канала в заявку не возвращается: обратно доезжает код, а
-- «неизвестный источник» становится пустым кодом, который та схема читает так же.
ALTER TABLE identity_applications
    ADD COLUMN source_code TEXT;

UPDATE identity_applications
SET source_code = CASE WHEN source_unknown THEN '' ELSE source_channel END;

ALTER TABLE identity_applications
    DROP CONSTRAINT identity_applications_erased_check,
    DROP CONSTRAINT identity_applications_source_check,
    DROP COLUMN source_channel,
    DROP COLUMN source_unknown,
    ADD CONSTRAINT identity_applications_erased_check
        CHECK (outcome IS NULL OR (source_code IS NULL AND first_name IS NULL));

DROP TABLE IF EXISTS source_channels;
