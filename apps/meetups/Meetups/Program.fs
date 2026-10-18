module Meetups.Program

open System
open Meetups.Transport
open Microsoft.AspNetCore.Builder

let private run args =
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

[<EntryPoint>]
let main args =
    // Та же конфигурация токенов, что у Host.build, но отказ до миграций.
    let configuration = WebApplication.CreateBuilder(args).Configuration

    let validated =
        try
            let read name = configuration[name]
            let callers = CallerTable.FromConfiguration(read, MethodAccess.declared)

            ServiceToken.fromConfiguration read callers
            |> ignore

            Ok()
        with :? InvalidOperationException as refused ->
            Error refused.Message

    match validated with
    | Error reason ->
        System.Text.Json.JsonSerializer.Serialize
            {|
                service = "meetups"
                error = reason
            |}
        |> eprintfn "%s"

        1
    | Ok() -> run args
