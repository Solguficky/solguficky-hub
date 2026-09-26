module Meetups.SliceTests.CheckMeetupAuthorityTests

open System.Threading.Tasks
open Grpc.Core
open Meetups.Domain
open Meetups.Slices.CheckMeetupAuthority
open Meetups.TestData
open Meetups.TestRpc
open Swensen.Unquote
open Xunit

let private stored = Some(Meetup.toSnapshot Sample.published)

/// Порт Identity, который записывает, о ком и о каких ролях его спросили.
type private Identity(answer: Result<bool, IdentityFailure>) =
    let asked = ResizeArray<PersonId * Set<GlobalRole>>()

    member _.Asked = List.ofSeq asked

    member _.Ask: AskRoles =
        fun person roles ->
            asked.Add(person, roles)
            Task.FromResult answer

/// Загрузка, которая считает обращения: «до загрузки» проверяется тем, что их нет.
type private Store(found: MeetupSnapshot option) =
    let loaded = ResizeArray<MeetupId>()

    member _.Loaded = List.ofSeq loaded

    member _.Load: MeetupId -> Task<MeetupSnapshot option> =
        fun id ->
            loaded.Add id
            Task.FromResult found

let private deps (identity: Identity) (store: Store) : Deps =
    {
        AskRoles = Some identity.Ask
        Load = store.Load
    }

let private query: Query =
    {
        Id = Sample.meetupId
        Person = Sample.authorId
        Accepted = Set.singleton CommunityAdministrator
    }

let private run (deps: Deps) =
    execute deps query
    |> Async.AwaitTask
    |> Async.RunSynchronously

[<Fact>]
let ``An administrator may act on behalf of an existing meetup`` () =
    let identity = Identity(Ok true)
    let store = Store stored

    let result = run (deps identity store)

    test
        <@
            result = Ok()
            && store.Loaded = [ Sample.meetupId ]
        @>

/// Отношение «администратор сообщества» спрашивается у Identity ролью Administrator
/// и только ею: вызывающий ролей не приносит, их называет правило Meetups.
[<Fact>]
let ``The community administrator relation is asked of Identity as the administrator role`` () =
    let identity = Identity(Ok true)

    run (deps identity (Store stored)) |> ignore

    test
        <@
            identity.Asked = [
                Sample.authorId, Set.singleton Administrator
            ]
        @>

/// Неразличимость для постороннего проверяется не сравнением ответов, а тем, что
/// загрузки нет вовсе: одинаковый путь исполнения одинаков и по времени.
[<Fact>]
let ``A person without the relation is refused before the meetup is read`` () =
    let store = Store stored

    let result = run (deps (Identity(Ok false)) store)

    test
        <@
            result = Error CheckMeetupAuthorityError.Forbidden
            && store.Loaded = []
        @>

[<Fact>]
let ``An administrator learns that the meetup does not exist`` () =
    let result = run (deps (Identity(Ok true)) (Store None))

    test <@ result = Error CheckMeetupAuthorityError.NotFound @>

/// Вопрос только о праве: состояние сходки в нём не участвует, и отменённая
/// сходка право не отнимает.
[<Fact>]
let ``The right does not depend on the lifecycle of the meetup`` () =
    let result =
        run (deps (Identity(Ok true)) (Store(Some(Meetup.toSnapshot Sample.cancelled))))

    test <@ result = Ok() @>

/// Право, которое не удалось подтвердить, не превращается ни в «нет», ни в «да», и
/// сходка при этом не читается: ответ ещё не заслужен.
[<Fact>]
let ``An unconfirmed right is reported as such and never reads the meetup`` () =
    let store = Store stored

    let unavailable =
        run (deps (Identity(Error(IdentityFailure.Unavailable "identity Unavailable"))) store)

    let failed =
        run (deps (Identity(Error(IdentityFailure.Failed "identity Internal"))) store)

    test
        <@
            unavailable = Error(CheckMeetupAuthorityError.IdentityUnavailable "identity Unavailable")
            && failed = Error(CheckMeetupAuthorityError.IdentityFailed "identity Internal")
            && store.Loaded = []
        @>

/// Сервис, запущенный без адреса Identity, права не знает и так и говорит.
[<Fact>]
let ``Without a configured Identity the right cannot be confirmed`` () =
    let store = Store stored

    let result =
        run
            {
                AskRoles = None
                Load = store.Load
            }

    test
        <@
            result = Error(CheckMeetupAuthorityError.IdentityUnavailable "identity is not configured")
            && store.Loaded = []
        @>

let private request () =
    let request =
        Meetups.V1.CheckMeetupAuthorityRequest(
            IdentityId = "0199c0de-0000-7000-8000-000000000001",
            Id = "0199c0de-0000-7000-8000-0000000000f1"
        )

    request.AcceptedRelations.Add Meetups.V1.MeetupRelation.CommunityAdministrator
    request

let private statusOf (deps: Deps) (request: Meetups.V1.CheckMeetupAuthorityRequest) =
    try
        (Api.handle deps request).GetAwaiter().GetResult()
        |> ignore

        None
    with :? RpcException as declined ->
        Some declined.Status

[<Fact>]
let ``The check API gives an outsider one answer for an existing and a missing meetup`` () =
    let existing = statusOf (deps (Identity(Ok false)) (Store stored)) (request ())
    let missing = statusOf (deps (Identity(Ok false)) (Store None)) (request ())

    test
        <@
            existing = missing
            && existing = Some(Status(StatusCode.PermissionDenied, "none of the accepted relations holds"))
        @>

[<Fact>]
let ``The check API grants an administrator with an empty answer and reports a missing meetup`` () =
    let granted =
        codeOf (fun () -> Api.handle (deps (Identity(Ok true)) (Store stored)) (request ()))

    let missing =
        codeOf (fun () -> Api.handle (deps (Identity(Ok true)) (Store None)) (request ()))

    test
        <@
            granted = None
            && missing = Some StatusCode.NotFound
        @>

/// «Право не подтверждено» отличается от «права нет»: иначе человек услышал бы
/// «у вас нет прав» вместо «попробуйте позже» (ADR-051, п. 6).
[<Fact>]
let ``The check API maps an unconfirmed right to UNAVAILABLE and a broken check to INTERNAL`` () =
    let unavailable =
        codeOf (fun () ->
            Api.handle (deps (Identity(Error(IdentityFailure.Unavailable "down"))) (Store stored)) (request ())
        )

    let failed =
        codeOf (fun () -> Api.handle (deps (Identity(Error(IdentityFailure.Failed "odd"))) (Store stored)) (request ()))

    test
        <@
            unavailable = Some StatusCode.Unavailable
            && failed = Some StatusCode.Internal
        @>

/// Запрос, собранный неверно, отвергается разбором и в Identity не уходит.
[<Theory>]
[<InlineData("empty")>]
[<InlineData("unspecified")>]
[<InlineData("unknown")>]
[<InlineData("identity")>]
[<InlineData("id")>]
let ``The check API refuses a malformed request before asking Identity`` (defect: string) =
    let malformed = request ()

    match defect with
    | "empty" -> malformed.AcceptedRelations.Clear()
    | "unspecified" -> malformed.AcceptedRelations.Add Meetups.V1.MeetupRelation.Unspecified
    | "unknown" -> malformed.AcceptedRelations.Add(enum<Meetups.V1.MeetupRelation> 99)
    | "identity" -> malformed.IdentityId <- "not-a-uuid"
    | _ -> malformed.Id <- "not-a-uuid"

    let identity = Identity(Ok true)

    let code = codeOf (fun () -> Api.handle (deps identity (Store stored)) malformed)

    test
        <@
            code = Some StatusCode.InvalidArgument
            && identity.Asked = []
        @>
