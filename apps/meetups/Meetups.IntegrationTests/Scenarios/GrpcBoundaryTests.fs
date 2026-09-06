namespace Meetups.IntegrationTests.Scenarios

open Grpc.Health.V1
open Meetups.IntegrationTests.Infrastructure
open Meetups.V1
open Swensen.Unquote
open Xunit

/// Один хост на класс: старт Kestrel дороже самих вызовов. Очередь записей у
/// него общая, поэтому каждый тест утверждает про свою операцию.
type GrpcBoundaryTests(host: MeetupsHostFixture) =

    let client = MeetupsService.MeetupsServiceClient(host.Channel)
    let viewer = Viewer(IdentityId = "0199c0de-0000-7000-8000-00000000000a")
    let id = "0199c0de-0000-7000-8000-000000000001"

    let recordOf operation =
        host.Records
        |> List.tryFind (fun entry -> entry.Fields.TryFind "operation" = Some operation)

    interface IClassFixture<MeetupsHostFixture>

    [<Fact>]
    member _.``Every command answers over h2c and echoes the meetup id``() =
        let actual =
            [
                client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = viewer, Id = id))
                client.ChangeMeetupAttributes(ChangeMeetupAttributesRequest(Viewer = viewer, Id = id))
                client.SetMeetupSchedule(
                    SetMeetupScheduleRequest(Viewer = viewer, Id = id, Schedule = Schedule(NoDate = NoDate()))
                )
                client.PublishMeetup(PublishMeetupRequest(Viewer = viewer, Id = id))
                client.GetMeetup(GetMeetupRequest(Viewer = viewer, Id = id))
            ]
            |> List.map (fun snapshot -> snapshot.Id)

        test <@ actual = List.replicate 5 id @>

    [<Fact>]
    member _.``Listing visible meetups answers with an empty page, not an error``() =
        let response = client.ListVisibleMeetups(ListVisibleMeetupsRequest(Viewer = viewer))

        test <@ response.Meetups.Count = 0 @>

    [<Fact>]
    member _.``The service reports itself serving over grpc health v1``() =
        let health = Health.HealthClient(host.Channel)

        let actual = health.Check(HealthCheckRequest()).Status

        test <@ actual = HealthCheckResponse.Types.ServingStatus.Serving @>

    [<Fact>]
    member _.``The boundary fills the log frame for a product call``() =
        client.GetMeetup(GetMeetupRequest(Viewer = viewer, Id = id))
        |> ignore

        let frame =
            recordOf "/meetups.v1.MeetupsService/GetMeetup"
            |> Option.map (fun entry ->
                entry.Fields.TryFind "service", entry.Fields.TryFind "result", entry.Fields.ContainsKey "duration_us"
            )

        test <@ frame = Some(Some "meetups", Some "ok", true) @>

    [<Fact>]
    member _.``The boundary omits fields it has nothing to fill``() =
        client.PublishMeetup(PublishMeetupRequest(Viewer = viewer, Id = id))
        |> ignore

        // Утверждение идёт по найденной записи, а не по пустому множеству: иначе
        // тест остался бы зелёным с выключенным интерцептором. Пустое значение
        // неотличимо от заполненного при запросе на существование поля, поэтому
        // use_case и request_id опускаются до PER-104 и PER-65.
        let declared =
            recordOf "/meetups.v1.MeetupsService/PublishMeetup"
            |> Option.map (fun entry ->
                [ "use_case"; "request_id" ]
                |> List.filter entry.Fields.ContainsKey
            )

        test <@ declared = Some [] @>

    [<Fact>]
    member _.``The readiness probe leaves no boundary record``() =
        let health = Health.HealthClient(host.Channel)
        health.Check(HealthCheckRequest()) |> ignore
        // Положительный контроль: продуктовый вызов рядом доказывает, что записи
        // вообще снимаются, и отсутствие пробы значит фильтр, а не мёртвый сток.
        client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = viewer, Id = id))
        |> ignore

        let operations =
            host.Records
            |> List.choose (fun entry -> entry.Fields.TryFind "operation")

        let probes =
            operations
            |> List.filter (fun name -> name.StartsWith "/grpc.health.v1.Health/")

        test <@ probes = [] @>

        test
            <@
                operations
                |> List.contains "/meetups.v1.MeetupsService/CreateMeetupDraft"
            @>
