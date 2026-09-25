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

        let draft =
            client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = admin, Id = key))

        let changed =
            client.ChangeMeetupAttributes(
                ChangeMeetupAttributesRequest(Viewer = admin, Id = key, ExpectedVersion = draft.Version, Title = title)
            )

        let scheduled =
            match schedule with
            | Some value ->
                client.SetMeetupSchedule(
                    SetMeetupScheduleRequest(
                        Viewer = admin,
                        Id = key,
                        ExpectedVersion = changed.Version,
                        Schedule = value
                    )
                )
            | None -> changed

        client.PublishMeetup(PublishMeetupRequest(Viewer = admin, Id = key, ExpectedVersion = scheduled.Version))

    let fixedDay (date: DateOnly) =
        Schedule(Fixed = DateValue(Day = CalendarDate(Year = date.Year, Month = date.Month, Day = date.Day)))

    let fixedTime (date: DateOnly) hours minutes =
        Schedule(
            Fixed =
                DateValue(
                    DayStart =
                        LocalDateTime(
                            Date = CalendarDate(Year = date.Year, Month = date.Month, Day = date.Day),
                            Time = LocalTime(Hours = hours, Minutes = minutes)
                        )
                )
        )

    /// Списки отделяют архив от актуального по дню сообщества, поэтому расписание в
    /// сценариях считается от него: фиксированная дата позеленела бы сегодня и
    /// покраснела после неё.
    let today = MeetupCommands.communityToday ()

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
                    ExpectedVersion = draft.Version,
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
                    ExpectedVersion = changed.Version,
                    Schedule = Schedule(Fixed = DateValue(Day = CalendarDate(Year = 2026, Month = 10, Day = 3)))
                )
            )

        let published =
            client.PublishMeetup(PublishMeetupRequest(Viewer = admin, Id = key, ExpectedVersion = scheduled.Version))

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

    /// Настоящий конфликт версий по проводу: оба администратора пришли с одним
    /// показанным снимком, первый сохранил своё изменение, второй с той же версией и
    /// другим целевым состоянием получает ABORTED. До этого среза отказ был
    /// недостижим снаружи: expected_version во вход команд не входил (integration.md).
    /// Повтор уже достигнутой цели с той же старой версией — успех без события.
    [<Fact>]
    member _.``A stale snapshot is refused as ABORTED over the wire``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let first = administrator ()
        let second = otherAdministrator ()
        let id = newId ()
        let key = id.ToString "D"

        let draft =
            client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = first, Id = key))

        client.ChangeMeetupAttributes(
            ChangeMeetupAttributesRequest(Viewer = first, Id = key, ExpectedVersion = draft.Version, Title = "Первый")
        )
        |> ignore

        let actual =
            Rpc.codeOf (fun () ->
                client.ChangeMeetupAttributes(
                    ChangeMeetupAttributesRequest(
                        Viewer = second,
                        Id = key,
                        ExpectedVersion = draft.Version,
                        Title = "Второй"
                    )
                )
                |> ignore
            )

        test <@ actual = Some StatusCode.Aborted @>

        // Отказ по конфликту различим и в записи границы: своей парой «код
        // транспорта — категория» он не сливается с отказом по праву.
        let frame =
            live.Records
            |> List.tryFindBack (fun entry ->
                entry.Fields.TryFind "operation" = Some "/meetups.v1.MeetupsService/ChangeMeetupAttributes"
                && entry.Fields.TryFind "grpc_code" = Some "Aborted"
            )
            |> Option.map (fun entry -> entry.Fields.TryFind "error_category")

        test <@ frame = Some(Some "invariant") @>

        let repeat =
            client.ChangeMeetupAttributes(
                ChangeMeetupAttributesRequest(
                    Viewer = second,
                    Id = key,
                    ExpectedVersion = draft.Version,
                    Title = "Первый"
                )
            )

        test <@ repeat.Version = 2L @>
        test <@ MeetupCommands.countEvents live.ConnectionString id = 2L @>

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

        createPublished client admin (newId ()) "Same day at 18:00" (Some(fixedTime (today.AddDays 3) 18 0))
        |> ignore

        createPublished client admin (newId ()) "Same day" (Some(fixedDay (today.AddDays 3)))
        |> ignore

        createPublished client admin (newId ()) "Earlier" (Some(fixedTime (today.AddDays 2) 21 0))
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
        let scheduled = today.AddDays 30
        let expectedDay = scheduled.Day

        createPublished client (administrator ()) id "Readable meetup" (Some(fixedDay scheduled))
        |> ignore

        let snapshot =
            client.GetMeetup(GetMeetupRequest(Viewer = ordinary (), Id = id.ToString "D"))

        test
            <@
                snapshot.Id = expectedId
                && snapshot.Title = "Readable meetup"
                && snapshot.Visibility = MeetupVisibility.Visible
                && snapshot.Schedule.Fixed.Day.Day = expectedDay
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

        let administrative =
            client.GetMeetup(GetMeetupRequest(Viewer = otherAdministrator (), Id = key))

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
                client.PublishMeetup(
                    PublishMeetupRequest(Viewer = administrator (), Id = (newId ()).ToString "D", ExpectedVersion = 1L)
                )
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

        let draft =
            client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = admin, Id = key))

        let actual =
            Rpc.codeOf (fun () ->
                client.PublishMeetup(PublishMeetupRequest(Viewer = admin, Id = key, ExpectedVersion = draft.Version))
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

    /// Момент отложенной публикации на проводе: локальная пара в запросе, мгновение
    /// в ответе и чтении. Скрытую сходку с назначенным моментом по-прежнему видит
    /// только автор и администратор — правило видимости ADR-022 момент не ослабляет.
    [<Fact>]
    member _.``A scheduled publication is returned to whoever sees the meetup``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let admin = administrator ()
        let id = newId ()
        let key = id.ToString "D"

        let draft =
            client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = admin, Id = key))

        let scheduled =
            client.ScheduleMeetupPublication(
                ScheduleMeetupPublicationRequest(
                    Viewer = admin,
                    Id = key,
                    Moment =
                        LocalDateTime(
                            Date = CalendarDate(Year = 2026, Month = 10, Day = 5),
                            Time = LocalTime(Hours = 19, Minutes = 0)
                        ),
                    ExpectedVersion = draft.Version
                )
            )

        // 19:00 в Москве — 16:00 UTC.
        let expected = DateTimeOffset(2026, 10, 5, 16, 0, 0, TimeSpan.Zero)

        test
            <@
                scheduled.HasScheduledPublishAt
                && DateTimeOffset.Parse scheduled.ScheduledPublishAt = expected
            @>

        let read = client.GetMeetup(GetMeetupRequest(Viewer = admin, Id = key))

        let concealed =
            Rpc.codeOf (fun () ->
                client.GetMeetup(GetMeetupRequest(Viewer = ordinary (), Id = key))
                |> ignore
            )

        test
            <@
                read.HasScheduledPublishAt
                && DateTimeOffset.Parse read.ScheduledPublishAt = expected
                && concealed = Some StatusCode.NotFound
            @>

        let cancelled =
            client.CancelMeetupPublication(
                CancelMeetupPublicationRequest(Viewer = admin, Id = key, ExpectedVersion = scheduled.Version)
            )

        test <@ not cancelled.HasScheduledPublishAt @>

    /// Два отказа назначения различимы клиенту по коду: прошедший момент —
    /// INVALID_ARGUMENT (значение запроса), уже опубликованная сходка —
    /// FAILED_PRECONDITION (состояние). Различие объявлено в integration.md.
    [<Fact>]
    member _.``A past moment and a published meetup are refused with different codes``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let admin = administrator ()

        let draftKey = (newId ()).ToString "D"

        let draft =
            client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = admin, Id = draftKey))

        let past =
            Rpc.codeOf (fun () ->
                client.ScheduleMeetupPublication(
                    ScheduleMeetupPublicationRequest(
                        Viewer = admin,
                        Id = draftKey,
                        Moment =
                            LocalDateTime(
                                Date = CalendarDate(Year = 2026, Month = 9, Day = 1),
                                Time = LocalTime(Hours = 12, Minutes = 0)
                            ),
                        ExpectedVersion = draft.Version
                    )
                )
                |> ignore
            )

        let publishedId = newId ()

        let published' = createPublished client admin publishedId "Already visible" None

        let published =
            Rpc.codeOf (fun () ->
                client.ScheduleMeetupPublication(
                    ScheduleMeetupPublicationRequest(
                        Viewer = admin,
                        Id = publishedId.ToString "D",
                        Moment =
                            LocalDateTime(
                                Date = CalendarDate(Year = 2026, Month = 10, Day = 5),
                                Time = LocalTime(Hours = 19, Minutes = 0)
                            ),
                        ExpectedVersion = published'.Version
                    )
                )
                |> ignore
            )

        test <@ past = Some StatusCode.InvalidArgument @>
        test <@ published = Some StatusCode.FailedPrecondition @>

    /// PER-227, первое звено: id из кадра бота, пришедший заголовком, лежит в строке
    /// журнала рядом с событием — тем же значением, что в записи границы.
    [<Fact>]
    member _.``A command stores the request id it came with next to its event``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let id = newId ()
        let headers = Metadata()
        headers.Add("x-request-id", "req-bot-frame")

        client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = administrator (), Id = id.ToString "D"), headers)
        |> ignore

        test <@ MeetupCommands.requestIds live.ConnectionString id = [ Some "req-bot-frame" ] @>

    /// Вызов без заголовка допустим (integration.md), и журнал не выдумывает замену.
    /// Заголовок длиннее предела трактуется так же: команда не падает на ограничении
    /// схемы, а значение отбрасывается и в логе, и в журнале.
    [<Fact>]
    member _.``A command without a usable request id stores none``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let bare = newId ()
        let oversized = newId ()
        let headers = Metadata()
        headers.Add("x-request-id", String('r', 129))

        client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = administrator (), Id = bare.ToString "D"))
        |> ignore

        client.CreateMeetupDraft(
            CreateMeetupDraftRequest(Viewer = administrator (), Id = oversized.ToString "D"),
            headers
        )
        |> ignore

        test <@ MeetupCommands.requestIds live.ConnectionString bare = [ None ] @>
        test <@ MeetupCommands.requestIds live.ConnectionString oversized = [ None ] @>
