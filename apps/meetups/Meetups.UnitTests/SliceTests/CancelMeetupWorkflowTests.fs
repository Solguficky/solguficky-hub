/// Оболочка среза «отменить». Здесь проверяется то, чего не видно в домене: повтор
/// на уже отменённой сходке не должен открывать транзакцию, а отмена видимой сходки
/// обязана дойти до хранилища, не тронув её видимость по дороге.
module Meetups.SliceTests.CancelMeetupWorkflowTests

open System
open System.Threading.Tasks
open Swensen.Unquote
open Xunit
open Meetups.Domain
open Meetups.Infrastructure
open Meetups.Slices.CancelMeetup
open Meetups.TestData

let private eventId = Guid.Parse "0199c0de-0000-7000-8000-00000000e006"

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
            Viewer = Sample.administrator
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
let ``A planned meetup is cancelled and written as one event`` () =
    let written = ResizeArray()

    let result =
        stub
        |> loading (Some(Meetup.toSnapshot Sample.published))
        |> recording written
        |> run

    let envelope, state, event = written[0]

    test <@ written.Count = 1 @>
    test <@ state = Existing Sample.published @>
    test <@ event = MeetupCancelled @>
    test <@ envelope.EventId = eventId @>
    test <@ envelope.OccurredAt = Sample.later @>

    test
        <@
            result
            |> Result.map (fun snapshot -> snapshot.Lifecycle) = Ok Cancelled
        @>

/// Оси независимы и по дороге через оболочку тоже: отменённая видимая сходка
/// остаётся видимой, потому что извещение об отмене и есть то, что сообществу нужно
/// показать.
[<Fact>]
let ``Cancelling a visible meetup leaves it visible`` () =
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
let ``Cancelling an already cancelled meetup returns its snapshot without writing`` () =
    let stored = Meetup.toSnapshot Sample.cancelled
    let result = run (stub |> loading (Some stored))

    test <@ result = Ok stored @>

[<Fact>]
let ``Cancelling a meetup that already took place is rejected without writing`` () =
    let result =
        run (
            stub
            |> loading (Some(Meetup.toSnapshot Sample.held))
        )

    test <@ result = Error(CancelMeetupError.Domain TransitionNotAllowed) @>

[<Fact>]
let ``Cancelling an absent meetup is rejected without writing`` () =
    test <@ run (stub |> loading None) = Error(CancelMeetupError.Domain MeetupNotFound) @>

[<Fact>]
let ``A version conflict from the store becomes a rejected command`` () =
    let loaded =
        stub
        |> loading (Some(Meetup.toSnapshot Sample.published))

    let deps =
        { loaded with
            Commit =
                fun _ _ _ ->
                    Error MeetupStore.VersionConflict
                    |> Task.FromResult
        }

    test <@ run deps = Error CancelMeetupError.Conflict @>
