module Meetups.Migrations

open System
open System.IO
open System.Reflection
open System.Text.RegularExpressions
open DbUp
open DbUp.Postgresql
open Npgsql

[<Literal>]
let DatabaseUrlVariable = "MEETUPS_DATABASE_URL"

[<Literal>]
let JournalTable = "meetups_schema_versions"

[<Literal>]
let private lockKey = 872514053L

type Migration =
    {
        Version: int
        Name: string
        Sql: string
    }

let private resourceMarker = ".Migrations."

let private fileNamePattern =
    Regex(@"^(\d+)_(.+)\.sql$", RegexOptions.CultureInvariant)

let private parseResourceName (resource: string) =
    let index = resource.IndexOf(resourceMarker, StringComparison.Ordinal)

    if index < 0 then
        None
    else
        let file = resource.Substring(index + resourceMarker.Length)
        let matched = fileNamePattern.Match(file)

        if matched.Success then Some(int matched.Groups[1].Value, matched.Groups[2].Value, resource) else None

let list () : Migration list =
    let assembly = Assembly.GetExecutingAssembly()

    let migrations =
        assembly.GetManifestResourceNames()
        |> Array.choose parseResourceName
        |> Array.map (fun (version, name, resource) ->
            use stream = assembly.GetManifestResourceStream(resource)
            use reader = new StreamReader(stream)

            {
                Version = version
                Name = name
                Sql = reader.ReadToEnd()
            }
        )
        |> Array.sortBy (fun migration -> migration.Version)

    let versions =
        migrations
        |> Array.map (fun migration -> migration.Version)

    if
        versions.Length
        <> (versions |> Array.distinct).Length
    then
        failwith "embedded meetups migrations contain duplicate versions"

    Array.toList migrations

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

        let database = uri.AbsolutePath.Trim('/')

        if database <> "" then
            builder.Database <- database

        let query = uri.Query.TrimStart('?')

        for pair in query.Split('&', StringSplitOptions.RemoveEmptyEntries) do
            let parts = pair.Split('=', 2)

            match parts[0].ToLowerInvariant() with
            | "sslmode" when
                parts.Length = 2
                && parts[1].Equals("disable", StringComparison.OrdinalIgnoreCase)
                ->
                builder.SslMode <- SslMode.Disable
            | "sslmode" when
                parts.Length = 2
                && parts[1].Equals("require", StringComparison.OrdinalIgnoreCase)
                ->
                builder.SslMode <- SslMode.Require
            | _ -> ()

        builder.ConnectionString

let apply (dsn: string) =
    let cs = connectionString dsn
    use conn = new NpgsqlConnection(cs)
    conn.Open()

    use lockCommand = new NpgsqlCommand("SELECT pg_advisory_lock(@key)", conn)

    lockCommand.Parameters.AddWithValue("key", lockKey)
    |> ignore

    lockCommand.ExecuteScalar() |> ignore

    try
        let result =
            DeployChanges.To
                .PostgresqlDatabase(cs)
                .WithScriptsEmbeddedInAssembly(
                    Assembly.GetExecutingAssembly(),
                    fun name ->
                        name.Contains(resourceMarker, StringComparison.Ordinal)
                        && name.EndsWith(".sql", StringComparison.Ordinal)
                )
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
        use unlockCommand = new NpgsqlCommand("SELECT pg_advisory_unlock(@key)", conn)

        unlockCommand.Parameters.AddWithValue("key", lockKey)
        |> ignore

        unlockCommand.ExecuteScalar() |> ignore
