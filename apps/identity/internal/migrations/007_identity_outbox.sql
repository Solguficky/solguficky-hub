-- +goose Up

-- Версия профиля — монотонный счётчик агрегата «профиль вместе с ролями». Он
-- двигается на единицу той же транзакцией, что и изменение, и каждое движение
-- оставляет строку outbox с этим номером. Ноль — профиль, о котором не выпущено
-- ни одного события: так выглядят профили, созданные до outbox, и только что
-- вставленный профиль до своей регистрации.
ALTER TABLE profiles
    ADD COLUMN version BIGINT NOT NULL DEFAULT 0,
    ADD CONSTRAINT profiles_version_check CHECK (version >= 0);

-- Outbox — очередь публикации событий identity.v1.IdentityEvent. Журнала домена у
-- Identity нет, поэтому уникальность версии профиля держит эта таблица. Снимок
-- лежит колонками, а не готовым сообщением: так согласие повода со снимком
-- проверяет схема, а сообщение релей собирает чистой функцией. Subject колонкой
-- не хранится — он выводится из повода, и второй источник повода был бы копией.
--
-- Внешнего ключа на profiles нет по той же причине, что у журнала доступа: очередь
-- не удаляется каскадом вместе с профилем (ADR-038). Существование профиля на
-- вставке проверяет identity_outbox_version_guard.
CREATE TABLE identity_outbox (
    event_id UUID PRIMARY KEY,
    -- Порядок публикации. Номер выдаётся при вставке, а вставка идёт под
    -- блокировкой строки профиля, поэтому внутри профиля он растёт вместе с
    -- версией. occurred_at этого не гарантирует: now() — начало транзакции, и
    -- транзакция, начатая раньше, могла получить профиль позже соседней.
    position BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
    identity_id UUID NOT NULL,
    version BIGINT NOT NULL,
    occasion TEXT NOT NULL,
    role TEXT,
    global_roles TEXT[] NOT NULL,
    blocked BOOLEAN NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    tx_id XID8 NOT NULL,
    published_at TIMESTAMPTZ,
    CONSTRAINT identity_outbox_identity_version UNIQUE (identity_id, version),
    CONSTRAINT identity_outbox_version_check CHECK (version >= 1),
    CONSTRAINT identity_outbox_occasion_check
        CHECK (occasion IN (
            'profile_registered', 'role_granted', 'role_revoked',
            'profile_blocked', 'profile_unblocked')),
    CONSTRAINT identity_outbox_role_presence
        CHECK (
            (occasion IN ('role_granted', 'role_revoked')
                AND role IN ('maintainer', 'admin', 'member', 'public'))
            OR (occasion NOT IN ('role_granted', 'role_revoked') AND role IS NULL)
        ),
    CONSTRAINT identity_outbox_global_roles_check
        CHECK (global_roles <@ ARRAY['maintainer', 'admin', 'member', 'public']::TEXT[]),
    -- Согласие повода со снимком после применения. Регистрация — первое событие
    -- профиля и не может прийти заблокированной, но может прийти с ролями: допуск
    -- по списку ников решается той же транзакцией. Блокировка приходит с пустым
    -- набором: она отзывает все роли одним решением.
    CONSTRAINT identity_outbox_snapshot_check
        CHECK (
            CASE occasion
                WHEN 'profile_registered' THEN version = 1 AND NOT blocked
                WHEN 'role_granted' THEN role = ANY (global_roles) AND NOT blocked
                WHEN 'role_revoked' THEN NOT (role = ANY (global_roles))
                WHEN 'profile_blocked' THEN blocked AND cardinality(global_roles) = 0
                WHEN 'profile_unblocked' THEN NOT blocked
            END
        ),
    CONSTRAINT identity_outbox_published_after_occurred
        CHECK (published_at IS NULL OR published_at >= occurred_at)
);

-- Неотправленный набор релей читает по position. Частичный индекс держит размер
-- очереди, а не истории.
CREATE INDEX identity_outbox_pending
    ON identity_outbox (position)
    WHERE published_at IS NULL;

-- Строка outbox неизменяема, кроме одного перехода: отметка публикации ставится
-- один раз. Удаление и TRUNCATE закрыты: очистка очереди — отдельное решение, а не
-- побочный путь. Коды ID004/ID005 свои по той же причине, что ID001/ID002 у журнала.
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
             NEW.role, NEW.global_roles, NEW.blocked, NEW.occurred_at, NEW.tx_id)
            IS NOT DISTINCT FROM
            (OLD.event_id, OLD.position, OLD.identity_id, OLD.version, OLD.occasion,
             OLD.role, OLD.global_roles, OLD.blocked, OLD.occurred_at, OLD.tx_id)
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'identity_outbox row is immutable except for the publication mark'
        USING ERRCODE = 'ID004';
END;
$$;
-- +goose StatementEnd

CREATE OR REPLACE TRIGGER identity_outbox_immutable
BEFORE UPDATE
ON identity_outbox
FOR EACH ROW
EXECUTE FUNCTION reject_identity_outbox_change();

CREATE OR REPLACE TRIGGER identity_outbox_undeletable
BEFORE DELETE
ON identity_outbox
FOR EACH ROW
EXECUTE FUNCTION reject_identity_outbox_change();

CREATE OR REPLACE TRIGGER identity_outbox_untruncatable
BEFORE TRUNCATE
ON identity_outbox
FOR EACH STATEMENT
EXECUTE FUNCTION reject_identity_outbox_change();

-- Версия движется шагом в единицу и не убывает, новый профиль начинает с нуля.
-- Строка outbox несёт ровно текущую версию профиля: событие не может ни опередить
-- счётчик, ни назвать уже занятый номер другим снимком. Транзакцию строки ставит
-- триггер, а не вызывающий: иначе проверку ID006 можно было бы обойти, выдав
-- строку чужой транзакции за свою. ID007 — «версия не в шаге с профилем».
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION guard_identity_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    current_version BIGINT;
BEGIN
    IF TG_TABLE_NAME = 'profiles' THEN
        IF TG_OP = 'INSERT' AND NEW.version <> 0 THEN
            RAISE EXCEPTION 'new profile must start at version 0'
                USING ERRCODE = 'ID007';
        END IF;
        IF TG_OP = 'UPDATE' AND NEW.version NOT IN (OLD.version, OLD.version + 1) THEN
            RAISE EXCEPTION 'profile version must advance by one'
                USING ERRCODE = 'ID007';
        END IF;
        RETURN NEW;
    END IF;

    SELECT profiles.version
    INTO current_version
    FROM profiles
    WHERE profiles.id = NEW.identity_id;

    IF current_version IS DISTINCT FROM NEW.version THEN
        RAISE EXCEPTION 'outbox version must equal the current profile version'
            USING ERRCODE = 'ID007';
    END IF;

    NEW.tx_id := pg_current_xact_id();
    RETURN NEW;
END;
$$;
-- +goose StatementEnd

CREATE OR REPLACE TRIGGER profiles_version_guard
BEFORE INSERT OR UPDATE OF version
ON profiles
FOR EACH ROW
EXECUTE FUNCTION guard_identity_version();

CREATE OR REPLACE TRIGGER identity_outbox_version_guard
BEFORE INSERT
ON identity_outbox
FOR EACH ROW
EXECUTE FUNCTION guard_identity_version();

-- Изменение состояния доступа без события не фиксируется: регистрация, смена
-- ролей и отметки блокировки обязаны оставить строку outbox той же транзакцией, а
-- движение версии — строку ровно с этим номером. Проверка отложена до коммита:
-- изменение и событие — разные операторы, и немедленная проверка упала бы между
-- ними. Правка ника и служебных меток времени событием не является и триггер не
-- задевает. Удаление ролей и профилей не покрыто: продукт их не удаляет. ID006 —
-- «изменение без события».
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION reject_unannounced_identity_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
    subject UUID;
    exact_version BIGINT;
    announced BOOLEAN;
BEGIN
    -- Поля записи читаются только внутри ветки своей таблицы: PL/pgSQL разбирает
    -- выражение целиком, и NEW.version у строки identity_roles уронил бы проверку
    -- даже за ложным условием.
    IF TG_TABLE_NAME = 'profiles' THEN
        subject := NEW.id;
        IF TG_OP = 'UPDATE' THEN
            IF NEW.version <> OLD.version THEN
                exact_version := NEW.version;
            END IF;
        END IF;
    ELSE
        subject := NEW.identity_id;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM identity_outbox
        WHERE identity_id = subject
          AND tx_id = pg_current_xact_id()
          AND (exact_version IS NULL OR version = exact_version)
    ) INTO announced;

    IF NOT announced THEN
        RAISE EXCEPTION 'identity % changed without an outbox event', subject
            USING ERRCODE = 'ID006';
    END IF;
    RETURN NULL;
END;
$$;
-- +goose StatementEnd

CREATE CONSTRAINT TRIGGER profiles_announced
AFTER INSERT OR UPDATE OF blocked, version
ON profiles
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION reject_unannounced_identity_change();

CREATE CONSTRAINT TRIGGER identity_roles_announced
AFTER INSERT OR UPDATE
ON identity_roles
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION reject_unannounced_identity_change();

-- +goose Down

DROP TRIGGER IF EXISTS identity_roles_announced ON identity_roles;
DROP TRIGGER IF EXISTS profiles_announced ON profiles;
DROP FUNCTION IF EXISTS reject_unannounced_identity_change();

DROP TRIGGER IF EXISTS identity_outbox_version_guard ON identity_outbox;
DROP TRIGGER IF EXISTS profiles_version_guard ON profiles;
DROP FUNCTION IF EXISTS guard_identity_version();

DROP TRIGGER IF EXISTS identity_outbox_untruncatable ON identity_outbox;
DROP TRIGGER IF EXISTS identity_outbox_undeletable ON identity_outbox;
DROP TRIGGER IF EXISTS identity_outbox_immutable ON identity_outbox;
DROP FUNCTION IF EXISTS reject_identity_outbox_change();

DROP TABLE IF EXISTS identity_outbox;

ALTER TABLE profiles
    DROP CONSTRAINT IF EXISTS profiles_version_check,
    DROP COLUMN IF EXISTS version;
