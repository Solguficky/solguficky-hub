/// Оболочка среза «отменить запланированную публикацию». Команда целевая, поэтому
/// отдельно проверяется ветка «успех без события»: сходка без момента не открывает
/// транзакцию.
module Meetups.SliceTests.CancelMeetupPublicationWorkflowTests

open System
open System.Threading.Tasks
open Swensen.Unquote
open Xunit
open Meetups.Domain
open Meetups.Infrastructure
open Meetups.Slices.CancelMeetupPublication
open Meetups.TestData

let private eventId = Guid.Parse "0199c0de-0000-7000-8000-00000000e024"

let private stub: Deps =
    {
        Load = fun _ -> failwith "Load is not expected in this test"
        Commit = fun _ _ _ _ -> failwith "Commit is not expected in this test"
        Now = fun () -> Sample.later
        NewEventId = fun () -> eventId
        RequestId = None
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
let ``A scheduled moment is cancelled and written as one event`` () =
    let written = ResizeArray()

    let result =
        stub
        |> loading (Some(Meetup.toSnapshot Sample.scheduled))
        |> recording written
        |> run

    let expected =
        Meetup.apply (Existing Sample.scheduled) MeetupPublicationCancelled
        |> Meetup.toSnapshot

    let envelope, _, _, event = written[0]

    test <@ written.Count = 1 @>
    test <@ event = MeetupPublicationCancelled @>
    test <@ envelope.EventId = eventId @>
    test <@ result = Ok expected @>

    test
        <@
            result
            |> Result.map (fun snapshot -> snapshot.ScheduledPublishAt) = Ok None
        @>

[<Fact>]
let ``A meetup without a moment returns the snapshot without writing`` () =
    let stored = Meetup.toSnapshot Sample.titled
    let result = stub |> loading (Some stored) |> run

    test <@ result = Ok stored @>

[<Fact>]
let ``Cancelling an absent meetup is rejected without writing`` () =
    test <@ run (stub |> loading None) = Error(CancelMeetupPublicationError.Domain MeetupNotFound) @>

[<Fact>]
let ``A meetup the worker has already published is refused without writing`` () =
    let publishedByWorker = Meetup.toSnapshot Sample.publishedByWorker

    let result = stub |> loading (Some publishedByWorker) |> run

    test <@ result = Error(CancelMeetupPublicationError.Domain TransitionNotAllowed) @>

[<Fact>]
let ``Losing the race to the worker is a conflict, not a cancelled moment`` () =
    // Решение принято из скрытой сходки с моментом, а запись проиграла воркеру:
    // перечитанная видимая сходка — не достигнутая цель (PER-457, PER-78).
    let publishedByWorker = Meetup.toSnapshot Sample.publishedByWorker

    let mutable loads = 0

    let deps =
        { stub with
            Load =
                fun _ ->
                    loads <- loads + 1

                    if loads = 1 then
                        Task.FromResult(Some(Meetup.toSnapshot Sample.scheduled))
                    else
                        Task.FromResult(Some publishedByWorker)
            Commit =
                fun _ _ _ _ ->
                    Error MeetupStore.VersionConflict
                    |> Task.FromResult
        }

    test <@ run deps = Error CancelMeetupPublicationError.Conflict @>

[<Fact>]
let ``A version conflict from the store becomes a rejected command`` () =
    let loaded =
        stub
        |> loading (Some(Meetup.toSnapshot Sample.scheduled))

    let deps =
        { loaded with
            Commit =
                fun _ _ _ _ ->
                    Error MeetupStore.VersionConflict
                    |> Task.FromResult
        }

    test <@ run deps = Error CancelMeetupPublicationError.Conflict @>
