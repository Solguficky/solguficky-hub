/// Оболочка среза «убрать материал». Здесь проверяется то, чего не видно в домене:
/// отсутствие материала — успех без записи, а отказ по праву приходит до загрузки.
module Meetups.SliceTests.RemoveMaterialWorkflowTests

open System
open System.Threading.Tasks
open Swensen.Unquote
open Xunit
open Meetups.Domain
open Meetups.Infrastructure
open Meetups.Slices.RemoveMaterial
open Meetups.TestData

let private eventId = Guid.Parse "0199c0de-0000-7000-8000-0000000000e8"

let private stub: Deps =
    {
        Load = fun _ -> failwith "Load is not expected in this test"
        Commit = fun _ _ _ -> failwith "Commit is not expected in this test"
        Now = fun () -> Sample.later
        NewEventId = fun () -> eventId
    }

let private run (viewer: Viewer) (deps: Deps) =
    execute
        deps
        {
            Id = Sample.meetupId
            MaterialId = Sample.materialId
            Viewer = viewer
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
let ``A material is removed and written as one event`` () =
    let written = ResizeArray()

    let result =
        stub
        |> loading (Some(Meetup.toSnapshot Sample.withMaterial))
        |> recording written
        |> run Sample.administrator

    let envelope, state, event = written[0]

    test <@ written.Count = 1 @>
    test <@ state = Existing Sample.withMaterial @>
    test <@ event = MeetupMaterialRemoved Sample.materialId @>
    test <@ envelope.EventId = eventId @>
    test <@ envelope.PerformedBy = Sample.authorId @>
    test <@ envelope.OccurredAt = Sample.later @>

    test
        <@
            result
            |> Result.map (fun snapshot -> snapshot.Materials) = Ok []
        @>

/// Повтор удаления — достигнутое целевое состояние: снимок возвращается, транзакция
/// не открывается.
[<Fact>]
let ``Removing an absent material returns the snapshot without writing`` () =
    let stored = Meetup.toSnapshot Sample.titled

    let repeat =
        stub
        |> loading (Some stored)
        |> run Sample.administrator

    test <@ repeat = Ok stored @>

/// Право спрашивается до загрузки: `Load` здесь падает, поэтому зелёный тест
/// доказывает заодно, что до хранилища вызов не дошёл.
[<Fact>]
let ``An ordinary viewer is refused before the meetup is loaded`` () =
    test <@ run Sample.ordinary stub = Error(RemoveMaterialError.Forbidden NotAnAdministrator) @>

[<Fact>]
let ``Removing from a missing meetup is rejected without writing`` () =
    test <@ stub |> loading None |> run Sample.administrator = Error(RemoveMaterialError.Domain MeetupNotFound) @>

[<Fact>]
let ``Removing from a cancelled meetup is rejected without writing`` () =
    test
        <@
            stub
            |> loading (Some(Meetup.toSnapshot Sample.cancelledWithMaterial))
            |> run Sample.administrator = Error(RemoveMaterialError.Domain TransitionNotAllowed)
        @>

[<Fact>]
let ``A version conflict from the store becomes a rejected command`` () =
    let conflicting =
        { stub with
            Load = fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.withMaterial))
            Commit = fun _ _ _ -> Task.FromResult(Error MeetupStore.VersionConflict)
        }

    test <@ run Sample.administrator conflicting = Error RemoveMaterialError.Conflict @>
