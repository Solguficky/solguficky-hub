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
            sql.Contains("CREATE TABLE meetups")
            && sql.Contains("CREATE TABLE meetup_events")
        @>
