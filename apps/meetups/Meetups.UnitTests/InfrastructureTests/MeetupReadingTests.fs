module Meetups.InfrastructureTests.MeetupReadingTests

open System.Reflection
open Meetups.Domain
open Meetups.Infrastructure
open Npgsql
open Swensen.Unquote
open Xunit

[<Fact>]
let ``The reading module exposes one store function and it requires a viewer`` () =
    let readingModule = typeof<MeetupReading.Scope>.DeclaringType

    let actual =
        readingModule.GetMethods(BindingFlags.Public ||| BindingFlags.Static)
        |> Seq.filter (fun methodInfo ->
            let parameters = methodInfo.GetParameters()

            parameters.Length > 0
            && parameters[0].ParameterType = typeof<NpgsqlDataSource>
        )
        |> Seq.map (fun methodInfo ->
            methodInfo.Name,
            methodInfo.GetParameters()
            |> Seq.map (fun parameter -> parameter.ParameterType)
            |> List.ofSeq
        )
        |> List.ofSeq

    test
        <@
            actual = [
                "read",
                [
                    typeof<NpgsqlDataSource>
                    typeof<Viewer>
                    typeof<MeetupReading.Scope>
                ]
            ]
        @>
