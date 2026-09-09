namespace Meetups.IntegrationTests.Scenarios

open System
open Grpc.Core
open Meetups.IntegrationTests.Infrastructure
open Meetups.V1
open Swensen.Unquote
open Xunit

/// Операции контракта через настоящий Kestrel и настоящий PostgreSQL. Это
/// автоматическая проверка пути, который вручную вызывается grpcurl без Telegram:
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

    let createPublished
        (client: MeetupsService.MeetupsServiceClient)
        (admin: Viewer)
        (id: Guid)
        (title: string)
        (schedule: Schedule option)
        =
        let key = id.ToString "D"

        client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = admin, Id = key))
        |> ignore

        client.ChangeMeetupAttributes(ChangeMeetupAttributesRequest(Viewer = admin, Id = key, Title = title))
        |> ignore

        match schedule with
        | Some value ->
            client.SetMeetupSchedule(SetMeetupScheduleRequest(Viewer = admin, Id = key, Schedule = value))
            |> ignore
        | None -> ()

        client.PublishMeetup(PublishMeetupRequest(Viewer = admin, Id = key))

    let fixedDay year month day = Schedule(Fixed = DateValue(Day = CalendarDate(Year = year, Month = month, Day = day)))

    let fixedTime year month day hours minutes =
        Schedule(
            Fixed =
                DateValue(
                    DayStart =
                        LocalDateTime(
                            Date = CalendarDate(Year = year, Month = month, Day = day),
                            Time = LocalTime(Hours = hours, Minutes = minutes)
                        )
                )
        )

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

    [<Fact>]
    member _.``Listing meetups from an empty database answers with an empty page``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)

        let response =
            client.ListVisibleMeetups(ListVisibleMeetupsRequest(Viewer = ordinary ()))

        test <@ response.Meetups.Count = 0 @>

    [<Fact>]
    member _.``Meetups are listed by date with day first and no date last``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let admin = administrator ()

        createPublished client admin (newId ()) "No date" None
        |> ignore

        createPublished client admin (newId ()) "Same day at 18:00" (Some(fixedTime 2026 10 3 18 0))
        |> ignore

        createPublished client admin (newId ()) "Same day" (Some(fixedDay 2026 10 3))
        |> ignore

        createPublished client admin (newId ()) "Earlier" (Some(fixedTime 2026 10 2 21 0))
        |> ignore

        let actual =
            client.ListVisibleMeetups(ListVisibleMeetupsRequest(Viewer = ordinary ())).Meetups
            |> Seq.map (fun meetup -> meetup.Title)
            |> List.ofSeq

        test
            <@
                actual = [
                    "Earlier"
                    "Same day"
                    "Same day at 18:00"
                    "No date"
                ]
            @>

    [<Fact>]
    member _.``An ordinary viewer gets the stored meetup snapshot``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let id = newId ()
        let expectedId = id.ToString "D"

        createPublished client (administrator ()) id "Readable meetup" (Some(fixedDay 2026 10 3))
        |> ignore

        let snapshot =
            client.GetMeetup(GetMeetupRequest(Viewer = ordinary (), Id = id.ToString "D"))

        test
            <@
                snapshot.Id = expectedId
                && snapshot.Title = "Readable meetup"
                && snapshot.Visibility = MeetupVisibility.Visible
                && snapshot.Schedule.Fixed.Day.Day = 3
            @>

    [<Fact>]
    member _.``A missing meetup answers NOT_FOUND``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)

        let actual =
            Rpc.codeOf (fun () ->
                client.GetMeetup(GetMeetupRequest(Viewer = ordinary (), Id = (newId ()).ToString "D"))
                |> ignore
            )

        test <@ actual = Some StatusCode.NotFound @>

    [<Fact>]
    member _.``A hidden meetup is visible only to its author and administrators``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let author = administrator ()
        let id = newId ()
        let key = id.ToString "D"

        client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = author, Id = key))
        |> ignore

        let own = client.GetMeetup(GetMeetupRequest(Viewer = author, Id = key))
        let administrative = client.GetMeetup(GetMeetupRequest(Viewer = otherAdministrator (), Id = key))

        let concealed =
            Rpc.codeOf (fun () ->
                client.GetMeetup(GetMeetupRequest(Viewer = ordinary (), Id = key))
                |> ignore
            )

        let listed =
            client.ListVisibleMeetups(ListVisibleMeetupsRequest(Viewer = ordinary ())).Meetups
            |> Seq.map _.Id
            |> Seq.contains key

        test
            <@
                own.Id = key
                && administrative.Id = key
                && concealed = Some StatusCode.NotFound
                && not listed
            @>

        let denial =
            live.Records
            |> List.tryFind (fun entry -> entry.Fields.TryFind "denial_reason" = Some "not_visible")

        test <@ denial.IsSome @>

    [<Fact>]
    member _.``The boundary fills the log frame for a read call``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)

        client.ListVisibleMeetups(ListVisibleMeetupsRequest(Viewer = ordinary ()))
        |> ignore

        let frame =
            live.Records
            |> List.tryFind (fun entry ->
                entry.Fields.TryFind "operation" = Some "/meetups.v1.MeetupsService/ListVisibleMeetups"
            )
            |> Option.map (fun entry ->
                entry.Fields.TryFind "service", entry.Fields.TryFind "result", entry.Fields.ContainsKey "duration_us"
            )

        test <@ frame = Some(Some "meetups", Some "ok", true) @>

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
