namespace Meetups.IntegrationTests.Scenarios

open System
open Grpc.Core
open Meetups.IntegrationTests.Infrastructure
open Meetups.V1
open Swensen.Unquote
open Xunit

/// The negative half of the first slice, exercised through the real gRPC and
/// PostgreSQL boundaries. Keeping the scenarios together makes the contract
/// inventory below the guard against a newly introduced read bypass.
type HiddenMeetupReadTests() =

    let administrator () =
        let viewer = Viewer(IdentityId = "0199c0de-0000-7000-8000-00000000000a")
        viewer.GlobalRoles.Add Identity.V1.GlobalRole.Admin
        viewer

    let ordinary () = Viewer(IdentityId = "0199c0de-0000-7000-8000-00000000000c")

    let createDraft (client: MeetupsService.MeetupsServiceClient) =
        let key = (Guid.CreateVersion7()).ToString "D"

        let draft =
            client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = administrator (), Id = key))

        key, draft.Version

    let notFound (action: unit -> unit) = Rpc.codeOf action

    [<Fact>]
    member _.``Every contract read operation has a hidden-meetup scenario``() =
        let writeOperations =
            set
                [
                    "CreateMeetupDraft"
                    "ChangeMeetupAttributes"
                    "SetMeetupSchedule"
                    "PublishMeetup"
                    "ScheduleMeetupPublication"
                    "CancelMeetupPublication"
                    "UnpublishMeetup"
                    "CancelMeetup"
                    "AttachMaterial"
                    "RemoveMaterial"
                    "MarkMeetupHeld"
                ]

        let contractReadOperations =
            MeetupsService.Descriptor.Methods
            |> Seq.map _.Name
            |> Seq.filter (writeOperations.Contains >> not)
            |> Set.ofSeq

        let operationsCoveredByThisSuite =
            set
                [
                    "ListVisibleMeetups"
                    "ListArchivedMeetups"
                    "GetMeetup"
                    "ListMeetupStates"
                    "CheckMeetupAuthority"
                ]

        test <@ contractReadOperations = operationsCoveredByThisSuite @>

    [<Fact>]
    member _.``The list does not expose a hidden meetup to an ordinary viewer``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let hiddenId, _ = createDraft client

        let returnedIds =
            client.ListVisibleMeetups(ListVisibleMeetupsRequest(Viewer = ordinary ())).Meetups
            |> Seq.map _.Id
            |> Set.ofSeq

        test <@ not (returnedIds.Contains hiddenId) @>

    /// Материалы наследуют видимость сходки: скрытая сходка не отдаёт их обычному
    /// смотрящему ни через карточку, ни через прямую ссылку, а администратору они
    /// приходят вместе с ней. Правило держится общим путём чтения, а не отдельной
    /// проверкой материалов.
    [<Fact>]
    member _.``Materials of a hidden meetup follow the visibility of the meetup``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let hiddenId, hiddenVersion = createDraft client

        client.AttachMaterial(
            AttachMaterialRequest(
                Viewer = administrator (),
                Id = hiddenId,
                MaterialId = (Guid.CreateVersion7()).ToString "D",
                Title = "Афиша",
                Source = MeetupMaterialSource(FileId = "file-1"),
                ExpectedVersion = hiddenVersion
            )
        )
        |> ignore

        let refused =
            notFound (fun () ->
                client.GetMeetup(GetMeetupRequest(Viewer = ordinary (), Id = hiddenId))
                |> ignore
            )

        let visibleToAdministrator =
            client.GetMeetup(GetMeetupRequest(Viewer = administrator (), Id = hiddenId)).Materials
            |> Seq.map _.Title
            |> List.ofSeq

        test <@ refused = Some StatusCode.NotFound @>
        test <@ visibleToAdministrator = [ "Афиша" ] @>

    /// Архив — новое человеческое чтение, и правило видимости у него то же: сходка не
    /// становится видимой оттого, что попала в архив. Скрытую состоявшуюся видит её
    /// автор и администратор — здесь автор и есть администратор, поэтому её
    /// отсутствие у обычного смотрящего и присутствие у администратора — оба ответа.
    [<Fact>]
    member _.``The archive does not expose a hidden meetup to an ordinary viewer``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let hiddenId, hiddenVersion = createDraft client

        client.MarkMeetupHeld(
            MarkMeetupHeldRequest(Viewer = administrator (), Id = hiddenId, ExpectedVersion = hiddenVersion)
        )
        |> ignore

        let ordinaryIds =
            client.ListArchivedMeetups(ListArchivedMeetupsRequest(Viewer = ordinary ())).Meetups
            |> Seq.map _.Id
            |> Set.ofSeq

        let administrativeIds =
            client.ListArchivedMeetups(ListArchivedMeetupsRequest(Viewer = administrator ())).Meetups
            |> Seq.map _.Id
            |> Set.ofSeq

        test
            <@
                not (ordinaryIds.Contains hiddenId)
                && administrativeIds.Contains hiddenId
            @>

    [<Fact>]
    member _.``Reading by identifier does not expose a hidden meetup to an ordinary viewer``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let hiddenId, _ = createDraft client

        let actual =
            notFound (fun () ->
                client.GetMeetup(GetMeetupRequest(Viewer = ordinary (), Id = hiddenId))
                |> ignore
            )

        let denial =
            live.Records
            |> List.tryFind (fun entry -> entry.Fields.TryFind "denial_reason" = Some "not_visible")

        test <@ actual = Some StatusCode.NotFound && denial.IsSome @>

    [<Fact>]
    member _.``A direct-link lookup answers like a lookup of a missing meetup``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let hiddenId, _ = createDraft client

        let lookup meetupId =
            try
                // A Telegram deep link is resolved to this same GetMeetup call.
                client.GetMeetup(GetMeetupRequest(Viewer = ordinary (), Id = meetupId))
                |> ignore

                None
            with :? RpcException as refused ->
                Some refused.Status

        let hidden = lookup hiddenId
        let missing = lookup ((Guid.CreateVersion7()).ToString "D")

        test
            <@
                hidden = missing
                && missing = Some(Status(StatusCode.NotFound, "meetup not found"))
            @>

    /// Служебное перечисление — единственное чтение контракта, которое скрытую
    /// сходку возвращает. Сценарий здесь, а не исключение из инвентаря выше:
    /// обход мимо правил видимости обязан быть записан утверждением, иначе он
    /// неотличим от дыры, которую этот набор и сторожит.
    [<Fact>]
    member _.``The service enumeration returns a hidden meetup by design``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let hiddenId, _ = createDraft client

        let returnedIds =
            client.ListMeetupStates(ListMeetupStatesRequest()).Meetups
            |> Seq.map _.Id
            |> Set.ofSeq

        test <@ returnedIds.Contains hiddenId @>

    /// Проверка права — тоже вопрос о сходке, и ответ на него не должен выдавать
    /// скрытую: посторонний получает один и тот же отказ для скрытой и отсутствующей,
    /// а администратор — право и на свою, и на заведённую другим (PER-224).
    [<Fact>]
    member _.``The authority check neither exposes a hidden meetup nor withholds it from administrators``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let hiddenId, _ = createDraft client
        let missingId = (Guid.CreateVersion7()).ToString "D"

        let anotherAdministrator =
            Viewer(IdentityId = "0199c0de-0000-7000-8000-00000000000d")

        anotherAdministrator.GlobalRoles.Add Identity.V1.GlobalRole.Admin

        let check viewer meetupId =
            try
                client.CheckMeetupAuthority(CheckMeetupAuthorityRequest(Viewer = viewer, Id = meetupId))
                |> ignore

                None
            with :? RpcException as refused ->
                Some refused.Status

        let outsiderOnHidden = check (ordinary ()) hiddenId
        let outsiderOnMissing = check (ordinary ()) missingId

        test
            <@
                outsiderOnHidden = outsiderOnMissing
                && outsiderOnMissing = Some(Status(StatusCode.PermissionDenied, "an administrator role is required"))
                && check (administrator ()) hiddenId = None
                && check anotherAdministrator hiddenId = None
                && check anotherAdministrator missingId = Some(Status(StatusCode.NotFound, "meetup not found"))
            @>
