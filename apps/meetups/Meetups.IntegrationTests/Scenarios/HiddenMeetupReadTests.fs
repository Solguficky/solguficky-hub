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
        viewer.Rights.Add Identity.V1.AccessRight.ManageMeetups
        viewer

    let ordinary () = Viewer(IdentityId = "0199c0de-0000-7000-8000-00000000000c")

    let createDraft (client: MeetupsService.MeetupsServiceClient) =
        let key = (Guid.CreateVersion7()).ToString "D"

        let draft =
            client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = administrator (), Id = key))

        key, draft.Version

    let notFound (action: unit -> unit) = Rpc.codeOf action

    /// Подменяет порт Identity: «да» только администраторам из набора и только на
    /// право ManageMeetups — так же, как ответил бы Identity на вопрос, который
    /// задаёт Meetups. Адаптер сведения ответов проверен unit-тестами, а здесь
    /// держится путь «граница — срез — база».
    let identityPort (administrators: Set<string>) =
        let ask: Meetups.Slices.CheckMeetupAuthority.AskRight =
            fun (Meetups.Domain.PersonId person) right ->
                Threading.Tasks.Task.FromResult(
                    Ok(
                        administrators.Contains(person.ToString "D")
                        && right = Meetups.Domain.ManageMeetups
                    )
                )

        fun (services: Microsoft.Extensions.DependencyInjection.IServiceCollection) ->
            Microsoft.Extensions.DependencyInjection.ServiceCollectionServiceExtensions.AddSingleton<
                Meetups.Slices.CheckMeetupAuthority.Port
             >(
                services,
                Meetups.Slices.CheckMeetupAuthority.Port.Connected(fun _ -> ask)
            )
            |> ignore

    /// Вопрос проверки отношения так, как его задаёт второй сервис.
    let authorityRequest identityId meetupId =
        let request = CheckMeetupAuthorityRequest(IdentityId = identityId, Id = meetupId)
        request.AcceptedRelations.Add MeetupRelation.CommunityAdministrator
        request

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
                    "GetMeetupStanding"
                ]

        test <@ contractReadOperations = operationsCoveredByThisSuite @>

    [<Fact>]
    member _.``The list does not expose a hidden meetup to an ordinary viewer``() =
        use live = new LiveMeetupsHost()
        let client = AuthenticatedClient.bot live.Channel
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
        let client = AuthenticatedClient.bot live.Channel
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
        let client = AuthenticatedClient.bot live.Channel
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
        let client = AuthenticatedClient.bot live.Channel
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
        let client = AuthenticatedClient.bot live.Channel
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

    /// У служебного перечисления нет объявленного вызывающего (ADR-056):
    /// скрытый снимок не выходит через этот транспорт даже с токеном бота.
    [<Fact>]
    member _.``The service enumeration does not expose a hidden meetup to an undeclared caller``() =
        use live = new LiveMeetupsHost()
        let client = AuthenticatedClient.bot live.Channel
        createDraft client |> ignore

        let refused =
            Rpc.codeOf (fun () ->
                client.ListMeetupStates(ListMeetupStatesRequest())
                |> ignore
            )

        test <@ refused = Some StatusCode.Unauthenticated @>

    /// Состояние сходки — служебное чтение экрана зала Auction: скрытая сходка
    /// приходит ему состоянием, по которому он сам отвечает «не найдено», а
    /// другому вызывающему чтение закрыто ещё на транспорте (ADR-040, дополнение
    /// 2026-10-19).
    [<Fact>]
    member _.``The standing read gives a hidden meetup's state to Auction alone``() =
        use live = new LiveMeetupsHost()
        let client = AuthenticatedClient.bot live.Channel
        let hiddenId, _ = createDraft client

        let standing =
            (AuthenticatedClient.auction live.Channel).GetMeetupStanding(GetMeetupStandingRequest(Id = hiddenId))

        let refused =
            Rpc.codeOf (fun () ->
                client.GetMeetupStanding(GetMeetupStandingRequest(Id = hiddenId))
                |> ignore
            )

        test
            <@
                standing.Visibility = MeetupVisibility.Hidden
                && refused = Some StatusCode.Unauthenticated
            @>

    /// Проверка права — тоже вопрос о сходке, и ответ на него не должен выдавать
    /// скрытую: посторонний получает один и тот же отказ для скрытой и отсутствующей,
    /// а администратор — право и на свою, и на заведённую другим (PER-224).
    [<Fact>]
    member _.``The authority check neither exposes a hidden meetup nor withholds it from administrators``() =
        let administrators =
            set
                [
                    "0199c0de-0000-7000-8000-00000000000a"
                    "0199c0de-0000-7000-8000-00000000000d"
                ]

        use live = new LiveMeetupsHost(identityPort administrators)
        let client = AuthenticatedClient.bot live.Channel
        let authority = AuthenticatedClient.notifications live.Channel
        let hiddenId, _ = createDraft client
        let missingId = (Guid.CreateVersion7()).ToString "D"

        let check (identityId: string) meetupId =
            try
                authority.CheckMeetupAuthority(authorityRequest identityId meetupId)
                |> ignore

                None
            with :? RpcException as refused ->
                Some refused.Status

        let outsider = (ordinary ()).IdentityId
        let author = (administrator ()).IdentityId
        let anotherAdministrator = "0199c0de-0000-7000-8000-00000000000d"
        let outsiderOnHidden = check outsider hiddenId
        let outsiderOnMissing = check outsider missingId

        test
            <@
                outsiderOnHidden = outsiderOnMissing
                && outsiderOnMissing = Some(Status(StatusCode.PermissionDenied, "none of the accepted relations holds"))
                && check author hiddenId = None
                && check anotherAdministrator hiddenId = None
                && check anotherAdministrator missingId = Some(Status(StatusCode.NotFound, "meetup not found"))
            @>

    /// Успех несёт состояние сходки, а не один факт права: отменённая приходит с
    /// жизненным циклом «отменена», скрытая — с видимостью «скрыта» (ADR-047,
    /// дополнение 2026-10-12; критерий PER-600). Путь настоящий — gRPC, срез и база.
    [<Fact>]
    member _.``The authority check carries the state of a cancelled hidden meetup``() =
        let administrators =
            set
                [
                    "0199c0de-0000-7000-8000-00000000000a"
                ]

        use live = new LiveMeetupsHost(identityPort administrators)
        let client = AuthenticatedClient.bot live.Channel
        let authority = AuthenticatedClient.notifications live.Channel
        let hiddenId, version = createDraft client

        client.CancelMeetup(CancelMeetupRequest(Viewer = administrator (), Id = hiddenId, ExpectedVersion = version))
        |> ignore

        let answer =
            authority.CheckMeetupAuthority(authorityRequest (administrator ()).IdentityId hiddenId)

        test
            <@
                answer.Lifecycle = MeetupLifecycle.Cancelled
                && answer.Visibility = MeetupVisibility.Hidden
            @>
