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
        // Отказ схемы — рабочий исход старта, а не баг рантайма: оператор должен
        // прочитать одну строку про базу, а не stack trace из недр DbUp.
        match
            (try
                Ok(Meetups.Migrations.apply url)
             with ex ->
                 Error ex)
        with
        | Error ex ->
            eprintfn "%s: schema migration failed: %s" Meetups.Migrations.DatabaseUrlVariable ex.Message
            1
        | Ok() ->
            let app = Meetups.Host.build args
            app.Run()
            0
