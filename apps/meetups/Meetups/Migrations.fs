module Meetups.Migrations

open System
open System.Diagnostics
open System.IO
open System.Reflection
open System.Text.RegularExpressions
open System.Threading
open Dapper
open DbUp
open DbUp.Engine
open DbUp.Postgresql
open Npgsql

[<Literal>]
let DatabaseUrlVariable = "MEETUPS_DATABASE_URL"

[<Literal>]
let JournalTable = "meetups_schema_versions"

[<Literal>]
let private lockKey = 872514053L

[<Literal>]
let private lockWaitSeconds = 60.0

[<Literal>]
let private TryLockSql = "SELECT pg_try_advisory_lock(@key)"

[<Literal>]
let private UnlockSql = "SELECT pg_advisory_unlock(@key)"

type Migration =
    {
        Version: int
        Name: string
        Resource: string
        Sql: string
    }

let private resourceMarker = ".Migrations."

let private fileNamePattern =
    Regex(@"^(\d{3})_(.+)\.sql$", RegexOptions.CultureInvariant)

/// Единственное место, где решается, что такое миграция. `apply` гонит DbUp
/// ровно этим списком, поэтому проверки ниже — не документация, а гейт: любой
/// `.sql` рядом со схемой либо назван по нормативу, либо роняет старт.
let list () : Migration list =
    let assembly = Assembly.GetExecutingAssembly()

    let migrations =
        assembly.GetManifestResourceNames()
        |> Array.filter (fun resource ->
            resource.Contains(resourceMarker, StringComparison.Ordinal)
            && resource.EndsWith(".sql", StringComparison.Ordinal)
        )
        // Порядок задаёт имя, а не содержимое: тот же порядок применит DbUp.
        |> Array.sortWith (fun left right -> String.CompareOrdinal(left, right))
        |> Array.map (fun resource ->
            let index = resource.IndexOf(resourceMarker, StringComparison.Ordinal)
            let file = resource.Substring(index + resourceMarker.Length)
            let matched = fileNamePattern.Match(file)

            if not matched.Success then
                failwith $"embedded meetups migration {file} is not named NNN_description.sql"

            use stream = assembly.GetManifestResourceStream(resource)
            use reader = new StreamReader(stream)

            {
                Version = int matched.Groups[1].Value
                Name = matched.Groups[2].Value
                Resource = resource
                Sql = reader.ReadToEnd()
            }
        )

    // Строго возрастающие версии в порядке имён: так проверяется и уникальность
    // номера, и что имя не потеряло ведущие нули, иначе `010` шло бы перед `9`.
    migrations
    |> Array.pairwise
    |> Array.iter (fun (previous, next) ->
        if next.Version <= previous.Version then
            failwith $"embedded meetups migrations are out of order: {previous.Resource} then {next.Resource}"
    )

    Array.toList migrations

let private sslMode (value: string) =
    let normalized = value.Replace("-", "").Replace("_", "")

    match Enum.TryParse<SslMode>(normalized, true) with
    | true, mode -> mode
    | _ -> failwith $"unsupported sslmode {value} in {DatabaseUrlVariable}"

/// Имена libpq не совпадают с ключами Npgsql, поэтому перевод явный. Ключа нет
/// в таблице — `connectionString` падает, а не роняет параметр молча: тихо
/// потерянный `sslmode=verify-full` понижает TLS до неверифицируемого.
let private keywordFor (key: string) =
    match key with
    | "host" -> "Host"
    | "port" -> "Port"
    | "dbname" -> "Database"
    | "user" -> "Username"
    | "password" -> "Password"
    | "application_name" -> "Application Name"
    | "connect_timeout" -> "Timeout"
    | "options" -> "Options"
    | "sslrootcert" -> "Root Certificate"
    | _ -> failwith $"unsupported parameter {key} in {DatabaseUrlVariable}"

let connectionString (dsn: string) =
    if not (dsn.Contains("://", StringComparison.Ordinal)) then
        dsn
    else
        let uri = Uri(dsn)
        let userInfo = uri.UserInfo
        let colon = userInfo.IndexOf(':')
        let builder = NpgsqlConnectionStringBuilder()
        builder.Host <- uri.Host

        if uri.Port > 0 then
            builder.Port <- uri.Port

        if colon < 0 then
            if userInfo <> "" then
                builder.Username <- Uri.UnescapeDataString(userInfo)
        else
            builder.Username <- Uri.UnescapeDataString(userInfo.Substring(0, colon))
            builder.Password <- Uri.UnescapeDataString(userInfo.Substring(colon + 1))

        let database = Uri.UnescapeDataString(uri.AbsolutePath).Trim('/')

        if database <> "" then
            builder.Database <- database

        let query = uri.Query.TrimStart('?')

        for pair in query.Split('&', StringSplitOptions.RemoveEmptyEntries) do
            let parts = pair.Split('=', 2)
            let key = Uri.UnescapeDataString(parts[0]).ToLowerInvariant()

            let value = if parts.Length = 2 then Uri.UnescapeDataString(parts[1]) else ""

            if key = "sslmode" then builder.SslMode <- sslMode value else builder[keywordFor key] <- value

        builder.ConnectionString

/// Сериализует старт нескольких экземпляров. Ожидание ограничено: без предела
/// зависший держатель блокировки останавливал бы каждый следующий процесс
/// навсегда, до того как Kestrel вообще откроет порт.
let private acquireLock (conn: NpgsqlConnection) =
    let deadline = Stopwatch.StartNew()
    let mutable acquired = false

    while not acquired
          && deadline.Elapsed.TotalSeconds < lockWaitSeconds do
        acquired <-
            conn.ExecuteScalar<bool>(
                TryLockSql,
                {|
                    key = lockKey
                |}
            )

        if not acquired then
            Thread.Sleep(TimeSpan.FromMilliseconds(200.0))

    if not acquired then
        failwith $"meetups schema lock is held by another process after {lockWaitSeconds} s"

let apply (dsn: string) =
    let cs = connectionString dsn

    let scripts =
        list ()
        |> List.map (fun migration -> SqlScript(migration.Resource, migration.Sql))

    use conn = new NpgsqlConnection(cs)
    conn.Open()
    acquireLock conn

    try
        let result =
            DeployChanges.To
                .PostgresqlDatabase(cs)
                .WithScripts(scripts)
                .JournalToPostgresqlTable("public", JournalTable)
                .WithTransaction()
                .LogToConsole()
                .Build()
                .PerformUpgrade()

        if not result.Successful then
            match result.Error with
            | null -> failwith "meetups schema upgrade failed"
            | error -> raise error
    finally
        conn.ExecuteScalar<bool>(
            UnlockSql,
            {|
                key = lockKey
            |}
        )
        |> ignore
