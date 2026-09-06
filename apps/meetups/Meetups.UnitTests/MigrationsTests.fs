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
