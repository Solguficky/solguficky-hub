/// `ConfirmMeetupContact` (ADR-076, п. 10): подтверждение автора или человека из
/// состава перед ником в карточке. Любое «нет» — один NOT_FOUND, а последовательность
/// запросов у отсутствующей и скрытой от постороннего сходки одна (п. 12).
module Meetups.SliceTests.ConfirmMeetupContactTests

open System.Threading.Tasks
open Grpc.Core
open Meetups.Domain
open Meetups.Slices
open Meetups.Slices.CheckMeetupAuthority
open Meetups.TestData
open Meetups.TestRpc
open Swensen.Unquote
open Xunit

/// Порт Identity, который записывает, о ком и о каком праве его спросили.
type private Identity(answer: AccessRight -> Result<bool, IdentityFailure>) =
    let asked = ResizeArray<PersonId * AccessRight>()

    member _.Asked = List.ofSeq asked

    member _.Ask: AskRight =
        fun person right ->
            asked.Add(person, right)
            Task.FromResult(answer right)

type private Store(found: MeetupSnapshot option) =
    let loads = ResizeArray<MeetupId>()

    member _.Loads = List.ofSeq loads

    member _.Load: MeetupId -> Task<MeetupSnapshot option> =
        fun id ->
            loads.Add id
            Task.FromResult found

let private granting (value: bool) = Identity(fun _ -> Ok value)

let private visible = Meetup.toSnapshot Sample.published

let private visibleWithCoOrganizer =
    Meetup.apply (Existing Sample.published) (MeetupOrganizerAppointed Sample.coOrganizerId)
    |> Meetup.toSnapshot

let private hidden = Meetup.toSnapshot Sample.withCoOrganizer

let private unrelated =
    PersonId(System.Guid.Parse "0199c0de-0000-7000-8000-000000000004")

let private notFound = Error ConfirmMeetupContact.ConfirmMeetupContactError.NotFound

let private confirm (viewer: PersonId) (person: PersonId) (identity: Identity) (store: Store) =
    ConfirmMeetupContact.execute
        {
            AskRight = Some identity.Ask
            Load = store.Load
        }
        {
            Id = Sample.meetupId
            Viewer = viewer
            Person = person
        }
    |> Async.AwaitTask
    |> Async.RunSynchronously

[<Fact>]
let ``The author of a published meetup is confirmed to any viewer without asking Identity`` () =
    let identity = granting false
    let store = Store(Some visible)

    test <@ confirm unrelated Sample.authorId identity store = Ok() @>
    test <@ identity.Asked = [] @>
    test <@ store.Loads = [ Sample.meetupId ] @>

[<Fact>]
let ``A roster member of a published meetup is confirmed`` () =
    let identity = granting false

    test <@ confirm unrelated Sample.coOrganizerId identity (Store(Some visibleWithCoOrganizer)) = Ok() @>
    test <@ identity.Asked = [] @>

[<Fact>]
let ``A person outside the author and the roster is not confirmed`` () =
    test <@ confirm Sample.authorId unrelated (granting true) (Store(Some visibleWithCoOrganizer)) = notFound @>

[<Fact>]
let ``A hidden meetup is confirmed to a roster member or to its author without asking Identity`` () =
    let identity = granting false

    test <@ confirm Sample.coOrganizerId Sample.authorId identity (Store(Some hidden)) = Ok() @>
    test <@ confirm Sample.authorId Sample.coOrganizerId identity (Store(Some hidden)) = Ok() @>
    test <@ identity.Asked = [] @>

[<Fact>]
let ``A hidden meetup is refused to an outside viewer who does not hold manage_meetups`` () =
    let identity = granting false

    let result = confirm unrelated Sample.authorId identity (Store(Some hidden))

    test <@ result = notFound @>
    test <@ identity.Asked = [ unrelated, ManageMeetups ] @>

[<Fact>]
let ``A hidden meetup is confirmed to a holder of manage_meetups`` () =
    let identity = Identity(fun right -> Ok(right = ManageMeetups))

    let result = confirm unrelated Sample.authorId identity (Store(Some hidden))

    test <@ result = Ok() @>
    test <@ identity.Asked = [ unrelated, ManageMeetups ] @>

/// Администратор видит скрытую сходку, но ник отдаётся только автору и составу.
[<Fact>]
let ``An administrator viewer does not confirm a person outside the author and the roster`` () =
    test <@ confirm unrelated unrelated (granting true) (Store(Some hidden)) = notFound @>

[<Fact>]
let ``A hidden foreign meetup and a missing one give the same refusal and requests`` () =
    let foreignIdentity = granting false
    let foreignStore = Store(Some hidden)
    let missingIdentity = granting false
    let missingStore = Store None

    let foreign = confirm unrelated Sample.authorId foreignIdentity foreignStore
    let missing = confirm unrelated Sample.authorId missingIdentity missingStore

    test <@ foreign = missing @>
    test <@ foreign = notFound @>
    test <@ foreignIdentity.Asked = missingIdentity.Asked @>
    test <@ foreignStore.Loads = missingStore.Loads @>

/// Администратору существование не тайна, но ответ на «сходки нет» всё равно один.
[<Fact>]
let ``A missing meetup is refused even to a holder of manage_meetups`` () =
    test <@ confirm unrelated Sample.authorId (granting true) (Store None) = notFound @>

/// Неизвестный Identity смотрящий сводится адаптером к «права нет» и даёт тот же NOT_FOUND.
[<Fact>]
let ``A viewer unknown to Identity gets the same NOT_FOUND`` () =
    test <@ confirm unrelated Sample.authorId (granting false) (Store(Some hidden)) = notFound @>

[<Fact>]
let ``An unconfirmed right is not read as no right`` () =
    let unavailable = Identity(fun _ -> Error(IdentityFailure.Unavailable "down"))
    let failed = Identity(fun _ -> Error(IdentityFailure.Failed "odd"))

    test
        <@
            confirm unrelated Sample.authorId unavailable (Store(Some hidden)) = Error(
                ConfirmMeetupContact.ConfirmMeetupContactError.IdentityUnavailable "down"
            )
        @>

    test
        <@
            confirm unrelated Sample.authorId failed (Store None) = Error(
                ConfirmMeetupContact.ConfirmMeetupContactError.IdentityFailed "odd"
            )
        @>

[<Fact>]
let ``Without a source of rights a meetup that needs one is UNAVAILABLE`` () =
    let result =
        ConfirmMeetupContact.execute
            {
                AskRight = None
                Load = (Store(Some hidden)).Load
            }
            {
                Id = Sample.meetupId
                Viewer = unrelated
                Person = Sample.authorId
            }
        |> Async.AwaitTask
        |> Async.RunSynchronously

    test
        <@
            result = Error(
                ConfirmMeetupContact.ConfirmMeetupContactError.IdentityUnavailable "identity is not configured"
            )
        @>

let private request viewer person id =
    Meetups.V1.ConfirmMeetupContactRequest(Id = id, ViewerIdentityId = viewer, IdentityId = person)

let private deps (identity: Identity) (store: Store) : Deps =
    {
        AskRight = Some identity.Ask
        Load = store.Load
    }

[<Fact>]
let ``The API maps every refusal to one status and the success to an empty answer`` () =
    let author = "0199c0de-0000-7000-8000-000000000001"
    let viewer = "0199c0de-0000-7000-8000-000000000004"
    let id = "0199c0de-0000-7000-8000-0000000000f1"

    let call identity store =
        codeOf (fun () -> ConfirmMeetupContact.Api.handle (deps identity store) (request viewer author id))

    let confirmed = call (granting false) (Store(Some visible))
    let hiddenCode = call (granting false) (Store(Some hidden))
    let missingCode = call (granting false) (Store None)

    let unavailable =
        call (Identity(fun _ -> Error(IdentityFailure.Unavailable "down"))) (Store None)

    let failed =
        call (Identity(fun _ -> Error(IdentityFailure.Failed "odd"))) (Store None)

    test
        <@
            confirmed = None
            && hiddenCode = Some StatusCode.NotFound
            && missingCode = Some StatusCode.NotFound
            && unavailable = Some StatusCode.Unavailable
            && failed = Some StatusCode.Internal
        @>

/// Запрос, собранный неверно, отвергается разбором: ни в Identity, ни в базу он не идёт.
[<Theory>]
[<InlineData("", "0199c0de-0000-7000-8000-000000000001", "0199c0de-0000-7000-8000-0000000000f1")>]
[<InlineData("0199C0DE-0000-7000-8000-000000000004",
             "0199c0de-0000-7000-8000-000000000001",
             "0199c0de-0000-7000-8000-0000000000f1")>]
[<InlineData("0199c0de-0000-7000-8000-000000000004", "not-a-uuid", "0199c0de-0000-7000-8000-0000000000f1")>]
[<InlineData("0199c0de-0000-7000-8000-000000000004", "0199c0de-0000-7000-8000-000000000001", "")>]
let ``A malformed request is INVALID_ARGUMENT before any I/O`` (viewer: string, person: string, id: string) =
    let identity = granting true
    let store = Store(Some hidden)

    let code =
        codeOf (fun () -> ConfirmMeetupContact.Api.handle (deps identity store) (request viewer person id))

    test <@ code = Some StatusCode.InvalidArgument @>
    test <@ identity.Asked = [] && store.Loads = [] @>
