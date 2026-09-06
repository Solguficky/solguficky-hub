namespace Meetups.IntegrationTests.Infrastructure

open System
open System.Security.Cryptography
open System.Text
open System.Text.RegularExpressions
open Npgsql
open Xunit

type IsolatedDatabase() =
    let adminUrl =
        match Environment.GetEnvironmentVariable("MEETUPS_DATABASE_URL") with
        | null
        | "" -> "postgres://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable"
        | url -> url

    let name =
        let bytes = SHA256.HashData(Encoding.UTF8.GetBytes(Guid.NewGuid().ToString("N")))
        let hex = Convert.ToHexString(bytes[0..9]).ToLowerInvariant()
        let generated = "mtest_" + hex

        if not (Regex.IsMatch(generated, @"^[a-z][a-z0-9_]*$")) then
            failwith $"generated database name {generated} is not safe"

        generated

    let rewriteDatabase (dsn: string) =
        let uri = Uri(dsn)
        let builder = UriBuilder(uri)
        builder.Path <- "/" + name
        builder.Uri.AbsoluteUri

    do
        try
            use conn = new NpgsqlConnection(adminUrl)
            conn.Open()
            use create = new NpgsqlCommand("CREATE DATABASE " + name, conn)
            create.ExecuteNonQuery() |> ignore
        with ex ->
            let forced =
                not (isNull (Environment.GetEnvironmentVariable("MEETUPS_DATABASE_URL")))
                || not (isNull (Environment.GetEnvironmentVariable("GITHUB_ACTIONS")))

            if forced then failwith $"postgres: {ex.Message}" else Assert.Skip $"postgres not available: {ex.Message}"

    member _.ConnectionString = rewriteDatabase adminUrl

    interface IDisposable with
        member _.Dispose() =
            try
                use conn = new NpgsqlConnection(adminUrl)
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
