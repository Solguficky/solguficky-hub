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
