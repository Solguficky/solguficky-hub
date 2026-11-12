/// Состав организаторов за пределами домена: право организатора в
/// `CheckMeetupAuthority`, хранение состава (строка, тело события, старые записи),
/// проводные поводы и создание участником (ADR-076).
module Meetups.SliceTests.OrganizerPersistenceAndAuthorityTests

open System
open System.Text.Json.Nodes
open System.Threading.Tasks
open Swensen.Unquote
open Xunit
open Meetups
open Meetups.Domain
open Meetups.Infrastructure
open Meetups.Slices
open Meetups.Slices.DispatchMeetupEvents
open Meetups.TestData
open Meetups.Transport.NatsEventPublisher

// ---- CheckMeetupAuthority: отношение «организатор» ------------------------------

type private Identity(grant: AccessRight -> bool) =
    let asked = ResizeArray<PersonId * AccessRight>()

    member _.Asked = List.ofSeq asked

    member _.Ask: CheckMeetupAuthority.AskRight =
        fun person right ->
            asked.Add(person, right)
            Task.FromResult(Ok(grant right))

type private Store(found: MeetupSnapshot option) =
    let loads = ResizeArray<MeetupId>()

    member _.Loads = List.ofSeq loads

    member _.Load: MeetupId -> Task<MeetupSnapshot option> =
        fun id ->
            loads.Add id
            Task.FromResult found

let private check (person: PersonId) (accepted: Set<MeetupRelation>) (identity: Identity) (store: Store) =
    CheckMeetupAuthority.execute
        {
            AskRight = Some identity.Ask
            Load = store.Load
        }
        {
            Id = Sample.meetupId
            Person = person
            Accepted = accepted
        }
    |> Async.AwaitTask
    |> Async.RunSynchronously

let private organizerOnly = Set.singleton Organizer

[<Fact>]
let ``A person in the roster who holds the right is an organizer`` () =
    let identity = Identity(fun right -> right = OrganizeMeetups)
    let store = Store(Some(Meetup.toSnapshot Sample.draft))

    let result = check Sample.authorId organizerOnly identity store

    test <@ result = Ok(Meetup.toSnapshot Sample.draft) @>
    test <@ identity.Asked = [ Sample.authorId, OrganizeMeetups ] @>

/// Состав без права власти не даёт: организатор, потерявший `organize_meetups`.
[<Fact>]
let ``A roster member who lost the right is refused`` () =
    let identity = Identity(fun _ -> false)
    let store = Store(Some(Meetup.toSnapshot Sample.draft))

    test
        <@
            check Sample.authorId organizerOnly identity store = Error
                CheckMeetupAuthority.CheckMeetupAuthorityError.Forbidden
        @>

[<Fact>]
let ``A right holder outside the roster is refused without asking Identity again`` () =
    let identity = Identity(fun _ -> true)
    let store = Store(Some(Meetup.toSnapshot Sample.draft))

    let result = check Sample.otherAuthorId organizerOnly identity store

    test <@ result = Error CheckMeetupAuthority.CheckMeetupAuthorityError.Forbidden @>
    test <@ identity.Asked = [] @>

/// Чужая и отсутствующая сходка: один отказ и одна последовательность запросов.
[<Fact>]
let ``A foreign and a missing meetup give the same refusal and requests`` () =
    let accepted = Set.ofList [ CommunityAdministrator; Organizer ]

    let foreignIdentity = Identity(fun _ -> false)
    let foreignStore = Store(Some(Meetup.toSnapshot Sample.draft))
    let missingIdentity = Identity(fun _ -> false)
    let missingStore = Store None

    let foreign = check Sample.otherAuthorId accepted foreignIdentity foreignStore
    let missing = check Sample.otherAuthorId accepted missingIdentity missingStore

    test <@ foreign = missing @>
    test <@ foreign = Error CheckMeetupAuthority.CheckMeetupAuthorityError.Forbidden @>
    test <@ foreignIdentity.Asked = missingIdentity.Asked @>
    test <@ foreignStore.Loads = missingStore.Loads @>

/// Порядок отношений в запросе ответа не меняет: администратор находит сходку, а
/// отсутствующей отвечает «нет сходки», как и когда принимается одно его отношение.
[<Fact>]
let ``The organizer relation does not hide a missing meetup from an administrator`` () =
    let identity = Identity(fun right -> right = ManageMeetups)

    let result =
        check Sample.authorId (Set.ofList [ CommunityAdministrator; Organizer ]) identity (Store None)

    test <@ result = Error CheckMeetupAuthority.CheckMeetupAuthorityError.NotFound @>

// ---- Создание участником ----------------------------------------------------------

[<Fact>]
let ``A participant with organize_meetups creates a meetup and becomes its first organizer`` () =
    let written = ResizeArray()

    let deps: CreateMeetupDraft.Deps =
        {
            Load = fun _ -> Task.FromResult None
            Commit =
                fun _ _ state event ->
                    written.Add event

                    Meetup.apply state event
                    |> Meetup.toSnapshot
                    |> Ok
                    |> Task.FromResult
            Now = fun () -> Sample.fixedNow
            NewEventId = fun () -> Guid.Parse "0199c0de-0000-7000-8000-00000000e004"
            RequestId = None
        }

    let result =
        CreateMeetupDraft.execute
            deps
            {
                Id = Sample.meetupId
                Viewer = Sample.authorOrganizer
            }
        |> Async.AwaitTask
        |> Async.RunSynchronously

    match result with
    | Ok snapshot ->
        test
            <@
                snapshot.Organizers = [ Sample.authorId ]
                && snapshot.Author = Sample.authorId
            @>
    | Error error -> failwith $"unexpected {error}"

    test <@ written.Count = 1 @>

[<Fact>]
let ``A viewer without organize_meetups and manage_meetups cannot create a meetup`` () =
    let deps: CreateMeetupDraft.Deps =
        {
            Load = fun _ -> failwith "Load is not expected in this test"
            Commit = fun _ _ _ _ -> failwith "Commit is not expected in this test"
            Now = fun () -> Sample.fixedNow
            NewEventId = fun () -> Guid.NewGuid()
            RequestId = None
        }

    let result =
        CreateMeetupDraft.execute
            deps
            {
                Id = Sample.meetupId
                Viewer = Sample.ordinary
            }
        |> Async.AwaitTask
        |> Async.RunSynchronously

    test <@ result = Error(CreateMeetupDraft.CreateMeetupDraftError.Forbidden CannotActOnMeetup) @>

// ---- Хранение состава -------------------------------------------------------------

[<Fact>]
let ``The roster round-trips through the row in order`` () =
    let snapshot = Meetup.toSnapshot Sample.withCoOrganizer
    let row = MeetupRow.ofSnapshot snapshot

    test <@ row.Organizers.Length = 2 @>
    test <@ MeetupRow.toSnapshot row = snapshot @>

[<Fact>]
let ``An emptied roster stays empty through the row`` () =
    let emptied =
        { Meetup.toSnapshot Sample.draft with
            Organizers = []
        }

    test <@ (MeetupRow.toSnapshot (MeetupRow.ofSnapshot emptied)).Organizers = [] @>

[<Fact>]
let ``The payload carries the roster as an array and reads it back`` () =
    let snapshot = Meetup.toSnapshot Sample.withCoOrganizer
    let payload = MeetupEventPayload.ofSnapshot snapshot
    let node = JsonNode.Parse payload :?> JsonObject
    let organizers = node["organizers"] :?> JsonArray

    test <@ organizers.Count = 2 @>
    test <@ MeetupEventPayload.toSnapshot (Guid.NewGuid()) payload = snapshot @>

/// Запись журнала, сделанная до состава, читается как состав из автора: так же её
/// заполняет миграция схемы, и журнал неизменяем.
[<Fact>]
let ``A payload written before the roster existed reads as the author alone`` () =
    let payload = MeetupEventPayload.ofSnapshot (Meetup.toSnapshot Sample.draft)
    let node = JsonNode.Parse payload :?> JsonObject
    node.Remove "organizers" |> ignore

    let snapshot = MeetupEventPayload.toSnapshot (Guid.NewGuid()) (node.ToJsonString())

    test <@ snapshot.Organizers = [ Sample.authorId ] @>

[<Fact>]
let ``An organizers key that is not an array is rejected`` () =
    let payload = MeetupEventPayload.ofSnapshot (Meetup.toSnapshot Sample.draft)
    let node = JsonNode.Parse payload :?> JsonObject
    node["organizers"] <- JsonValue.Create "nobody"

    raisesWith<Exception>
        <@ MeetupEventPayload.toSnapshot (Guid.NewGuid()) (node.ToJsonString()) @>
        (fun error -> <@ error.Message.Contains "organizers is not an array" @>)

[<Fact>]
let ``Only the roster occasions carry a person id`` () =
    let appointed = MeetupOrganizerAppointed Sample.coOrganizerId
    let dismissed = MeetupOrganizerDismissed Sample.coOrganizerId
    let (PersonId person) = Sample.coOrganizerId

    test
        <@
            MeetupEventPayload.eventType appointed = "meetup_organizer_appointed"
            && MeetupEventPayload.eventType dismissed = "meetup_organizer_dismissed"
            && MeetupEventPayload.personId appointed = Nullable person
            && MeetupEventPayload.personId dismissed = Nullable person
            && MeetupEventPayload.personId MeetupHeld = Nullable<Guid>()
            && MeetupEventPayload.materialId appointed = Nullable<Guid>()
        @>

// ---- Провод ------------------------------------------------------------------------

let private pending (eventType: string) (meetup: Meetup) (person: Guid option) : PendingEvent =
    let snapshot = Meetup.toSnapshot meetup
    let (MeetupId meetupId) = snapshot.Id

    {
        EventId = Guid.Parse "0199c0de-0000-7000-8000-0000000000e9"
        MeetupId = meetupId
        Version = snapshot.Version
        EventType = eventType
        Payload = MeetupEventPayload.ofSnapshot snapshot
        PerformedBy = Guid.Parse "0199c0de-0000-7000-8000-000000000001"
        OccurredAt = DateTimeOffset(2026, 9, 7, 18, 30, 0, TimeSpan.Zero)
        RequestId = None
        MaterialId = None
        PersonId = person
    }

[<Fact>]
let ``Organizer occasions become their own branches carrying the person and the roster`` () =
    let (PersonId person) = Sample.coOrganizerId
    let (PersonId author) = Sample.authorId
    let authorText = author.ToString "D"
    let personText = person.ToString "D"

    let appointed =
        Envelope.ofPending (pending "meetup_organizer_appointed" Sample.withCoOrganizer (Some person))

    let dismissed =
        Envelope.ofPending (pending "meetup_organizer_dismissed" Sample.draft (Some person))

    test
        <@
            appointed.OccasionCase = Meetups.V1.MeetupEvent.OccasionOneofCase.MeetupOrganizerAppointed
            && appointed.MeetupOrganizerAppointed.IdentityId = personText
            && List.ofSeq appointed.State.Organizers = [ authorText; personText ]
            && dismissed.OccasionCase = Meetups.V1.MeetupEvent.OccasionOneofCase.MeetupOrganizerDismissed
            && dismissed.MeetupOrganizerDismissed.IdentityId = personText
        @>

[<Fact>]
let ``A roster occasion without a person id is a defect of the journal`` () =
    raisesWith<Exception>
        <@ Envelope.ofPending (pending "meetup_organizer_appointed" Sample.withCoOrganizer None) @>
        (fun error -> <@ error.Message.Contains "person_id" @>)

[<Fact>]
let ``The snapshot on the wire carries the roster in order of joining`` () =
    let wire = Contract.Outbound.snapshot (Meetup.toSnapshot Sample.withCoOrganizer)
    let (PersonId author) = Sample.authorId
    let (PersonId other) = Sample.coOrganizerId

    let expected =
        [
            author.ToString "D"
            other.ToString "D"
        ]

    test <@ List.ofSeq wire.Organizers = expected @>

[<Fact>]
let ``The organizer relation is accepted from the wire`` () =
    let parsed =
        Contract.Inbound.acceptedRelations
            [
                Meetups.V1.MeetupRelation.CommunityAdministrator
                Meetups.V1.MeetupRelation.Organizer
            ]

    test <@ parsed = Ok(Set.ofList [ CommunityAdministrator; Organizer ]) @>
