namespace Meetups.IntegrationTests.Scenarios

open Grpc.Core
open Grpc.Health.V1
open Meetups.IntegrationTests.Infrastructure
open Meetups.V1
open Swensen.Unquote
open Xunit

/// Один хост на класс: старт Kestrel дороже самих вызовов. Очередь записей у
/// него общая, поэтому каждый тест утверждает про свою операцию.
///
/// Живой базы у этого хоста нет: DSN валиден по форме и заведомо недостижим.
/// Отсюда следует, что здесь проверяются каркас границы и те отказы, которые
/// принимаются до открытия соединения, — по праву и по разбору запроса. Успешные
/// чтения живут в MeetupBoundaryTests с настоящей PostgreSQL.
///
/// «До обращения к хранилищу» относится к соединению, а не к контейнеру: сборку
/// зависимостей диспетчер делает раньше разбора запроса, и NpgsqlDataSource
/// резолвится всегда. Именно поэтому фикстуре и понадобился DSN.
type GrpcBoundaryTests(host: MeetupsHostFixture) =

    let client = MeetupsService.MeetupsServiceClient(host.Channel)

    /// Пустой набор ролей — обычный пользователь (integration.md).
    let viewer = Viewer(IdentityId = "0199c0de-0000-7000-8000-00000000000a")

    let id = "0199c0de-0000-7000-8000-000000000001"

    let recordOf operation =
        host.Records
        |> List.tryFind (fun entry -> entry.Fields.TryFind "operation" = Some operation)

    interface IClassFixture<MeetupsHostFixture>

    /// Заголовочный критерий задачи: отказ по праву приходит от Meetups, а не от
    /// проверки в боте, и приходит на каждой административной операции.
    [<Fact>]
    member _.``Every command refuses an ordinary viewer with PERMISSION_DENIED``() =
        let actual =
            [
                Rpc.codeOf (fun () ->
                    client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = viewer, Id = id))
                    |> ignore
                )
                Rpc.codeOf (fun () ->
                    client.ChangeMeetupAttributes(ChangeMeetupAttributesRequest(Viewer = viewer, Id = id))
                    |> ignore
                )
                Rpc.codeOf (fun () ->
                    client.SetMeetupSchedule(
                        SetMeetupScheduleRequest(Viewer = viewer, Id = id, Schedule = Schedule(NoDate = NoDate()))
                    )
                    |> ignore
                )
                Rpc.codeOf (fun () ->
                    client.PublishMeetup(PublishMeetupRequest(Viewer = viewer, Id = id))
                    |> ignore
                )
            ]

        test <@ actual = List.replicate 4 (Some StatusCode.PermissionDenied) @>

    /// Клиент собрал запрос неправильно — это INVALID_ARGUMENT, а не отказ домена.
    /// Проверяются три разных дефекта сборки, потому что каждый разбирает своя
    /// функция границы.
    [<Fact>]
    member _.``A malformed request is refused with INVALID_ARGUMENT``() =
        let actual =
            [
                // Смотрящего нет вовсе.
                Rpc.codeOf (fun () ->
                    client.PublishMeetup(PublishMeetupRequest(Id = id))
                    |> ignore
                )
                // Идентификатор не в каноническом виде.
                Rpc.codeOf (fun () ->
                    client.PublishMeetup(PublishMeetupRequest(Viewer = viewer, Id = id.ToUpperInvariant()))
                    |> ignore
                )
                // Пустой oneof расписания: «даты нет» — это форма no_date, а не
                // отсутствие формы.
                Rpc.codeOf (fun () ->
                    client.SetMeetupSchedule(SetMeetupScheduleRequest(Viewer = viewer, Id = id, Schedule = Schedule()))
                    |> ignore
                )
                // Читающие срезы разбирают тот же viewer и id до открытия соединения.
                Rpc.codeOf (fun () ->
                    client.ListVisibleMeetups(ListVisibleMeetupsRequest())
                    |> ignore
                )
                Rpc.codeOf (fun () ->
                    client.GetMeetup(GetMeetupRequest(Id = id))
                    |> ignore
                )
                Rpc.codeOf (fun () ->
                    client.GetMeetup(GetMeetupRequest(Viewer = viewer, Id = id.ToUpperInvariant()))
                    |> ignore
                )
            ]

        test <@ actual = List.replicate 6 (Some StatusCode.InvalidArgument) @>

    [<Fact>]
    member _.``The service reports itself serving over grpc health v1``() =
        let health = Health.HealthClient(host.Channel)

        let actual = health.Check(HealthCheckRequest()).Status

        test <@ actual = HealthCheckResponse.Types.ServingStatus.Serving @>

    /// Объявленный отказ — часть контракта, а не сбой сервиса: Warning без stack и
    /// код транспорта в своём поле, а не в result. До этой задачи такого отказа у
    /// сервиса не существовало, и правило проверялось только in-process.
    [<Fact>]
    member _.``A declared refusal is recorded as a warning with its transport code``() =
        Rpc.codeOf (fun () ->
            client.ChangeMeetupAttributes(ChangeMeetupAttributesRequest(Viewer = viewer, Id = id))
            |> ignore
        )
        |> ignore

        let frame =
            recordOf "/meetups.v1.MeetupsService/ChangeMeetupAttributes"
            |> Option.map (fun entry ->
                entry.Level, entry.Fields.TryFind "result", entry.Fields.TryFind "grpc_code", entry.Exception.IsSome
            )

        test
            <@ frame = Some(Microsoft.Extensions.Logging.LogLevel.Warning, Some "error", Some "PermissionDenied", false) @>

    [<Fact>]
    member _.``The boundary omits fields it has nothing to fill``() =
        Rpc.codeOf (fun () ->
            client.PublishMeetup(PublishMeetupRequest(Viewer = viewer, Id = id))
            |> ignore
        )
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
        // Вызов отказывается по праву, но запись границы от этого не исчезает.
        Rpc.codeOf (fun () ->
            client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = viewer, Id = id))
            |> ignore
        )
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
