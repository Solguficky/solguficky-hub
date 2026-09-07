/// Оболочка среза «завести черновик»: что она делает с решением домена и когда она
/// вообще идёт в базу. Доменные решения уже проверены в DomainTests и здесь не
/// дублируются — проверяется дисциплина оболочки.
module Meetups.SliceTests.CreateMeetupDraftWorkflowTests

open System
open System.Threading.Tasks
open Swensen.Unquote
open Xunit
open Meetups.Domain
open Meetups.Infrastructure
open Meetups.Slices.CreateMeetupDraft
open Meetups.TestData

let private eventId = Guid.Parse "0199c0de-0000-7000-8000-00000000e001"

/// Поле, чей вызов сам является наблюдаемым эффектом, обязано падать, пока тест его
/// не переопределил: заглушка, молча возвращающая пустой результат, превратила бы
/// пропущенное обращение к базе в зелёный тест.
let private stub: Deps =
    {
        Load = fun _ -> failwith "Load is not expected in this test"
        Commit = fun _ _ _ -> failwith "Commit is not expected in this test"
        Now = fun () -> Sample.fixedNow
        NewEventId = fun () -> eventId
    }

let private run (deps: Deps) =
    execute
        deps
        {
            Id = Sample.meetupId
            PerformedBy = Sample.authorId
        }
    |> Async.AwaitTask
    |> Async.RunSynchronously

let private loading (snapshot: MeetupSnapshot option) (deps: Deps) =
    { deps with
        Load = fun _ -> Task.FromResult snapshot
    }

[<Fact>]
let ``An absent meetup is created and written as its first event`` () =
    let written = ResizeArray()
    let loaded = stub |> loading None

    let deps =
        { loaded with
            Commit =
                fun envelope state event ->
                    written.Add(envelope, state, event)

                    Meetup.apply state event
                    |> Meetup.toSnapshot
                    |> Ok
                    |> Task.FromResult
        }

    let result = run deps
    let envelope, state, event = written[0]

    test <@ written.Count = 1 @>
    test <@ state = Initial @>
    test <@ event = MeetupCreated(Sample.meetupId, Sample.authorId) @>
    test <@ envelope.EventId = eventId @>
    test <@ envelope.PerformedBy = Sample.authorId @>
    test <@ envelope.OccurredAt = Sample.fixedNow @>
    test <@ result = Ok(Meetup.toSnapshot Sample.draft) @>

/// Повтор тем же автором — успех без события. Ветка обязана вернуть то, что уже
/// лежит в базе, и не открывать транзакцию вовсе: падающий Commit это и ловит.
[<Fact>]
let ``A repeat by the same author returns the stored snapshot without writing`` () =
    let stored = Meetup.toSnapshot Sample.titled
    let result = run (stub |> loading (Some stored))

    test <@ result = Ok stored @>

[<Fact>]
let ``A repeat by another author is rejected without writing`` () =
    let stored =
        { Meetup.toSnapshot Sample.titled with
            Author = Sample.otherAuthorId
        }

    let result = run (stub |> loading (Some stored))

    test <@ result = Error(CreateMeetupDraftError.Domain DraftBelongsToAnotherAuthor) @>

/// Расхождение версии приходит из хранилища типизированным результатом, и оболочка
/// обязана отобразить его в отказ, а не выдать применённый в памяти снимок за
/// записанный.
[<Fact>]
let ``A version conflict from the store becomes a rejected command`` () =
    let loaded = stub |> loading None

    let deps =
        { loaded with
            Commit =
                fun _ _ _ ->
                    Error MeetupStore.VersionConflict
                    |> Task.FromResult
        }

    test <@ run deps = Error CreateMeetupDraftError.Conflict @>

/// Идентификатор события запрашивается ровно один раз на записанное событие: вторая
/// генерация означала бы, что возвращённый и записанный конверты могут разойтись.
[<Fact>]
let ``The event identifier is generated once per written event`` () =
    let generated = ref 0

    let loaded = stub |> loading None

    let deps =
        { loaded with
            NewEventId =
                fun () ->
                    generated.Value <- generated.Value + 1
                    eventId
            Commit =
                fun _ state event ->
                    Meetup.apply state event
                    |> Meetup.toSnapshot
                    |> Ok
                    |> Task.FromResult
        }

    run deps |> ignore

    test <@ generated.Value = 1 @>

[<Fact>]
let ``A repeat generates no event identifier at all`` () =
    let generated = ref 0

    let loaded =
        stub
        |> loading (Some(Meetup.toSnapshot Sample.titled))

    let deps =
        { loaded with
            NewEventId =
                fun () ->
                    generated.Value <- generated.Value + 1
                    eventId
        }

    run deps |> ignore

    test <@ generated.Value = 0 @>
