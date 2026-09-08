/// Коды отказов командных операций. Уровень выбран по достижимости: через
/// настоящий gRPC не воспроизвести конфликт версии — `expected_version` во вход
/// команд не входит намеренно (ADR-031), поэтому снаружи он наблюдается только как
/// гонка двух параллельных вызовов. Здесь весь набор достижим подстановкой Deps.
///
/// Тест идёт настоящим путём `Api.handle` и ловит RpcException, а не заглядывает в
/// приватное отображение: проверяется то, что увидит клиент.
module Meetups.SliceTests.CommandApiTests

open System
open System.Threading.Tasks
open Grpc.Core
open Meetups.Domain
open Meetups.Infrastructure
open Meetups.Slices
open Meetups.TestData
open Swensen.Unquote
open Xunit

let private meetupId = "0199c0de-0000-7000-8000-0000000000f1"

let private viewerWith (roles: Identity.V1.GlobalRole seq) =
    let viewer = Meetups.V1.Viewer(IdentityId = "0199c0de-0000-7000-8000-000000000001")
    viewer.GlobalRoles.AddRange roles
    viewer

let private administrator () = viewerWith [ Identity.V1.GlobalRole.Admin ]
let private ordinary () = viewerWith []

/// Отказ, а не молчание: заглушка, возвращающая пустоту, оставила бы пропущенную
/// проверку прав зелёным тестом.
let private unreachable name : 'a = failwith $"{name} must not be reached"

/// GetAwaiter().GetResult(), а не Async.RunSynchronously: второй заворачивает отказ
/// в AggregateException, и объявленный RpcException перестал бы ловиться по типу.
let private codeOf (call: unit -> Task<'a>) =
    try
        call().GetAwaiter().GetResult() |> ignore
        None
    with :? RpcException as declined ->
        Some declined.StatusCode

module private Create =

    let deps load commit : CreateMeetupDraft.Deps =
        {
            Load = load
            Commit = commit
            Now = fun () -> Sample.fixedNow
            NewEventId = fun () -> Guid.Parse "0199c0de-0000-7000-8000-0000000000e1"
        }

    let untouched =
        deps (fun _ -> unreachable "Load") (fun _ _ _ -> unreachable "Commit")

    let request viewer = Meetups.V1.CreateMeetupDraftRequest(Viewer = viewer, Id = meetupId)

module private Publish =

    let deps load commit : PublishMeetup.Deps =
        {
            Load = load
            Commit = commit
            Now = fun () -> Sample.fixedNow
            NewEventId = fun () -> Guid.Parse "0199c0de-0000-7000-8000-0000000000e2"
        }

    let untouched =
        deps (fun _ -> unreachable "Load") (fun _ _ _ -> unreachable "Commit")

    let request viewer = Meetups.V1.PublishMeetupRequest(Viewer = viewer, Id = meetupId)

[<Fact>]
let ``A request without a viewer is refused as INVALID_ARGUMENT before the store`` () =
    let request = Meetups.V1.CreateMeetupDraftRequest(Id = meetupId)

    test
        <@ codeOf (fun () -> CreateMeetupDraft.Api.handle Create.untouched request) = Some StatusCode.InvalidArgument @>

/// Заголовочный критерий задачи, и Deps здесь падают на любом обращении: зелёный
/// тест доказывает не только код, но и то, что до хранилища вызов не дошёл.
[<Fact>]
let ``An ordinary viewer is refused as PERMISSION_DENIED before the store`` () =
    let actual =
        codeOf (fun () -> CreateMeetupDraft.Api.handle Create.untouched (Create.request (ordinary ())))

    test <@ actual = Some StatusCode.PermissionDenied @>

[<Fact>]
let ``Publishing is refused for an ordinary viewer before the store`` () =
    let actual =
        codeOf (fun () -> PublishMeetup.Api.handle Publish.untouched (Publish.request (ordinary ())))

    test <@ actual = Some StatusCode.PermissionDenied @>

/// Чужой черновик отвечает как несуществующий: ответ не должен подтверждать, что
/// он существует (ADR-022, ADR-031).
[<Fact>]
let ``A draft of another author answers exactly as a missing one`` () =
    let foreign =
        Meetup.apply Initial (MeetupCreated(Sample.meetupId, Sample.otherAuthorId))
        |> Meetup.toSnapshot

    let deniedByOwner =
        Create.deps (fun _ -> Task.FromResult(Some foreign)) (fun _ _ _ -> unreachable "Commit")

    let missing =
        Publish.deps (fun _ -> Task.FromResult None) (fun _ _ _ -> unreachable "Commit")

    let foreignDraft =
        codeOf (fun () -> CreateMeetupDraft.Api.handle deniedByOwner (Create.request (administrator ())))

    let missingMeetup =
        codeOf (fun () -> PublishMeetup.Api.handle missing (Publish.request (administrator ())))

    test
        <@
            foreignDraft = Some StatusCode.NotFound
            && missingMeetup = foreignDraft
        @>

/// Запрос собран верно, но домен не позволяет переход: FAILED_PRECONDITION, а не
/// INVALID_ARGUMENT. Разделение принято в integration.md.
[<Fact>]
let ``Publishing without a title is refused as FAILED_PRECONDITION`` () =
    let titleless =
        Publish.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.draft)))
            (fun _ _ _ -> unreachable "Commit")

    let actual =
        codeOf (fun () -> PublishMeetup.Api.handle titleless (Publish.request (administrator ())))

    test <@ actual = Some StatusCode.FailedPrecondition @>

/// ABORTED — реализационный выбор PER-56, контрактную строку закрепляет PER-78.
[<Fact>]
let ``A version conflict is refused as ABORTED`` () =
    let conflicting =
        Publish.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.titled)))
            (fun _ _ _ -> Task.FromResult(Error MeetupStore.VersionConflict))

    let actual =
        codeOf (fun () -> PublishMeetup.Api.handle conflicting (Publish.request (administrator ())))

    test <@ actual = Some StatusCode.Aborted @>

/// Сам критерий приёмки, а не три литерала: отсутствие права, нарушенный инвариант
/// и конфликт версии обязаны различаться кодом.
[<Fact>]
let ``Permission, invariant and version conflict are told apart by code`` () =
    let forbidden =
        codeOf (fun () -> PublishMeetup.Api.handle Publish.untouched (Publish.request (ordinary ())))

    let invariant =
        let titleless =
            Publish.deps
                (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.draft)))
                (fun _ _ _ -> unreachable "Commit")

        codeOf (fun () -> PublishMeetup.Api.handle titleless (Publish.request (administrator ())))

    let conflict =
        let conflicting =
            Publish.deps
                (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.titled)))
                (fun _ _ _ -> Task.FromResult(Error MeetupStore.VersionConflict))

        codeOf (fun () -> PublishMeetup.Api.handle conflicting (Publish.request (administrator ())))

    let codes = [ forbidden; invariant; conflict ]

    test
        <@
            List.distinct codes = codes
            && List.forall Option.isSome codes
        @>

[<Fact>]
let ``A successful publication answers with the rendered snapshot`` () =
    let deps =
        Publish.deps
            (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.titled)))
            (fun _ _ _ -> Task.FromResult(Ok(Meetup.toSnapshot Sample.published)))

    let answer =
        (PublishMeetup.Api.handle deps (Publish.request (administrator ()))).GetAwaiter().GetResult()

    test
        <@
            answer.Id = meetupId
            && answer.Visibility = Meetups.V1.MeetupVisibility.Visible
            && answer.HasFirstPublishedAt
        @>
