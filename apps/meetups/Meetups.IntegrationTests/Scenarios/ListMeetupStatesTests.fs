namespace Meetups.IntegrationTests.Scenarios

open System
open System.Globalization
open Grpc.Core
open Meetups.IntegrationTests.Infrastructure
open Meetups.V1
open Swensen.Unquote
open Xunit

/// Служебное перечисление через срез и настоящий PostgreSQL. Курсор,
/// порядок обхода и момент согласованности целиком живут в SQL и в драйвере,
/// поэтому unit-тесты среза их не достают: там читающая функция подменена. Здесь
/// проверяется будущий путь реплики ниже gRPC-границы: по ADR-056 у RPC пока
/// нет объявленного вызывающего, и транспорт отказывает всем.
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

    let page (live: LiveMeetupsHost) token size =
        Meetups.Slices.ListMeetupStates.Api.handle
            live.ReadStates
            (ListMeetupStatesRequest(PageToken = token, PageSize = size))
        |> fun pending -> pending.GetAwaiter().GetResult()

    [<Fact>]
    member _.``The enumeration walks every meetup across its pages``() =
        use live = new LiveMeetupsHost()
        let client = AuthenticatedClient.bot live.Channel
        let created = List.init 3 (fun _ -> createDraft client)

        let first = page live "" 2
        let second = page live first.NextPageToken 2

        let walked =
            Seq.append first.Meetups second.Meetups
            |> Seq.map _.Id
            |> Set.ofSeq

        test <@ walked = Set.ofList created @>

    [<Fact>]
    member _.``A page stops at the requested size and hands back a cursor``() =
        use live = new LiveMeetupsHost()
        let client = AuthenticatedClient.bot live.Channel

        List.init 3 (fun _ -> createDraft client)
        |> ignore

        let first = page live "" 2

        test
            <@
                first.Meetups.Count = 2
                && first.NextPageToken <> ""
                && first.ConsistentAt <> ""
            @>

    [<Fact>]
    member _.``The last page of the enumeration carries no cursor``() =
        use live = new LiveMeetupsHost()
        let client = AuthenticatedClient.bot live.Channel
        createDraft client |> ignore

        let only = page live "" 50

        test <@ only.NextPageToken = "" @>

    /// Момент читается скаляром внутри той же транзакции, что и строки, и это
    /// единственное место, где тип колонки встречается с Dapper напрямую.
    [<Fact>]
    member _.``Every page names the UTC moment its snapshot was taken at``() =
        use live = new LiveMeetupsHost()
        let client = AuthenticatedClient.bot live.Channel
        createDraft client |> ignore

        let moment = (page live "" 50).ConsistentAt
        let parsed = DateTimeOffset.Parse(moment, CultureInfo.InvariantCulture)
        // Само чтение поля внутри quotation требует адреса структуры, поэтому
        // смещение достаётся значением до утверждения (FS3155).
        let offset = parsed.Offset

        test <@ offset = TimeSpan.Zero @>

    /// Перечисление отдаёт полный снимок, а не сводку: реплика восстанавливает
    /// состояние целиком, и версия агрегата нужна ей, чтобы разрешить гонку с
    /// буфером событий.
    [<Fact>]
    member _.``The enumeration returns whole snapshots with their version``() =
        use live = new LiveMeetupsHost()
        let client = AuthenticatedClient.bot live.Channel
        let key = createDraft client

        let only = page live "" 50
        let snapshot = only.Meetups |> Seq.find (fun m -> m.Id = key)

        test
            <@
                snapshot.Version = 1L
                && snapshot.Visibility = MeetupVisibility.Hidden
            @>

    [<Fact>]
    member _.``A cursor the service did not issue is refused``() =
        use live = new LiveMeetupsHost()
        let walk () = page live "not-a-token" 50 |> ignore
        let refused = Rpc.codeOf walk

        test <@ refused = Some StatusCode.InvalidArgument @>
