module Meetups.MigrationsTests

open Swensen.Unquote
open Xunit

[<Fact>]
let ``Embedded migrations are numbered from one without gaps`` () =
    let versions =
        Meetups.Migrations.list ()
        |> List.map (fun migration -> migration.Version)

    test <@ versions = [ 1 .. versions.Length ] @>

[<Fact>]
let ``The first migration creates both meetup tables`` () =
    let sql = (Meetups.Migrations.list () |> List.head).Sql

    test
        <@
            sql.Contains("CREATE TABLE IF NOT EXISTS meetups")
            && sql.Contains("CREATE TABLE IF NOT EXISTS meetup_events")
        @>

[<Fact>]
let ``A postgres URI becomes a keyword connection string`` () =
    let cs =
        Meetups.Migrations.connectionString "postgres://postgres:secret@127.0.0.1:5432/meetups?sslmode=disable"

    test
        <@
            cs.Contains("Host=127.0.0.1")
            && cs.Contains("Database=meetups")
            && cs.Contains("Password=secret")
        @>

[<Fact>]
let ``A postgres URI keeps a password that contains a colon`` () =
    let cs =
        Meetups.Migrations.connectionString "postgres://user:sec:ret@127.0.0.1:5432/meetups?sslmode=disable"

    test <@ cs.Contains("Password=sec:ret") @>

[<Fact>]
let ``A stricter sslmode survives the translation`` () =
    let cs =
        Meetups.Migrations.connectionString "postgres://user:secret@db:5432/meetups?sslmode=verify-full"

    test <@ cs.Contains("VerifyFull") @>

[<Fact>]
let ``A libpq parameter reaches its Npgsql keyword`` () =
    let cs =
        Meetups.Migrations.connectionString
            "postgres://user:secret@db:5432/meetups?sslmode=require&application_name=meetups"

    test
        <@
            cs.Contains("Application Name=meetups")
            && cs.Contains("Require")
        @>

[<Fact>]
let ``An unsupported parameter is refused instead of dropped`` () =
    raises<exn> <@ Meetups.Migrations.connectionString "postgres://user:secret@db:5432/meetups?fsync=off" @>

[<Fact>]
let ``An unsupported sslmode value is refused instead of downgraded`` () =
    raises<exn> <@ Meetups.Migrations.connectionString "postgres://user:secret@db:5432/meetups?sslmode=verify-most" @>
