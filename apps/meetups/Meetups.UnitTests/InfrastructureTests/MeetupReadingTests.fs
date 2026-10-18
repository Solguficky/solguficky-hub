module Meetups.InfrastructureTests.MeetupReadingTests

open System.Reflection
open Meetups.Domain
open Meetups.Infrastructure
open Npgsql
open Swensen.Unquote
open Xunit

let private readingModule = typeof<MeetupReading.Scope>.DeclaringType

/// Всё, чем модуль чтения ходит в источник: первый параметр — NpgsqlDataSource.
let private storeFunctions =
    readingModule.GetMethods(BindingFlags.Public ||| BindingFlags.Static)
    |> Seq.filter (fun methodInfo ->
        let parameters = methodInfo.GetParameters()

        parameters.Length > 0
        && parameters[0].ParameterType = typeof<NpgsqlDataSource>
    )
    |> List.ofSeq

let private signatureOf name =
    let methodInfo =
        storeFunctions
        |> List.find (fun candidate -> candidate.Name = name)

    methodInfo.GetParameters()
    |> Seq.map (fun parameter -> parameter.ParameterType)
    |> List.ofSeq

/// Список именной, а не «одна функция»: служебный обход состояния (PER-211) —
/// сознательное второе чтение мимо правил наблюдаемости, и оно названо здесь,
/// чтобы третий обход мимо viewer-aware пути ломал тест, а не появлялся молча.
[<Fact>]
let ``The store exposes the product read and the service walk, and nothing else`` () =
    let names = storeFunctions |> List.map _.Name |> List.sort

    test <@ names = [ "read"; "readStates" ] @>

[<Fact>]
let ``The product read requires a viewer`` () =
    let expected =
        [
            typeof<NpgsqlDataSource>
            typeof<Viewer>
            typeof<MeetupReading.Scope>
        ]

    test <@ signatureOf "read" = expected @>

/// Смотрящего у служебного обхода нет по построению, а не по недосмотру: реплике
/// нужны все строки, и подставить ей «того, кто видит всё» значило бы завести
/// право, которого в домене нет.
[<Fact>]
let ``The service walk takes a cursor and a limit instead of a viewer`` () =
    let expected =
        [
            typeof<NpgsqlDataSource>
            typeof<MeetupId option>
            typeof<int>
        ]

    test <@ signatureOf "readStates" = expected @>
