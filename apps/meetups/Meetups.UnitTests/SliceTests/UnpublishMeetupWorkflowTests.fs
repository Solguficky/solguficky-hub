/// Оболочка среза «снять с публикации». Здесь проверяется то, чего не видно в
/// домене: повтор на уже скрытой сходке не должен открывать транзакцию, а конверт
/// события обязан нести выданный оболочкой идентификатор и её же момент.
module Meetups.SliceTests.UnpublishMeetupWorkflowTests

open System
open System.Threading.Tasks
open Swensen.Unquote
open Xunit
open Meetups.Domain
open Meetups.Infrastructure
open Meetups.Slices.UnpublishMeetup
open Meetups.TestData

let private eventId = Guid.Parse "0199c0de-0000-7000-8000-00000000e005"

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

/// Два чтения подряд: основное и перечитывание после расхождения версий. Дальше
/// отдаётся второй снимок — тесту достаточно одной пары.
let private loadingThen (first: MeetupSnapshot option) (second: MeetupSnapshot option) (deps: Deps) =
    let mutable reads = 0

    { deps with
        Load =
            fun _ ->
                reads <- reads + 1
                Task.FromResult(if reads = 1 then first else second)
    }

let private recording (written: ResizeArray<_>) (deps: Deps) =
    { deps with
        Commit =
            fun envelope _ state event ->
                written.Add(envelope, state, event)

                Meetup.apply state event
                |> Meetup.toSnapshot
                |> Ok
                |> Task.FromResult
    }

[<Fact>]
let ``A visible meetup is hidden and written as one event`` () =
    let written = ResizeArray()

    let result =
        stub
        |> loading (Some(Meetup.toSnapshot Sample.published))
        |> recording written
        |> run

    let envelope, state, event = written[0]

    test <@ written.Count = 1 @>
    test <@ state = Existing Sample.published @>
    test <@ event = MeetupUnpublished @>
    test <@ envelope.EventId = eventId @>
    test <@ envelope.OccurredAt = Sample.later @>

    test
        <@
            result
            |> Result.map (fun snapshot -> snapshot.Visibility) = Ok Hidden
        @>

/// Отметка первой публикации переживает снятие: восстановить её задним числом
/// невозможно, и оболочка не имеет права её обнулить по дороге к хранилищу.
[<Fact>]
let ``The first publication mark survives the unpublication`` () =
    let written = ResizeArray()

    let result =
        stub
        |> loading (Some(Meetup.toSnapshot Sample.published))
        |> recording written
        |> run

    test
        <@
            result
            |> Result.map (fun snapshot -> snapshot.FirstPublishedAt) = Ok(Some Sample.fixedNow)
        @>

[<Fact>]
let ``Unpublishing an already hidden meetup returns its snapshot without writing`` () =
    let stored = Meetup.toSnapshot Sample.titled
    let result = run (stub |> loading (Some stored))

    test <@ result = Ok stored @>

/// Отменённая скрытая сходка идёт той же веткой повтора: отмена не превращает
/// успешный повтор в отказ, и убедиться в этом можно только здесь — Deps падают на
/// любом обращении к Commit.
[<Fact>]
let ``Unpublishing a cancelled hidden meetup returns its snapshot without writing`` () =
    let stored = Meetup.toSnapshot Sample.cancelled
    let result = run (stub |> loading (Some stored))

    test <@ result = Ok stored @>

[<Fact>]
let ``Unpublishing a cancelled visible meetup is rejected without writing`` () =
    let result =
        run (
            stub
            |> loading (Some(Meetup.toSnapshot Sample.cancelledVisible))
        )

    test <@ result = Error(UnpublishMeetupError.Domain TransitionNotAllowed) @>

[<Fact>]
let ``Unpublishing an absent meetup is rejected without writing`` () =
    test <@ run (stub |> loading None) = Error(UnpublishMeetupError.Domain MeetupNotFound) @>

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

    test <@ run deps = Error UnpublishMeetupError.Conflict @>

/// Расхождение версий ещё не отказ: PER-78 требует перечитать состояние и, если
/// цель команды уже в силе, вернуть текущий снимок успехом без события. Второе
/// чтение отдаёт уже скрытую сходку — её снимок и уходит ответом.
[<Fact>]
let ``A stale version with the target already in place is a safe retry`` () =
    let stored =
        Meetup.apply (Existing Sample.published) MeetupUnpublished
        |> Meetup.toSnapshot

    let loaded =
        stub
        |> loadingThen (Some(Meetup.toSnapshot Sample.published)) (Some stored)

    let deps =
        { loaded with
            Commit = fun _ _ _ _ -> Task.FromResult(Error MeetupStore.VersionConflict)
        }

    test <@ run deps = Ok stored @>
