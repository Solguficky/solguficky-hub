namespace Meetups.IntegrationTests.Scenarios

open System
open System.Globalization
open Grpc.Core
open Meetups.IntegrationTests.Infrastructure
open Meetups.V1
open Swensen.Unquote
open Xunit

/// Служебное перечисление через настоящий Kestrel и настоящий PostgreSQL. Курсор,
/// порядок обхода и момент согласованности целиком живут в SQL и в драйвере,
/// поэтому unit-тесты среза их не достают: там читающая функция подменена. Здесь
/// проходит ровно тот путь, которым реплика набирает начальное состояние.
///
/// Хост поднимается в теле теста, а не class fixture: пропуск без Docker должен
/// оставаться пропуском, а не падением класса.
type ListMeetupStatesTests() =

    let administrator () =
        let viewer = Viewer(IdentityId = "0199c0de-0000-7000-8000-00000000000a")
        viewer.GlobalRoles.Add Identity.V1.GlobalRole.Admin
        viewer

    let createDraft (client: MeetupsService.MeetupsServiceClient) =
        let key = (Guid.CreateVersion7()).ToString "D"

        client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = administrator (), Id = key))
        |> ignore

        key

    let page (client: MeetupsService.MeetupsServiceClient) token size =
        client.ListMeetupStates(ListMeetupStatesRequest(PageToken = token, PageSize = size))

    [<Fact>]
    member _.``The enumeration walks every meetup across its pages``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let created = List.init 3 (fun _ -> createDraft client)

        let first = page client "" 2
        let second = page client first.NextPageToken 2

        let walked =
            Seq.append first.Meetups second.Meetups
            |> Seq.map _.Id
            |> Set.ofSeq

        test <@ walked = Set.ofList created @>

    [<Fact>]
    member _.``A page stops at the requested size and hands back a cursor``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        List.init 3 (fun _ -> createDraft client) |> ignore

        let first = page client "" 2

        test
            <@
                first.Meetups.Count = 2
                && first.NextPageToken <> ""
                && first.ConsistentAt <> ""
            @>

    [<Fact>]
    member _.``The last page of the enumeration carries no cursor``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        createDraft client |> ignore

        let only = page client "" 50

        test <@ only.NextPageToken = "" @>

    /// Момент читается скаляром внутри той же транзакции, что и строки, и это
    /// единственное место, где тип колонки встречается с Dapper напрямую.
    [<Fact>]
    member _.``Every page names the UTC moment its snapshot was taken at``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        createDraft client |> ignore

        let moment = (page client "" 50).ConsistentAt
        let parsed = DateTimeOffset.Parse(moment, CultureInfo.InvariantCulture)

        test <@ parsed.Offset = TimeSpan.Zero @>

    /// Перечисление отдаёт полный снимок, а не сводку: реплика восстанавливает
    /// состояние целиком, и версия агрегата нужна ей, чтобы разрешить гонку с
    /// буфером событий.
    [<Fact>]
    member _.``The enumeration returns whole snapshots with their version``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let key = createDraft client

        let only = page client "" 50
        let snapshot = only.Meetups |> Seq.find (fun m -> m.Id = key)

        test
            <@
                snapshot.Version = 1L
                && snapshot.Visibility = MeetupVisibility.Hidden
            @>

    [<Fact>]
    member _.``A cursor the service did not issue is refused``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)

        let walk () = page client "not-a-token" 50 |> ignore
        let refused = Rpc.codeOf walk

        test <@ refused = Some StatusCode.InvalidArgument @>
