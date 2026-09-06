module Meetups.Migrations

open System
open System.IO
open System.Reflection
open System.Text.RegularExpressions
open Npgsql

[<Literal>]
let DatabaseUrlVariable = "MEETUPS_DATABASE_URL"

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

let private execute (conn: NpgsqlConnection) (tx: NpgsqlTransaction) (sql: string) (parameters: (string * obj) list) =
    use command = new NpgsqlCommand(sql, conn, tx)

    for name, value in parameters do
        command.Parameters.AddWithValue(name, value)
        |> ignore

    command.ExecuteNonQuery() |> ignore

let private scalar (conn: NpgsqlConnection) (tx: NpgsqlTransaction) (sql: string) (parameters: (string * obj) list) =
    use command = new NpgsqlCommand(sql, conn, tx)

    for name, value in parameters do
        command.Parameters.AddWithValue(name, value)
        |> ignore

    command.ExecuteScalar()

let apply (connectionString: string) =
    use conn = new NpgsqlConnection(connectionString)
    conn.Open()

    use lockCommand = new NpgsqlCommand("SELECT pg_advisory_lock(@key)", conn)

    lockCommand.Parameters.AddWithValue("key", lockKey)
    |> ignore

    lockCommand.ExecuteScalar() |> ignore

    try
        use tx = conn.BeginTransaction()

        execute
            conn
            tx
            """
            CREATE TABLE IF NOT EXISTS meetups_schema_versions (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
            []

        for migration in list () do
            let already =
                scalar
                    conn
                    tx
                    "SELECT 1 FROM meetups_schema_versions WHERE version = @version"
                    [ "version", box migration.Version ]

            if isNull already then
                execute conn tx migration.Sql []

                execute
                    conn
                    tx
                    "INSERT INTO meetups_schema_versions (version, name) VALUES (@version, @name)"
                    [
                        "version", box migration.Version
                        "name", box migration.Name
                    ]

        tx.Commit()
    finally
        use unlockCommand = new NpgsqlCommand("SELECT pg_advisory_unlock(@key)", conn)

        unlockCommand.Parameters.AddWithValue("key", lockKey)
        |> ignore

        unlockCommand.ExecuteScalar() |> ignore
