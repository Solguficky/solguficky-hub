namespace Meetups.IntegrationTests.Infrastructure

open System
open Npgsql
open Testcontainers.PostgreSql
open Xunit

module PostgresAdmin =
    /// Пустая переменная — это незаданная переменная. Оба места, где решается
    /// «есть база или нет», обязаны отвечать одинаково.
    let variable (name: string) =
        match Environment.GetEnvironmentVariable(name) with
        | null
        | "" -> None
        | value -> Some value

    /// Своей проверки демона здесь нет: Testcontainers сам знает и unix-socket,
    /// и named pipe Docker Desktop на Windows, а рукописная проверка сокета
    /// молча пропускала бы все тесты схемы на Windows при живом Docker.
    let private container =
        lazy
            (try
                let postgres = PostgreSqlBuilder("postgres:16-alpine").Build()
                postgres.StartAsync().GetAwaiter().GetResult()
                Some postgres
             with _ ->
                 None)

    let started () = container.Value |> Option.isSome

    let connectionString () =
        match container.Value with
        | Some postgres -> postgres.GetConnectionString()
        | None when (variable "GITHUB_ACTIONS").IsSome -> failwith "testcontainers postgres is required in CI"
        | None ->
            match variable "MEETUPS_DATABASE_URL" with
            | None ->
                Meetups.Migrations.connectionString
                    "postgres://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable"
            | Some url -> Meetups.Migrations.connectionString url

type IsolatedDatabase() =
    let adminCs = PostgresAdmin.connectionString ()

    // Guid уже 32 шестнадцатеричных символа в нижнем регистре: имя безопасно по
    // построению, хэшировать и перепроверять регуляркой нечего.
    let name =
        "mtest_"
        + Guid.NewGuid().ToString("N").Substring(0, 20)

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
            // Контейнер поднялся — значит база есть, и отказ CREATE DATABASE это
            // настоящая поломка, а не «постгреса рядом нет». Пропуск здесь
            // прятал бы её за зелёным прогоном.
            let forced =
                PostgresAdmin.started ()
                || (PostgresAdmin.variable "MEETUPS_DATABASE_URL").IsSome
                || (PostgresAdmin.variable "GITHUB_ACTIONS").IsSome

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
            with ex ->
                // Уронить прогон на уборке нельзя, но и молчать нельзя: тихий
                // отказ копит осиротевшие mtest_* на общей базе до упора в
                // лимит соединений, и узнают об этом не из прогона.
                eprintfn "cleanup drop %s: %s" name ex.Message
