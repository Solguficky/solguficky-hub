/// Оболочка среза «прикрепить материал». Здесь проверяется то, чего не видно в
/// домене: повтор по идентификатору материала не открывает транзакцию, а отказ по
/// праву приходит до загрузки сходки.
module Meetups.SliceTests.AttachMaterialWorkflowTests

open System
open System.Threading.Tasks
open Swensen.Unquote
open Xunit
open Meetups.Domain
open Meetups.Infrastructure
open Meetups.Slices.AttachMaterial
open Meetups.TestData

let private eventId = Guid.Parse "0199c0de-0000-7000-8000-0000000000e7"

let private stub: Deps =
    {
        Load = fun _ -> failwith "Load is not expected in this test"
        Commit = fun _ _ _ _ -> failwith "Commit is not expected in this test"
        Now = fun () -> Sample.later
        NewEventId = fun () -> eventId
        RequestId = None
    }

let private run (viewer: Viewer) (materialId: MaterialId) (deps: Deps) =
    execute
        deps
        {
            Id = Sample.meetupId
            MaterialId = materialId
            Title = "Афиша"
            Source = FileId "file-1"
            Viewer = viewer
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
let ``A material is attached and written as one event`` () =
    let written = ResizeArray()

    let result =
        stub
        |> loading (Some(Meetup.toSnapshot Sample.titled))
        |> recording written
        |> run Sample.administrator Sample.otherMaterialId

    let envelope, _, state, event = written[0]

    let expected =
        {
            Id = Sample.otherMaterialId
            Position = 1
            Title = "Афиша"
            Source = FileId "file-1"
            BoundBy = Sample.authorId
        }

    test <@ written.Count = 1 @>
    test <@ state = Existing Sample.titled @>
    test <@ event = MeetupMaterialAttached expected @>
    test <@ envelope.EventId = eventId @>
    test <@ envelope.PerformedBy = Sample.authorId @>
    test <@ envelope.OccurredAt = Sample.later @>

    test
        <@
            result
            |> Result.map (fun snapshot -> snapshot.Materials) = Ok [ expected ]
        @>

/// Идентификатор материала — ключ идемпотентности: повтор возвращает сохранённый
/// снимок и до записи не доходит, хотя запрос несёт другое название и источник.
[<Fact>]
let ``Attaching the same material id again returns the snapshot without writing`` () =
    let stored = Meetup.toSnapshot Sample.withMaterial

    let repeat =
        stub
        |> loading (Some stored)
        |> run Sample.administrator Sample.materialId

    test <@ repeat = Ok stored @>

/// Право спрашивается до загрузки: `Load` здесь падает, поэтому зелёный тест
/// доказывает заодно, что до хранилища вызов не дошёл.
[<Fact>]
let ``An ordinary viewer is refused before the meetup is loaded`` () =
    let denied = run Sample.ordinary Sample.otherMaterialId stub

    test <@ denied = Error(AttachMaterialError.Forbidden NotAnAdministrator) @>

[<Fact>]
let ``Attaching to a missing meetup is rejected without writing`` () =
    let missing =
        stub
        |> loading None
        |> run Sample.administrator Sample.otherMaterialId

    test <@ missing = Error(AttachMaterialError.Domain MeetupNotFound) @>

[<Fact>]
let ``Attaching to a cancelled meetup is rejected without writing`` () =
    let cancelled =
        stub
        |> loading (Some(Meetup.toSnapshot Sample.cancelled))
        |> run Sample.administrator Sample.otherMaterialId

    test <@ cancelled = Error(AttachMaterialError.Domain TransitionNotAllowed) @>

[<Fact>]
let ``A version conflict from the store becomes a rejected command`` () =
    let conflicting =
        { stub with
            Load = fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.titled))
            Commit = fun _ _ _ _ -> Task.FromResult(Error MeetupStore.VersionConflict)
        }

    let result = run Sample.administrator Sample.otherMaterialId conflicting

    test <@ result = Error AttachMaterialError.Conflict @>
