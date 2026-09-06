namespace Meetups.IntegrationTests.Infrastructure

open System
open System.IO
open System.Security.Cryptography
open System.Text
open System.Text.RegularExpressions
open Npgsql
open Testcontainers.PostgreSql
open Xunit

module PostgresAdmin =
    let private dockerLooksAvailable () =
        let home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)

        File.Exists("/var/run/docker.sock")
        || File.Exists(Path.Combine(home, ".docker/run/docker.sock"))
        || not (isNull (Environment.GetEnvironmentVariable("DOCKER_HOST")))

    let private container =
        lazy
            (try
                if not (dockerLooksAvailable ()) then
                    None
                else
                    let postgres = PostgreSqlBuilder("postgres:16-alpine").Build()
                    postgres.StartAsync().GetAwaiter().GetResult()
                    Some postgres
             with _ ->
                 None)

    let connectionString () =
        match container.Value with
        | Some postgres -> postgres.GetConnectionString()
        | None when not (isNull (Environment.GetEnvironmentVariable("GITHUB_ACTIONS"))) ->
            failwith "testcontainers postgres is required in CI"
        | None ->
            match Environment.GetEnvironmentVariable("MEETUPS_DATABASE_URL") with
            | null
            | "" ->
                Meetups.Migrations.connectionString
                    "postgres://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable"
            | url -> Meetups.Migrations.connectionString url

type IsolatedDatabase() =
    let adminCs = PostgresAdmin.connectionString ()

    let name =
        let bytes = SHA256.HashData(Encoding.UTF8.GetBytes(Guid.NewGuid().ToString("N")))
        let hex = Convert.ToHexString(bytes[0..9]).ToLowerInvariant()
        let generated = "mtest_" + hex

        if not (Regex.IsMatch(generated, @"^[a-z][a-z0-9_]*$")) then
            failwith $"generated database name {generated} is not safe"

        generated

    let isolatedCs =
        let builder = NpgsqlConnectionStringBuilder(adminCs)
        builder.Database <- name
        builder.ConnectionString

    do
        try
            use conn = new NpgsqlConnection(adminCs)
            conn.Open()
            use create = new NpgsqlCommand("CREATE DATABASE " + name, conn)
            create.ExecuteNonQuery() |> ignore
        with ex ->
            let forced =
                not (isNull (Environment.GetEnvironmentVariable("MEETUPS_DATABASE_URL")))
                || not (isNull (Environment.GetEnvironmentVariable("GITHUB_ACTIONS")))

            if forced then failwith $"postgres: {ex.Message}" else Assert.Skip $"postgres not available: {ex.Message}"

    member _.ConnectionString = isolatedCs

    interface IDisposable with
        member _.Dispose() =
            try
                use conn = new NpgsqlConnection(adminCs)
                conn.Open()

                use drop =
                    new NpgsqlCommand(
                        "DROP DATABASE IF EXISTS "
                        + name
                        + " WITH (FORCE)",
                        conn
                    )

                drop.ExecuteNonQuery() |> ignore
            with _ ->
                ()
