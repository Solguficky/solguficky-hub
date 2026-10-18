-- Вендорный скрипт Orleans, адаптированный под норматив репозитория.
--
-- Источник: https://github.com/dotnet/orleans, тег v10.3.1,
-- коммит 137d9acc17830f15b13a4eb0058d6cee633cad5e, файл src/AdoNet/Orleans.Reminders.AdoNet/PostgreSQL-Reminders.sql.
--
-- Скрипт применяется существующим DbUp сервиса, а не своим механизмом:
-- docs/standards/data/postgresql.md запрещает два журнала на одну схему.
-- Обновление Orleans означает повторный вендоринг этого файла с тем же
-- набором правок; upstream-версия сюда не копируется дословно, потому что
-- оригинал не идемпотентен, а норматив идемпотентности требует.
--
-- Отличия от оригинала, и только они:
--   CREATE TABLE      -> CREATE TABLE IF NOT EXISTS
--   CREATE FUNCTION   -> CREATE OR REPLACE FUNCTION
--   INSERT INTO OrleansQuery ... -> тот же INSERT с
--     ON CONFLICT (QueryKey) DO UPDATE SET QueryText = EXCLUDED.QueryText
-- Тексты запросов Orleans не тронуты: рантайм читает их по имени и типу.
--
-- Ловушка на апгрейд та же, что у кластеризации: CREATE OR REPLACE FUNCTION не
-- умеет менять тип возвращаемого значения и имена входных параметров. Пока
-- сигнатуры совпадают с установленными, замена — no-op; если новая версия
-- Orleans их изменит, перевендоренный скрипт обязан начинаться с
-- DROP FUNCTION IF EXISTS.
--
-- Зачем он здесь: reminders — механизм пробуждения грина к моменту
-- срабатывания (ADR-029). Хранилищем момента они не служат, источник истины
-- остаётся в reminder_task, и sweeper по той таблице обязателен независимо от
-- них: тик, пришедшийся на простой кластера, Orleans не догоняет.

-- Orleans Reminders table - https://learn.microsoft.com/dotnet/orleans/grains/timers-and-reminders
CREATE TABLE IF NOT EXISTS OrleansRemindersTable
(
    ServiceId varchar(150) NOT NULL,
    GrainId varchar(150) NOT NULL,
    ReminderName varchar(150) NOT NULL,
    StartTime timestamptz(3) NOT NULL,
    Period bigint NOT NULL,
    GrainHash integer NOT NULL,
    Version integer NOT NULL,

    CONSTRAINT PK_RemindersTable_ServiceId_GrainId_ReminderName PRIMARY KEY(ServiceId, GrainId, ReminderName)
);

CREATE OR REPLACE FUNCTION upsert_reminder_row(
    ServiceIdArg    OrleansRemindersTable.ServiceId%TYPE,
    GrainIdArg      OrleansRemindersTable.GrainId%TYPE,
    ReminderNameArg OrleansRemindersTable.ReminderName%TYPE,
    StartTimeArg    OrleansRemindersTable.StartTime%TYPE,
    PeriodArg       OrleansRemindersTable.Period%TYPE,
    GrainHashArg    OrleansRemindersTable.GrainHash%TYPE
  )
  RETURNS TABLE(version integer) AS
$func$
DECLARE
    VersionVar int := 0;
BEGIN

    INSERT INTO OrleansRemindersTable
    (
        ServiceId,
        GrainId,
        ReminderName,
        StartTime,
        Period,
        GrainHash,
        Version
    )
    SELECT
        ServiceIdArg,
        GrainIdArg,
        ReminderNameArg,
        StartTimeArg,
        PeriodArg,
        GrainHashArg,
        0
    ON CONFLICT (ServiceId, GrainId, ReminderName)
        DO UPDATE SET
            StartTime = excluded.StartTime,
            Period = excluded.Period,
            GrainHash = excluded.GrainHash,
            Version = OrleansRemindersTable.Version + 1
    RETURNING
        OrleansRemindersTable.Version INTO STRICT VersionVar;

    RETURN QUERY SELECT VersionVar AS versionr;

END
$func$ LANGUAGE plpgsql;

INSERT INTO OrleansQuery(QueryKey, QueryText)
VALUES
(
    'UpsertReminderRowKey','
    SELECT * FROM upsert_reminder_row(
        @ServiceId,
        @GrainId,
        @ReminderName,
        @StartTime,
        @Period,
        @GrainHash
    );
')
ON CONFLICT (QueryKey) DO UPDATE SET QueryText = EXCLUDED.QueryText;

INSERT INTO OrleansQuery(QueryKey, QueryText)
VALUES
(
    'ReadReminderRowsKey','
    SELECT
        GrainId,
        ReminderName,
        StartTime,
        Period,
        Version
    FROM OrleansRemindersTable
    WHERE
        ServiceId = @ServiceId AND @ServiceId IS NOT NULL
        AND GrainId = @GrainId AND @GrainId IS NOT NULL;
')
ON CONFLICT (QueryKey) DO UPDATE SET QueryText = EXCLUDED.QueryText;

INSERT INTO OrleansQuery(QueryKey, QueryText)
VALUES
(
    'ReadReminderRowKey','
    SELECT
        GrainId,
        ReminderName,
        StartTime,
        Period,
        Version
    FROM OrleansRemindersTable
    WHERE
        ServiceId = @ServiceId AND @ServiceId IS NOT NULL
        AND GrainId = @GrainId AND @GrainId IS NOT NULL
        AND ReminderName = @ReminderName AND @ReminderName IS NOT NULL;
')
ON CONFLICT (QueryKey) DO UPDATE SET QueryText = EXCLUDED.QueryText;

INSERT INTO OrleansQuery(QueryKey, QueryText)
VALUES
(
    'ReadRangeRows1Key','
    SELECT
        GrainId,
        ReminderName,
        StartTime,
        Period,
        Version
    FROM OrleansRemindersTable
    WHERE
        ServiceId = @ServiceId AND @ServiceId IS NOT NULL
        AND GrainHash > @BeginHash AND @BeginHash IS NOT NULL
        AND GrainHash <= @EndHash AND @EndHash IS NOT NULL;
')
ON CONFLICT (QueryKey) DO UPDATE SET QueryText = EXCLUDED.QueryText;

INSERT INTO OrleansQuery(QueryKey, QueryText)
VALUES
(
    'ReadRangeRows2Key','
    SELECT
        GrainId,
        ReminderName,
        StartTime,
        Period,
        Version
    FROM OrleansRemindersTable
    WHERE
        ServiceId = @ServiceId AND @ServiceId IS NOT NULL
        AND ((GrainHash > @BeginHash AND @BeginHash IS NOT NULL)
        OR (GrainHash <= @EndHash AND @EndHash IS NOT NULL));
')
ON CONFLICT (QueryKey) DO UPDATE SET QueryText = EXCLUDED.QueryText;

CREATE OR REPLACE FUNCTION delete_reminder_row(
    ServiceIdArg    OrleansRemindersTable.ServiceId%TYPE,
    GrainIdArg      OrleansRemindersTable.GrainId%TYPE,
    ReminderNameArg OrleansRemindersTable.ReminderName%TYPE,
    VersionArg      OrleansRemindersTable.Version%TYPE
)
  RETURNS TABLE(row_count integer) AS
$func$
DECLARE
    RowCountVar int := 0;
BEGIN


    DELETE FROM OrleansRemindersTable
    WHERE
        ServiceId = ServiceIdArg AND ServiceIdArg IS NOT NULL
        AND GrainId = GrainIdArg AND GrainIdArg IS NOT NULL
        AND ReminderName = ReminderNameArg AND ReminderNameArg IS NOT NULL
        AND Version = VersionArg AND VersionArg IS NOT NULL;

    GET DIAGNOSTICS RowCountVar = ROW_COUNT;

    RETURN QUERY SELECT RowCountVar;

END
$func$ LANGUAGE plpgsql;

INSERT INTO OrleansQuery(QueryKey, QueryText)
VALUES
(
    'DeleteReminderRowKey','
    SELECT * FROM delete_reminder_row(
        @ServiceId,
        @GrainId,
        @ReminderName,
        @Version
    );
')
ON CONFLICT (QueryKey) DO UPDATE SET QueryText = EXCLUDED.QueryText;

INSERT INTO OrleansQuery(QueryKey, QueryText)
VALUES
(
    'DeleteReminderRowsKey','
    DELETE FROM OrleansRemindersTable
    WHERE
        ServiceId = @ServiceId AND @ServiceId IS NOT NULL;
')
ON CONFLICT (QueryKey) DO UPDATE SET QueryText = EXCLUDED.QueryText;
