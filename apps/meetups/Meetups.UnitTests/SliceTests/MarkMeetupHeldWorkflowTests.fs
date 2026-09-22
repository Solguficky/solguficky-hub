/// Оболочка среза «отметить состоявшейся». Здесь проверяется то, чего не видно в
/// домене: повтор на уже состоявшейся сходке не должен открывать транзакцию, а
/// отметка видимой сходки обязана дойти до хранилища, не тронув её видимость.
module Meetups.SliceTests.MarkMeetupHeldWorkflowTests

open System
open System.Threading.Tasks
open Swensen.Unquote
open Xunit
open Meetups.Domain
open Meetups.Infrastructure
open Meetups.Slices.MarkMeetupHeld
open Meetups.TestData

let private eventId = Guid.Parse "0199c0de-0000-7000-8000-00000000e007"

let private stub: Deps =
    {
        Load = fun _ -> failwith "Load is not expected in this test"
        Commit = fun _ _ _ _ -> failwith "Commit is not expected in this test"
        Now = fun () -> Sample.later
        NewEventId = fun () -> eventId
    }

let private run (deps: Deps) =
    execute
        deps
        {
            Id = Sample.meetupId
            Viewer = Sample.administrator
            ExpectedVersion = Sample.expectedVersion
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
            fun envelope expectedVersion state event ->
                written.Add(envelope, expectedVersion, state, event)

                Meetup.apply state event
                |> Meetup.toSnapshot
                |> Ok
                |> Task.FromResult
    }

[<Fact>]
let ``A planned meetup is marked as held and written as one event`` () =
    let written = ResizeArray()

    let result =
        stub
        |> loading (Some(Meetup.toSnapshot Sample.published))
        |> recording written
        |> run

    let envelope, expectedVersion, state, event = written[0]

    test <@ written.Count = 1 @>
    test <@ expectedVersion = Some Sample.expectedVersion @>
    test <@ state = Existing Sample.published @>
    test <@ event = MeetupHeld @>
    test <@ envelope.EventId = eventId @>
    test <@ envelope.OccurredAt = Sample.later @>

    test
        <@
            result
            |> Result.map (fun snapshot -> snapshot.Lifecycle) = Ok Held
        @>

/// Оси независимы и по дороге через оболочку тоже: состоявшаяся видимая сходка
/// остаётся видимой, а архив не становится способом её спрятать.
[<Fact>]
let ``Marking a visible meetup as held leaves it visible`` () =
    let written = ResizeArray()

    let result =
        stub
        |> loading (Some(Meetup.toSnapshot Sample.published))
        |> recording written
        |> run

    test
        <@
            result
            |> Result.map (fun snapshot -> snapshot.Visibility) = Ok Visible
        @>

[<Fact>]
let ``Marking an already held meetup returns its snapshot without writing`` () =
    let stored = Meetup.toSnapshot Sample.held
    let result = run (stub |> loading (Some stored))

    test <@ result = Ok stored @>

[<Fact>]
let ``Marking a cancelled meetup as held is rejected without writing`` () =
    let result =
        run (
            stub
            |> loading (Some(Meetup.toSnapshot Sample.cancelled))
        )

    test <@ result = Error(MarkMeetupHeldError.Domain TransitionNotAllowed) @>

[<Fact>]
let ``Marking an absent meetup as held is rejected without writing`` () =
    test <@ run (stub |> loading None) = Error(MarkMeetupHeldError.Domain MeetupNotFound) @>

[<Fact>]
let ``A version conflict from the store becomes a rejected command`` () =
    let loaded =
        stub
        |> loading (Some(Meetup.toSnapshot Sample.published))

    let deps =
        { loaded with
            Commit =
                fun _ _ _ _ ->
                    Error MeetupStore.VersionConflict
                    |> Task.FromResult
        }

    test <@ run deps = Error MarkMeetupHeldError.Conflict @>
