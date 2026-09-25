module Meetups.SliceTests.CheckMeetupAuthorityTests

open System.Threading.Tasks
open Grpc.Core
open Meetups.Domain
open Meetups.Slices.CheckMeetupAuthority
open Meetups.TestData
open Meetups.TestRpc
open Swensen.Unquote
open Xunit

let private run load viewer =
    execute
        load
        {
            Id = Sample.meetupId
            Viewer = viewer
        }
    |> Async.AwaitTask
    |> Async.RunSynchronously

let private stored = Some(Meetup.toSnapshot Sample.published)

[<Fact>]
let ``An administrator may act on behalf of an existing meetup`` () =
    let calls = ResizeArray<MeetupId>()

    let load id =
        calls.Add id
        Task.FromResult stored

    let result = run load Sample.administrator

    test
        <@
            result = Ok()
            && calls |> List.ofSeq = [ Sample.meetupId ]
        @>

/// ADR-031: организатор сходки в MVP — администратор, который её завёл. Автор без
/// роли администратора права не получает, как и в пишущих командах. Загружается
/// именно его сходка: правило «автор — да», сверенное после чтения, этот тест
/// уронит.
[<Fact>]
let ``The author without the administrator role is refused as the commands refuse the author`` () =
    let own = Meetup.toSnapshot Sample.draft
    let result = run (fun _ -> Task.FromResult(Some own)) Sample.ordinary

    test
        <@
            own.Author = Sample.ordinary.IdentityId
            && result = Error(CheckMeetupAuthorityError.Forbidden NotAnAdministrator)
        @>

/// Вопрос только о праве: состояние сходки в нём не участвует, и отменённая
/// сходка право не отнимает. Можно ли что-то делать с отменённой, решает сценарий
/// вызывающей стороны или команда, а не эта проверка.
[<Fact>]
let ``The right does not depend on the lifecycle of the meetup`` () =
    let result =
        run (fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.cancelled))) Sample.administrator

    test <@ result = Ok() @>

/// Неразличимость для постороннего проверяется не сравнением ответов, а тем, что
/// загрузки нет вовсе: одинаковый путь исполнения одинаков и по времени.
[<Fact>]
let ``A viewer without the right is refused before the meetup is read`` () =
    let mutable loads = 0

    let load _ =
        loads <- loads + 1
        Task.FromResult stored

    let result = run load Sample.ordinary

    test
        <@
            result = Error(CheckMeetupAuthorityError.Forbidden NotAnAdministrator)
            && loads = 0
        @>

[<Fact>]
let ``An administrator learns that the meetup does not exist`` () =
    let result = run (fun _ -> Task.FromResult None) Sample.administrator

    test <@ result = Error CheckMeetupAuthorityError.NotFound @>

let private request () =
    Meetups.V1.CheckMeetupAuthorityRequest(
        Viewer = Meetups.V1.Viewer(IdentityId = "0199c0de-0000-7000-8000-000000000001"),
        Id = "0199c0de-0000-7000-8000-0000000000f1"
    )

let private statusOf (load: MeetupId -> Task<MeetupSnapshot option>) (request: Meetups.V1.CheckMeetupAuthorityRequest) =
    try
        (Api.handle load request).GetAwaiter().GetResult()
        |> ignore

        None
    with :? RpcException as declined ->
        Some declined.Status

[<Fact>]
let ``The check API gives an outsider one answer for an existing and a missing meetup`` () =
    let existing = statusOf (fun _ -> Task.FromResult stored) (request ())
    let missing = statusOf (fun _ -> Task.FromResult None) (request ())

    test
        <@
            existing = missing
            && existing = Some(Status(StatusCode.PermissionDenied, "an administrator role is required"))
        @>

[<Fact>]
let ``The check API maps a missing meetup to NOT_FOUND for an administrator`` () =
    let administrator = request ()
    administrator.Viewer.GlobalRoles.Add Identity.V1.GlobalRole.Admin

    let code =
        codeOf (fun () -> Api.handle (fun _ -> Task.FromResult None) administrator)

    test <@ code = Some StatusCode.NotFound @>

[<Fact>]
let ``The check API grants an administrator with an empty answer`` () =
    let administrator = request ()
    administrator.Viewer.GlobalRoles.Add Identity.V1.GlobalRole.Admin

    let code =
        codeOf (fun () -> Api.handle (fun _ -> Task.FromResult stored) administrator)

    test <@ code = None @>

[<Fact>]
let ``The check API refuses a malformed id before deciding the right`` () =
    let malformed = request ()
    malformed.Id <- "not-a-uuid"

    let code = codeOf (fun () -> Api.handle (fun _ -> Task.FromResult stored) malformed)

    test <@ code = Some StatusCode.InvalidArgument @>
