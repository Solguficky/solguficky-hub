module Meetups.Program

open System

[<EntryPoint>]
let main args =
    match Environment.GetEnvironmentVariable(Meetups.Migrations.DatabaseUrlVariable) with
    | null
    | "" ->
        eprintfn "%s is not set" Meetups.Migrations.DatabaseUrlVariable
        1
    | url ->
        Meetups.Migrations.apply url
        let app = Meetups.Host.build args
        app.Run()
        0
