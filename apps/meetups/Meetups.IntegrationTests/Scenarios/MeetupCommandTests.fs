namespace Meetups.IntegrationTests.Scenarios

open System
open System.Threading.Tasks
open Meetups.Domain
open Meetups.Infrastructure
open Meetups.IntegrationTests.Infrastructure
open Swensen.Unquote
open Xunit

/// Команды записи против настоящего PostgreSQL. Атомарность пары «состояние и
/// событие», отклонение по версии и идемпотентность повтора — свойства базы, а не
/// кода: проверить их моком нельзя, поэтому здесь изолированная база на тест.
type MeetupCommandTests() =

    let meetupId = Guid.Parse "0199c0de-0000-7000-8000-0000000000c1"
    let firstEvent = Guid.Parse "0199c0de-0000-7000-8000-0000000000e1"
    let secondEvent = Guid.Parse "0199c0de-0000-7000-8000-0000000000e2"
    let thirdEvent = Guid.Parse "0199c0de-0000-7000-8000-0000000000e3"
    let fourthEvent = Guid.Parse "0199c0de-0000-7000-8000-0000000000e4"
    let fifthEvent = Guid.Parse "0199c0de-0000-7000-8000-0000000000e6"

    /// Успешный путь доказывает единство транзакции сам по себе: у обеих строк одна
    /// и та же `xmin`. Адаптер, разложенный на две транзакции, краснеет здесь, не
    /// дожидаясь, пока кто-нибудь придумает ему отказ.
    [<Fact>]
    member _.``State and journal row are written by one and the same transaction``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        MeetupCommands.create source firstEvent (MeetupId meetupId) MeetupCommands.administrator
        |> ignore

        let stateTransaction = MeetupCommands.transactionOf dsn "meetups" "id" meetupId

        let eventTransaction =
            MeetupCommands.transactionOf dsn "meetup_events" "meetup_id" meetupId

        test <@ stateTransaction = eventTransaction @>

    /// Отказ на журнале обязан снять уже записанное состояние. Отказ настоящий, от
    /// базы: `event_id` занят заранее, поэтому вставка события падает после
    /// успешного UPDATE и проверяет именно откат продуктового адаптера.
    [<Fact>]
    member _.``A journal failure leaves neither the new state nor the event``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        MeetupCommands.create source firstEvent (MeetupId meetupId) MeetupCommands.administrator
        |> ignore

        // Идентификатор второго события занимает чужая строка того же журнала.
        SchemaSql.insertEvent dsn secondEvent meetupId 99 "meetup_changed"

        let thrown =
            MeetupCommands.attempt (fun () ->
                MeetupCommands.change source secondEvent (MeetupId meetupId)
                |> ignore
            )

        test
            <@
                thrown
                |> Option.exists MeetupCommands.isUniqueViolation
            @>

        test <@ MeetupCommands.versionOf dsn meetupId = 1L @>
        test <@ MeetupCommands.countEvents dsn meetupId = 2L @>

    /// Две команды, принятые из одной и той же версии. Конкуренция здесь вызвана
    /// устаревшим чтением, а не одновременностью по часам, поэтому тест полностью
    /// последователен и не может замигать.
    [<Fact>]
    member _.``Of two commands decided from one version the second is rejected``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        MeetupCommands.create source firstEvent (MeetupId meetupId) MeetupCommands.administrator
        |> ignore

        let stale =
            MeetupStore.load source (MeetupId meetupId)
            |> MeetupCommands.run

        let staleDeps eventId : Meetups.Slices.ChangeMeetupAttributes.Deps =
            { MeetupCommands.changeDeps source eventId with
                Load = fun _ -> Task.FromResult stale
            }

        let command: Meetups.Slices.ChangeMeetupAttributes.Command =
            {
                Id = MeetupId meetupId
                Viewer = MeetupCommands.administrator
                Attributes = MeetupCommands.attributes
            }

        let winner =
            Meetups.Slices.ChangeMeetupAttributes.execute (staleDeps secondEvent) command
            |> MeetupCommands.run

        let loser =
            Meetups.Slices.ChangeMeetupAttributes.execute (staleDeps thirdEvent) command
            |> MeetupCommands.run

        test <@ MeetupCommands.versionIn winner = Some 2L @>
        test <@ loser = Error Meetups.Slices.ChangeMeetupAttributes.ChangeMeetupAttributesError.Conflict @>
        // Проигравшая команда не оставила следа: ни версии 3, ни третьего события.
        test <@ MeetupCommands.versionOf dsn meetupId = 2L @>
        test <@ MeetupCommands.countEvents dsn meetupId = 2L @>

    [<Fact>]
    member _.``Repeating the create keeps one meetup and one event``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        let first =
            MeetupCommands.create source firstEvent (MeetupId meetupId) MeetupCommands.administrator

        let repeat =
            MeetupCommands.create source secondEvent (MeetupId meetupId) MeetupCommands.administrator

        test <@ first = repeat @>
        test <@ MeetupCommands.countMeetups dsn meetupId = 1L @>
        test <@ MeetupCommands.countEvents dsn meetupId = 1L @>
        // Повтор не переписал конверт: в журнале остался идентификатор первой записи.
        test <@ MeetupCommands.journalIds dsn meetupId = [ firstEvent ] @>

    /// Повтор чужим автором неотличим по последствиям от обращения к несуществующей
    /// сходке: ничего не пишется, и черновик остаётся чужим.
    [<Fact>]
    member _.``A create repeated by another author writes nothing``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        MeetupCommands.create source firstEvent (MeetupId meetupId) MeetupCommands.administrator
        |> ignore

        let rejected =
            MeetupCommands.create source secondEvent (MeetupId meetupId) MeetupCommands.otherAdministrator

        test
            <@
                rejected = Error(
                    Meetups.Slices.CreateMeetupDraft.CreateMeetupDraftError.Domain DraftBelongsToAnotherAuthor
                )
            @>

        test <@ MeetupCommands.countEvents dsn meetupId = 1L @>

    [<Fact>]
    member _.``Publishing twice writes a single publication event``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        MeetupCommands.create source firstEvent (MeetupId meetupId) MeetupCommands.administrator
        |> ignore

        MeetupCommands.change source secondEvent (MeetupId meetupId)
        |> ignore

        let published = MeetupCommands.publish source thirdEvent (MeetupId meetupId)

        let repeat =
            MeetupCommands.publish source (Guid.Parse "0199c0de-0000-7000-8000-0000000000e5") (MeetupId meetupId)

        test <@ published = repeat @>
        test <@ MeetupCommands.countEvents dsn meetupId = 3L @>

        test <@ MeetupCommands.journalIds dsn meetupId = [ firstEvent; secondEvent; thirdEvent ] @>

    /// PER-280: публикация забирает назначенный момент той же записью, что меняет
    /// видимость: `meetups_scheduled_publish_only_when_hidden` не пропустит видимую
    /// строку с моментом, и публикация упала бы `23514` вместо доменного ответа.
    /// Команда назначения теперь есть (PER-203), поэтому момент ставит она, а не
    /// прямой UPDATE: сценарий идёт тем же путём, что у человека.
    [<Fact>]
    member _.``Publishing clears the scheduled publication moment``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        MeetupCommands.create source firstEvent (MeetupId meetupId) MeetupCommands.administrator
        |> ignore

        MeetupCommands.change source secondEvent (MeetupId meetupId)
        |> ignore

        MeetupCommands.schedulePublication
            source
            thirdEvent
            (MeetupId meetupId)
            (MeetupCommands.localMoment 2026 10 5 19 0)
        |> ignore

        test <@ MeetupCommands.scheduledPublicationIsSet dsn meetupId @>

        let stored = MeetupCommands.scheduledPublicationAt dsn meetupId
        test <@ stored = Some(DateTimeOffset(2026, 10, 5, 16, 0, 0, TimeSpan.Zero)) @>

        let published = MeetupCommands.publish source fourthEvent (MeetupId meetupId)

        // Обе колонки, которых касается CHECK: видимость сменилась, момент обнулён.
        test <@ MeetupCommands.versionIn published = Some 4L @>
        test <@ MeetupCommands.visibilityOf dsn meetupId = "visible" @>
        test <@ not (MeetupCommands.scheduledPublicationIsSet dsn meetupId) @>

        // Повтор уже видимой сходки не пишет вовсе, поэтому момент, которого у неё
        // быть не может, остаётся пустым, а версия и журнал доказывают отсутствие
        // записи: сама пустота колонки у видимой строки держится ещё и CHECK.
        let repeat = MeetupCommands.publish source fifthEvent (MeetupId meetupId)

        test <@ MeetupCommands.versionIn repeat = Some 4L @>
        test <@ MeetupCommands.countEvents dsn meetupId = 4L @>
        test <@ not (MeetupCommands.scheduledPublicationIsSet dsn meetupId) @>

    /// Назначение момента — обычная команда: состояние и событие пишутся одной
    /// транзакцией (её доказывает совпадение `xmin`), момент виден в строке и
    /// переживает перечитывание, а имя повода принимает CHECK журнала.
    [<Fact>]
    member _.``Scheduling a publication writes the moment and its event in one transaction``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        MeetupCommands.create source firstEvent (MeetupId meetupId) MeetupCommands.administrator
        |> ignore

        let scheduled =
            MeetupCommands.schedulePublication
                source
                secondEvent
                (MeetupId meetupId)
                (MeetupCommands.localMoment 2026 10 5 19 0)

        test <@ MeetupCommands.versionIn scheduled = Some 2L @>
        test <@ MeetupCommands.countEvents dsn meetupId = 2L @>

        test
            <@
                MeetupCommands.eventTypes dsn meetupId = [
                    "meetup_created"
                    "meetup_publication_scheduled"
                ]
            @>

        let stored = MeetupCommands.scheduledPublicationAt dsn meetupId
        test <@ stored = Some(DateTimeOffset(2026, 10, 5, 16, 0, 0, TimeSpan.Zero)) @>

        let stateTransaction = MeetupCommands.transactionOf dsn "meetups" "id" meetupId
        let eventTransaction = MeetupCommands.lastEventTransactionOf dsn meetupId
        test <@ stateTransaction = eventTransaction @>

        // Момент переживает перечитывание состояния: на это опирается воркер после
        // рестарта сервиса (PER-204).
        let reloaded =
            MeetupStore.load source (MeetupId meetupId)
            |> MeetupCommands.run

        let reloadedMoment =
            reloaded
            |> Option.bind (fun snapshot -> snapshot.ScheduledPublishAt)

        test <@ reloadedMoment = Some(DateTimeOffset(2026, 10, 5, 16, 0, 0, TimeSpan.Zero)) @>

    /// Отмена запланированной публикации очищает поле и оставляет сходку скрытой:
    /// публикации не случилось, и признак «запланирована» исчезает вместе с полем.
    [<Fact>]
    member _.``Cancelling a scheduled publication clears the moment and keeps the meetup hidden``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        MeetupCommands.create source firstEvent (MeetupId meetupId) MeetupCommands.administrator
        |> ignore

        MeetupCommands.schedulePublication
            source
            secondEvent
            (MeetupId meetupId)
            (MeetupCommands.localMoment 2026 10 5 19 0)
        |> ignore

        let cancelled =
            MeetupCommands.cancelPublication source thirdEvent (MeetupId meetupId)

        test <@ MeetupCommands.versionIn cancelled = Some 3L @>

        test
            <@
                MeetupCommands.eventTypes dsn meetupId = [
                    "meetup_created"
                    "meetup_publication_scheduled"
                    "meetup_publication_cancelled"
                ]
            @>

        test <@ not (MeetupCommands.scheduledPublicationIsSet dsn meetupId) @>
        test <@ MeetupCommands.visibilityOf dsn meetupId = "hidden" @>

    /// Прошедший момент отвергается доменом до записи: у сходки остаётся только
    /// событие создания.
    [<Fact>]
    member _.``A past publication moment is rejected without writing``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        MeetupCommands.create source firstEvent (MeetupId meetupId) MeetupCommands.administrator
        |> ignore

        // 19:00 предыдущего дня в Москве: «сейчас» сценария — 12:00 UTC седьмого.
        let refused =
            MeetupCommands.schedulePublication
                source
                secondEvent
                (MeetupId meetupId)
                (MeetupCommands.localMoment 2026 9 6 19 0)

        let expected: Result<MeetupSnapshot, Meetups.Slices.ScheduleMeetupPublication.ScheduleMeetupPublicationError> =
            Error(
                Meetups.Slices.ScheduleMeetupPublication.ScheduleMeetupPublicationError.Domain
                    PublicationMomentInThePast
            )

        test <@ refused = expected @>

        test <@ MeetupCommands.countEvents dsn meetupId = 1L @>
        test <@ not (MeetupCommands.scheduledPublicationIsSet dsn meetupId) @>

    /// Отмена самой сходки очищает назначенный момент тем же переходом, что закрывает
    /// команды: критерий PER-204 «отменённая не оставляет поле заполненным» держится
    /// здесь, а не только в доменном тесте.
    [<Fact>]
    member _.``Cancelling the meetup clears the scheduled publication moment``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        MeetupCommands.create source firstEvent (MeetupId meetupId) MeetupCommands.administrator
        |> ignore

        MeetupCommands.schedulePublication
            source
            secondEvent
            (MeetupId meetupId)
            (MeetupCommands.localMoment 2026 10 5 19 0)
        |> ignore

        MeetupCommands.cancel source thirdEvent (MeetupId meetupId)
        |> ignore

        test
            <@
                MeetupCommands.eventTypes dsn meetupId
                |> List.last = "meetup_cancelled"
            @>

        test <@ not (MeetupCommands.scheduledPublicationIsSet dsn meetupId) @>

    /// Публикация ставит отметку первой публикации, и её принимает именно база: без
    /// отметки `meetups_visible_has_first_publication` отверг бы строку, а тест на
    /// счётчике событий этого бы не заметил.
    [<Fact>]
    member _.``Publishing makes the meetup visible and stamps the first publication``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        MeetupCommands.create source firstEvent (MeetupId meetupId) MeetupCommands.administrator
        |> ignore

        MeetupCommands.change source secondEvent (MeetupId meetupId)
        |> ignore

        let published = MeetupCommands.publish source thirdEvent (MeetupId meetupId)

        let stored =
            MeetupStore.load source (MeetupId meetupId)
            |> MeetupCommands.run

        let axes =
            stored
            |> Option.map (fun snapshot -> snapshot.Visibility, snapshot.FirstPublishedAt)

        test <@ MeetupCommands.versionIn published = Some 3L @>
        test <@ axes = Some(Visible, Some MeetupCommands.now) @>

    /// Расписание — единственная часть состояния, которая раскладывается по шести
    /// колонкам с совместным CHECK. Интервал берёт самую полную из семи форм:
    /// раскладка, которую схема не примет, падает именно здесь.
    [<Fact>]
    member _.``An interval schedule is written across all six columns and read back``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        let interval =
            LocalInterval.create
                {
                    Date = DateOnly(2026, 10, 3)
                    Time =
                        LocalTime.create (TimeOnly(18, 30))
                        |> Result.defaultWith (fun _ -> failwith "the sample time must have minute precision")
                }
                {
                    Date = DateOnly(2026, 10, 3)
                    Time =
                        LocalTime.create (TimeOnly(21, 0))
                        |> Result.defaultWith (fun _ -> failwith "the sample time must have minute precision")
                }
            |> Result.defaultWith (fun _ -> failwith "unreachable")

        let schedule = Fixed(Interval interval)

        MeetupCommands.create source firstEvent (MeetupId meetupId) MeetupCommands.administrator
        |> ignore

        let result =
            MeetupCommands.setSchedule source secondEvent (MeetupId meetupId) schedule

        let stored =
            MeetupStore.load source (MeetupId meetupId)
            |> MeetupCommands.run

        let columns = MeetupCommands.scheduleOf dsn meetupId

        let expected =
            "fixed",
            Some "interval",
            Some(DateOnly(2026, 10, 3)),
            Some(TimeOnly(18, 30)),
            Some(DateOnly(2026, 10, 3)),
            Some(TimeOnly(21, 0))

        test <@ MeetupCommands.versionIn result = Some 2L @>

        test
            <@
                stored
                |> Option.map (fun snapshot -> snapshot.Schedule) = Some schedule
            @>

        test <@ columns = expected @>

    /// Сходка, у которой дату убрали, обязана оставить колонки пустыми: `no_date` с
    /// заполненной границей схема отвергает, и обратный путь тоже должен давать
    /// NoDate, а не форму с осиротевшими значениями.
    [<Fact>]
    member _.``A schedule set back to no date clears every boundary column``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        MeetupCommands.create source firstEvent (MeetupId meetupId) MeetupCommands.administrator
        |> ignore

        MeetupCommands.setSchedule source secondEvent (MeetupId meetupId) (Tentative(Day(DateOnly(2026, 10, 3))))
        |> ignore

        MeetupCommands.setSchedule source thirdEvent (MeetupId meetupId) NoDate
        |> ignore

        let stored =
            MeetupStore.load source (MeetupId meetupId)
            |> MeetupCommands.run

        let columns = MeetupCommands.scheduleOf dsn meetupId

        test
            <@
                stored
                |> Option.map (fun snapshot -> snapshot.Schedule) = Some NoDate
            @>

        test <@ columns = ("no_date", None, None, None, None, None) @>

    /// Идентификатор события выдаёт оболочка, а не SQL. Сравнение именно с выданным
    /// значением ловит `gen_random_uuid()` в запросе и вторую генерацию: повторное
    /// чтение журнала само по себе их не различает.
    [<Fact>]
    member _.``The journal keeps the event identifier the shell generated``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        MeetupCommands.create source firstEvent (MeetupId meetupId) MeetupCommands.administrator
        |> ignore

        MeetupCommands.change source secondEvent (MeetupId meetupId)
        |> ignore

        let firstRead = MeetupCommands.journalIds dsn meetupId
        let secondRead = MeetupCommands.journalIds dsn meetupId

        test <@ firstRead = [ firstEvent; secondEvent ] @>
        test <@ secondRead = firstRead @>

    /// Версия события и версия состояния — одно число: на этом держится порядок
    /// публикации внутри сходки, и разойтись они не могут даже на один шаг.
    [<Fact>]
    member _.``Each event carries the version its state reached``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        MeetupCommands.create source firstEvent (MeetupId meetupId) MeetupCommands.administrator
        |> ignore

        MeetupCommands.change source secondEvent (MeetupId meetupId)
        |> ignore

        test <@ MeetupCommands.versionOf dsn meetupId = 2L @>
        test <@ MeetupCommands.eventsAheadOfState dsn meetupId = 0L @>

    /// Цикл «опубликовать, снять, вернуть» против настоящей схемы. Миграция 004
    /// добавила три повода в `meetup_events_type_check`, а
    /// `meetups_visible_has_first_publication` держит пару «видима — отметка стоит»:
    /// оба ограничения проверяет база, и строка с незнакомым поводом не запишется
    /// вовсе. Отметка первой публикации обязана пережить весь цикл — задним числом
    /// её не восстановить.
    [<Fact>]
    member _.``Unpublishing and returning a meetup keeps its first publication``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        MeetupCommands.create source firstEvent (MeetupId meetupId) MeetupCommands.administrator
        |> ignore

        MeetupCommands.change source secondEvent (MeetupId meetupId)
        |> ignore

        MeetupCommands.publish source thirdEvent (MeetupId meetupId)
        |> ignore

        MeetupCommands.unpublish source fourthEvent (MeetupId meetupId)
        |> ignore

        let returned = MeetupCommands.publish source fifthEvent (MeetupId meetupId)

        let stored =
            MeetupStore.load source (MeetupId meetupId)
            |> MeetupCommands.run

        let axes =
            stored
            |> Option.map (fun snapshot -> snapshot.Visibility, snapshot.FirstPublishedAt)

        let expected =
            [
                "meetup_created"
                "meetup_changed"
                "meetup_published"
                "meetup_unpublished"
                "meetup_republished"
            ]

        test <@ MeetupCommands.versionIn returned = Some 5L @>
        test <@ axes = Some(Visible, Some MeetupCommands.now) @>
        test <@ MeetupCommands.eventTypes dsn meetupId = expected @>

    /// Оси независимы, и это свойство обязано пережить запись: отменённая строка
    /// остаётся видимой. Проверяет его база — `meetups_lifecycle_check` принимает
    /// `cancelled`, а видимость при этом не трогает ни одно ограничение, поэтому
    /// реализация, прячущая отменённую сходку, прошла бы схему молча.
    [<Fact>]
    member _.``Cancelling a visible meetup leaves the stored row visible``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        MeetupCommands.create source firstEvent (MeetupId meetupId) MeetupCommands.administrator
        |> ignore

        MeetupCommands.change source secondEvent (MeetupId meetupId)
        |> ignore

        MeetupCommands.publish source thirdEvent (MeetupId meetupId)
        |> ignore

        let cancelled = MeetupCommands.cancel source fourthEvent (MeetupId meetupId)

        let stored =
            MeetupStore.load source (MeetupId meetupId)
            |> MeetupCommands.run

        let axes =
            stored
            |> Option.map (fun snapshot -> snapshot.Lifecycle, snapshot.Visibility)

        let types = MeetupCommands.eventTypes dsn meetupId

        test <@ MeetupCommands.versionIn cancelled = Some 4L @>
        test <@ axes = Some(Cancelled, Visible) @>
        test <@ List.last types = "meetup_cancelled" @>

    /// Регистрация источника в composition root и сборка зависимостей среза: без
    /// этого теста они существуют только в расчёте на будущий диспетчер, и первая
    /// же опечатка в имени переменной окружения обнаружилась бы на живом сервисе.
    [<Fact>]
    member _.``The host composes slice dependencies from its own registration``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString

        // use, а не let: приложение держит singleton NpgsqlDataSource, и его пул
        // соединений обязан закрыться раньше, чем изолированная база будет удалена.
        use app =
            Meetups.Host.build
                [|
                    "--urls=http://127.0.0.1:0"
                    $"--{Meetups.Migrations.DatabaseUrlVariable}={dsn}"
                    $"--{Meetups.Infrastructure.CommunityTime.TimeZoneVariable}=Europe/Moscow"
                |]

        let deps = Meetups.Slices.CreateMeetupDraft.Composition.buildDeps app.Services

        let created =
            Meetups.Slices.CreateMeetupDraft.execute
                deps
                {
                    Id = MeetupId meetupId
                    Viewer = MeetupCommands.administrator
                }
            |> MeetupCommands.run

        test <@ MeetupCommands.versionIn created = Some 1L @>
        test <@ MeetupCommands.countEvents dsn meetupId = 1L @>

    /// Редактирование после публикации (PER-196) проверяется на настоящей базе,
    /// потому что рискует здесь не домен, а схема: UPDATE идёт по видимой строке
    /// под `meetups_visible_has_first_publication`, и отметка первой публикации
    /// обязана пережить обе команды изменения. Мок адаптера этого не опроверг бы.
    [<Fact>]
    member _.``Editing a published meetup keeps it visible and advances the version``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        MeetupCommands.create source firstEvent (MeetupId meetupId) MeetupCommands.administrator
        |> ignore

        MeetupCommands.change source secondEvent (MeetupId meetupId)
        |> ignore

        MeetupCommands.publish source thirdEvent (MeetupId meetupId)
        |> ignore

        // Атрибуты заменяются целиком и отличаются от опубликованных: повтор тех же
        // значений проверял бы только запись, но не саму правку сведений.
        let renamed: Meetups.Slices.ChangeMeetupAttributes.Command =
            {
                Id = MeetupId meetupId
                Viewer = MeetupCommands.administrator
                Attributes =
                    { MeetupCommands.attributes with
                        Title = "F# after hours, второй заход"
                        Venue = "Тбилиси, Impact Hub"
                    }
            }

        Meetups.Slices.ChangeMeetupAttributes.execute (MeetupCommands.changeDeps source fourthEvent) renamed
        |> MeetupCommands.run
        |> ignore

        let rescheduled =
            MeetupCommands.setSchedule source fifthEvent (MeetupId meetupId) (Fixed(Day(DateOnly(2026, 11, 14))))

        let stored =
            MeetupStore.load source (MeetupId meetupId)
            |> MeetupCommands.run

        let actual =
            stored
            |> Option.map (fun snapshot ->
                snapshot.Title, snapshot.Venue, snapshot.Schedule, snapshot.Visibility, snapshot.FirstPublishedAt
            )

        test
            <@
                actual = Some(
                    "F# after hours, второй заход",
                    "Тбилиси, Impact Hub",
                    Fixed(Day(DateOnly(2026, 11, 14))),
                    Visible,
                    Some MeetupCommands.now
                )
            @>

        test <@ MeetupCommands.versionIn rescheduled = Some 5L @>
        test <@ MeetupCommands.countEvents dsn meetupId = 5L @>

        test
            <@
                MeetupCommands.journalIds dsn meetupId = [
                    firstEvent
                    secondEvent
                    thirdEvent
                    fourthEvent
                    fifthEvent
                ]
            @>

    /// Прикрепление материала пишет пару «состояние и событие» той же транзакцией,
    /// что и остальные команды: у строки сходки и у строки журнала один `xmin`.
    [<Fact>]
    member _.``Attaching a material writes state and event in one transaction``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        MeetupCommands.create source firstEvent (MeetupId meetupId) MeetupCommands.administrator
        |> ignore

        MeetupCommands.attach source secondEvent (MeetupId meetupId) MeetupCommands.materialId "Афиша" (FileId "file-1")
        |> ignore

        let stateTransaction = MeetupCommands.transactionOf dsn "meetups" "id" meetupId
        let eventTransaction = MeetupCommands.eventTransactionOf dsn secondEvent

        test <@ stateTransaction = eventTransaction @>

    /// Критерий приёмки сформулирован про обе команды, поэтому атомарность удаления
    /// проверяется отдельно, а не считается следствием общего `commit`.
    [<Fact>]
    member _.``Removing a material writes state and event in one transaction``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        MeetupCommands.create source firstEvent (MeetupId meetupId) MeetupCommands.administrator
        |> ignore

        MeetupCommands.attach source secondEvent (MeetupId meetupId) MeetupCommands.materialId "Афиша" (FileId "file-1")
        |> ignore

        MeetupCommands.remove source thirdEvent (MeetupId meetupId) MeetupCommands.materialId
        |> ignore

        let stateTransaction = MeetupCommands.transactionOf dsn "meetups" "id" meetupId
        let eventTransaction = MeetupCommands.eventTransactionOf dsn thirdEvent

        test <@ stateTransaction = eventTransaction @>

    /// Порядок коллекции живёт в строке состояния, а не в памяти процесса: новый
    /// источник соединений на ту же базу видит ту же последовательность и те же
    /// позиции. Иначе «порядок воспроизводится после перезапуска» ничем не держится.
    [<Fact>]
    member _.``The material order survives a fresh data source``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString

        do
            use source = MeetupCommands.source dsn

            MeetupCommands.create source firstEvent (MeetupId meetupId) MeetupCommands.administrator
            |> ignore

            MeetupCommands.attach
                source
                secondEvent
                (MeetupId meetupId)
                MeetupCommands.materialId
                "Первая"
                (MessageLink "https://t.me/solguficky/42")
            |> ignore

            MeetupCommands.attach
                source
                thirdEvent
                (MeetupId meetupId)
                MeetupCommands.otherMaterialId
                "Вторая"
                (FileId "file-2")
            |> ignore

        use fresh = MeetupCommands.source dsn

        let restored =
            MeetupStore.load fresh (MeetupId meetupId)
            |> MeetupCommands.run

        let actual =
            restored
            |> Option.map (fun snapshot ->
                snapshot.Materials
                |> List.map (fun material -> material.Id, material.Position)
            )

        test
            <@
                actual = Some
                    [
                        MeetupCommands.materialId, 1
                        MeetupCommands.otherMaterialId, 2
                    ]
            @>

    /// Удаление материала не трогает остальную коллекцию: сосед остаётся тем же
    /// материалом с той же позицией, а сам оригинал — сообщение или файл — продукт
    /// не хранит вовсе, поэтому удалять нечего.
    [<Fact>]
    member _.``Removing a material leaves the rest of the collection in place``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        MeetupCommands.create source firstEvent (MeetupId meetupId) MeetupCommands.administrator
        |> ignore

        MeetupCommands.attach
            source
            secondEvent
            (MeetupId meetupId)
            MeetupCommands.materialId
            "Первая"
            (MessageLink "https://t.me/solguficky/42")
        |> ignore

        MeetupCommands.attach
            source
            thirdEvent
            (MeetupId meetupId)
            MeetupCommands.otherMaterialId
            "Вторая"
            (FileId "file-2")
        |> ignore

        let removed =
            MeetupCommands.remove source fourthEvent (MeetupId meetupId) MeetupCommands.materialId

        let stored =
            MeetupStore.load source (MeetupId meetupId)
            |> MeetupCommands.run

        let remaining =
            stored
            |> Option.map (fun snapshot -> snapshot.Materials)

        let expected =
            {
                Id = MeetupCommands.otherMaterialId
                Position = 2
                Title = "Вторая"
                Source = FileId "file-2"
                BoundBy = MeetupCommands.author
            }

        test <@ remaining = Some [ expected ] @>
        test <@ MeetupCommands.versionIn removed = Some 4L @>
        test <@ MeetupCommands.countEvents dsn meetupId = 4L @>

        test
            <@
                MeetupCommands.eventTypes dsn meetupId = [
                    "meetup_created"
                    "meetup_material_attached"
                    "meetup_material_attached"
                    "meetup_material_removed"
                ]
            @>

    /// Идентификатор материала — ключ идемпотентности: повтор не плодит второй
    /// материал, не двигает версию и не пишет событие.
    [<Fact>]
    member _.``A repeated attachment writes nothing``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        MeetupCommands.create source firstEvent (MeetupId meetupId) MeetupCommands.administrator
        |> ignore

        let first =
            MeetupCommands.attach
                source
                secondEvent
                (MeetupId meetupId)
                MeetupCommands.materialId
                "Афиша"
                (FileId "file-1")

        let repeat =
            MeetupCommands.attach
                source
                thirdEvent
                (MeetupId meetupId)
                MeetupCommands.materialId
                "Другое название"
                (MessageLink "https://t.me/solguficky/42")

        let stored =
            MeetupStore.load source (MeetupId meetupId)
            |> MeetupCommands.run

        test <@ first = repeat @>
        test <@ MeetupCommands.versionIn repeat = Some 2L @>
        test <@ MeetupCommands.countEvents dsn meetupId = 2L @>

        test
            <@
                stored
                |> Option.map (fun snapshot -> snapshot.Materials.Length) = Some 1
            @>
