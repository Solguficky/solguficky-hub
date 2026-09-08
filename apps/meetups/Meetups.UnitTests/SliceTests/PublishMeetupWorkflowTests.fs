/// Оболочка среза «опубликовать». Здесь проверяется то, чего не видно в домене:
/// момент публикации и момент события обязаны быть одним значением, а повтор на
/// видимой сходке не должен открывать транзакцию.
module Meetups.SliceTests.PublishMeetupWorkflowTests

open System
open System.Threading.Tasks
open Swensen.Unquote
open Xunit
open Meetups.Domain
open Meetups.Infrastructure
open Meetups.Slices.PublishMeetup
open Meetups.TestData

let private eventId = Guid.Parse "0199c0de-0000-7000-8000-00000000e002"

let private stub: Deps =
    {
        Load = fun _ -> failwith "Load is not expected in this test"
        Commit = fun _ _ _ -> failwith "Commit is not expected in this test"
        Now = fun () -> Sample.later
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

let private recording (written: ResizeArray<_>) (deps: Deps) =
    { deps with
        Commit =
            fun envelope state event ->
                written.Add(envelope, state, event)

                Meetup.apply state event
                |> Meetup.toSnapshot
                |> Ok
                |> Task.FromResult
    }

[<Fact>]
let ``A titled hidden meetup is published and written as one event`` () =
    let written = ResizeArray()

    let result =
        stub
        |> loading (Some(Meetup.toSnapshot Sample.titled))
        |> recording written
        |> run

    let expected =
        Meetup.apply (Existing Sample.titled) (MeetupPublished Sample.later)
        |> Meetup.toSnapshot

    test <@ result = Ok expected @>
    test <@ written.Count = 1 @>

/// Один и тот же момент становится отметкой первой публикации в состоянии и
/// `occurred_at` в конверте. Два чтения часов дали бы одному факту два времени, и
/// заметить это можно только здесь: домен своих часов не читает вовсе.
[<Fact>]
let ``The publication moment and the event moment are the same value`` () =
    let written = ResizeArray()

    let result =
        stub
        |> loading (Some(Meetup.toSnapshot Sample.titled))
        |> recording written
        |> run

    let envelope, _, event = written[0]

    let publishedAt =
        match result with
        | Ok snapshot -> snapshot.FirstPublishedAt
        | Error _ -> None

    test
        <@
            envelope.OccurredAt = Sample.later
            && event = MeetupPublished Sample.later
            && publishedAt = Some Sample.later
        @>

[<Fact>]
let ``Publishing an already visible meetup returns its snapshot without writing`` () =
    let stored = Meetup.toSnapshot Sample.published
    let result = run (stub |> loading (Some stored))

    test <@ result = Ok stored @>

[<Fact>]
let ``Publishing an absent meetup is rejected without writing`` () =
    test <@ run (stub |> loading None) = Error(PublishMeetupError.Domain MeetupNotFound) @>

[<Fact>]
let ``A meetup without a title is rejected without writing`` () =
    let result =
        run (
            stub
            |> loading (Some(Meetup.toSnapshot Sample.draft))
        )

    test <@ result = Error(PublishMeetupError.Domain TitleRequiredForPublication) @>

[<Fact>]
let ``A version conflict from the store becomes a rejected command`` () =
    let loaded =
        stub
        |> loading (Some(Meetup.toSnapshot Sample.titled))

    let deps =
        { loaded with
            Commit =
                fun _ _ _ ->
                    Error MeetupStore.VersionConflict
                    |> Task.FromResult
        }

    test <@ run deps = Error PublishMeetupError.Conflict @>
