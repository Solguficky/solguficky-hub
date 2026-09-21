-- Вендорный скрипт Orleans, адаптированный под норматив репозитория.
--
-- Источник: https://github.com/dotnet/orleans, тег v10.3.1,
-- коммит 137d9acc17830f15b13a4eb0058d6cee633cad5e, файл src/AdoNet/Shared/PostgreSQL-Main.sql.
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

-- requires Postgres 9.5 (or perhaps higher)

/*
Implementation notes:

1) The general idea is that data is read and written through Orleans specific queries.
   Orleans operates on column names and types when reading and on parameter names and types when writing.

2) The implementations *must* preserve input and output names and types. Orleans uses these parameters to reads query results by name and type.
   Vendor and deployment specific tuning is allowed and contributions are encouraged as long as the interface contract
   is maintained.

3) The implementation across vendor specific scripts *should* preserve the constraint names. This simplifies troubleshooting
   by virtue of uniform naming across concrete implementations.

5) ETag for Orleans is an opaque column that represents a unique version. The type of its actual implementation
   is not important as long as it represents a unique version. In this implementation we use integers for versioning

6) For the sake of being explicit and removing ambiguity, Orleans expects some queries to return either TRUE as >0 value
   or FALSE as =0 value. That is, affected rows or such does not matter. If an error is raised or an exception is thrown
   the query *must* ensure the entire transaction is rolled back and may either return FALSE or propagate the exception.
   Orleans handles exception as a failure and will retry.

7) The implementation follows the Extended Orleans membership protocol. For more information, see at:
        https://learn.microsoft.com/dotnet/orleans/implementation/cluster-management
        https://github.com/dotnet/orleans/blob/main/src/Orleans.Core/SystemTargetInterfaces/IMembershipTable.cs
*/



-- This table defines Orleans operational queries. Orleans uses these to manage its operations,
-- these are the only queries Orleans issues to the database.
-- These can be redefined (e.g. to provide non-destructive updates) provided the stated interface principles hold.
CREATE TABLE IF NOT EXISTS OrleansQuery
(
    QueryKey varchar(64) NOT NULL,
    QueryText varchar(8000) NOT NULL,

    CONSTRAINT OrleansQuery_Key PRIMARY KEY(QueryKey)
);
