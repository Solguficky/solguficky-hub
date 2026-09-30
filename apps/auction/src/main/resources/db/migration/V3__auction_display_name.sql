-- Имя участника в аукционе: строка состояния, а не журнал (ADR-059,
-- docs/decisions/ADR-059-auction-participant-display-name.md). События торгов
-- имён не несут (ADR-045); стирание участника удаляет его строки.
--
-- Ровно одно из двух: снимок ника Telegram или псевдоним. alias_key — псевдоним
-- без учёта регистра, его считает сервис: lower() базы зависит от локали и
-- кириллицу в локали C не понижает. CHECK повторяет инварианты типов
-- намеренно: тип защищает только код сервиса.
CREATE TABLE auction_display_name (
    auction_id        uuid    NOT NULL,
    participant_id    uuid    NOT NULL,
    telegram_username text    CHECK (telegram_username ~ '^[A-Za-z0-9_]{1,32}$'),
    alias             text    CHECK (btrim(alias) <> '' AND strpos(alias, '*') = 0 AND strpos(alias, '@') = 0),
    alias_key         text,
    frozen            boolean NOT NULL DEFAULT false,
    PRIMARY KEY (auction_id, participant_id),
    CHECK ((telegram_username IS NULL) <> (alias IS NULL)),
    CHECK ((alias IS NULL) = (alias_key IS NULL))
);

-- Псевдоним уникален в аукционе. Ник уникальностью не охраняется: его
-- уникальность держит Telegram, а снимок не ключ.
CREATE UNIQUE INDEX auction_display_name_alias_key
    ON auction_display_name (auction_id, alias_key)
    WHERE alias_key IS NOT NULL;
