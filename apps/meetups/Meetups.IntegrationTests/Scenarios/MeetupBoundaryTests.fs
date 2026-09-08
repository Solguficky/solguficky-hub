namespace Meetups.IntegrationTests.Scenarios

open System
open Grpc.Core
open Meetups.IntegrationTests.Infrastructure
open Meetups.V1
open Swensen.Unquote
open Xunit

/// Командные операции через настоящий Kestrel и настоящий PostgreSQL. Это и есть
/// автоматическая форма критерия «команды отвечают через grpcurl без Telegram»:
/// ручной grpcurl остаётся для проверки того, что Aspire собрал сервис, а не того,
/// что сервис работает.
///
/// Хост поднимается в теле теста, а не class fixture: пропуск без Docker должен
/// оставаться пропуском, а не падением класса.
type MeetupBoundaryTests() =

    let administrator () =
        let viewer = Viewer(IdentityId = "0199c0de-0000-7000-8000-00000000000a")
        viewer.GlobalRoles.Add Identity.V1.GlobalRole.Admin
        viewer

    let otherAdministrator () =
        let viewer = Viewer(IdentityId = "0199c0de-0000-7000-8000-00000000000b")
        viewer.GlobalRoles.Add Identity.V1.GlobalRole.Admin
        viewer

    let ordinary () = Viewer(IdentityId = "0199c0de-0000-7000-8000-00000000000c")

    let newId () = Guid.CreateVersion7()

    [<Fact>]
    member _.``An administrator drives a meetup from draft to visible over gRPC``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let admin = administrator ()
        let id = newId ()
        let key = id.ToString "D"

        let draft =
            client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = admin, Id = key))

        let changed =
            client.ChangeMeetupAttributes(
                ChangeMeetupAttributesRequest(
                    Viewer = admin,
                    Id = key,
                    Title = "F# after hours",
                    Description = "Вертикальные срезы на живом коде",
                    Venue = "Тбилиси, Fabrika",
                    Kind = "Митап",
                    CalendarLink = "https://calendar.example/fs"
                )
            )

        let scheduled =
            client.SetMeetupSchedule(
                SetMeetupScheduleRequest(
                    Viewer = admin,
                    Id = key,
                    Schedule = Schedule(Fixed = DateValue(Day = CalendarDate(Year = 2026, Month = 10, Day = 3)))
                )
            )

        let published = client.PublishMeetup(PublishMeetupRequest(Viewer = admin, Id = key))

        // Версия растёт на каждое записанное событие: это видно из ответов, а не
        // только из таблицы.
        test
            <@
                [
                    draft.Version
                    changed.Version
                    scheduled.Version
                    published.Version
                ] = [ 1L; 2L; 3L; 4L ]
            @>

        test
            <@
                draft.Visibility = MeetupVisibility.Hidden
                && not draft.HasFirstPublishedAt
            @>

        test
            <@
                published.Title = "F# after hours"
                && published.Venue = "Тбилиси, Fabrika"
                && published.Schedule.Fixed.Day.Month = 10
                && published.Visibility = MeetupVisibility.Visible
                && published.HasFirstPublishedAt
            @>

    /// Идемпотентность через провод: ключ создания и есть идентификатор (ADR-031),
    /// поэтому повтор обязан вернуть тот же снимок, а не завести вторую сходку.
    [<Fact>]
    member _.``A repeated create by the same administrator writes nothing new``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let admin = administrator ()
        let id = newId ()
        let key = id.ToString "D"

        let first =
            client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = admin, Id = key))

        let second =
            client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = admin, Id = key))

        test <@ first.Version = 1L && second.Version = 1L @>
        test <@ MeetupCommands.countMeetups live.ConnectionString id = 1L @>
        test <@ MeetupCommands.countEvents live.ConnectionString id = 1L @>

    /// Чужой черновик и несуществующая сходка отвечают одним кодом «не найдено»
    /// (ADR-022). Вызовы разные — CreateMeetupDraft на свободном id по построению
    /// успешен, поэтому одной операцией эти два случая не столкнуть, — но именно
    /// совпадение кодов через границу здесь и проверяется.
    [<Fact>]
    member _.``A foreign draft and a missing meetup answer with the same code``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let key = (newId ()).ToString "D"

        client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = administrator (), Id = key))
        |> ignore

        let foreign =
            Rpc.codeOf (fun () ->
                client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = otherAdministrator (), Id = key))
                |> ignore
            )

        let missing =
            Rpc.codeOf (fun () ->
                client.PublishMeetup(PublishMeetupRequest(Viewer = administrator (), Id = (newId ()).ToString "D"))
                |> ignore
            )

        test
            <@
                foreign = Some StatusCode.NotFound
                && missing = foreign
            @>

    [<Fact>]
    member _.``Publishing a titleless draft is refused as FAILED_PRECONDITION``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let admin = administrator ()
        let key = (newId ()).ToString "D"

        client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = admin, Id = key))
        |> ignore

        let actual =
            Rpc.codeOf (fun () ->
                client.PublishMeetup(PublishMeetupRequest(Viewer = admin, Id = key))
                |> ignore
            )

        test <@ actual = Some StatusCode.FailedPrecondition @>

    /// Отказ по праву не только возвращает код, но и ничего не пишет: без счётчиков
    /// зелёным остался бы и тот вариант, где команда выполнилась и откатилась.
    [<Fact>]
    member _.``A refused command leaves no state and no journal row``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let id = newId ()

        let actual =
            Rpc.codeOf (fun () ->
                client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = ordinary (), Id = id.ToString "D"))
                |> ignore
            )

        test <@ actual = Some StatusCode.PermissionDenied @>
        test <@ MeetupCommands.countMeetups live.ConnectionString id = 0L @>
        test <@ MeetupCommands.countEvents live.ConnectionString id = 0L @>
