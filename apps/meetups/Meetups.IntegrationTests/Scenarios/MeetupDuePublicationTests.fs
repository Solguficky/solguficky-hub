/// Отложенная публикация против настоящего PostgreSQL. Здесь только то, на что
/// отвечает база: попадание строки в набор по предикату выборки, атомарность перехода
/// под двумя претендентами, очистка поля вместе со сменой видимости и ограничения
/// схемы, которые доменный тест увидеть не может.
///
/// Решение тика — что пропускается, где пачка продолжается, состав отчёта и записи —
/// проверено на L0 и сюда не дублируется.
namespace Meetups.IntegrationTests.Scenarios

open System
open Meetups.Domain
open Meetups.IntegrationTests.Infrastructure
open Meetups.Slices.PublishDueMeetups
open Npgsql
open Swensen.Unquote
open Xunit

module private DuePublication =
    let meetupId = Guid.Parse "0199c0de-0000-7000-8001-000000000001"

    let otherMeetupId = Guid.Parse "0199c0de-0000-7000-8001-000000000002"

    let eventId (n: int) = Guid.Parse("0199c0de-0000-7000-8000-" + n.ToString "D12")

    let batchSize = 10

    /// Локальная пара «дата и время» в поясе сообщества и то же мгновение в UTC.
    /// Оба значения фиксированы: часы машины в сценарий не входят ни на одной стороне,
    /// потому что момент назначения сравнивается с `MeetupCommands.now`, а момент
    /// срабатывания задаёт сам тест.
    let localMoment = MeetupCommands.localMoment 2026 10 5 19 0

    let moment = DateTimeOffset(2026, 10, 5, 16, 0, 0, TimeSpan.Zero)

    let before = moment.AddMinutes -1.0

    let after = moment.AddMinutes 1.0

    /// Скрытая сходка с заголовком и назначенным моментом: состояние, из которого
    /// публикация разрешена, а момент ждёт своего тика.
    let scheduled (source: NpgsqlDataSource) (id: Guid) (first: int) =
        MeetupCommands.create source (eventId first) (MeetupId id) MeetupCommands.administrator
        |> ignore

        MeetupCommands.change source (eventId (first + 1)) (MeetupId id)
        |> ignore

        MeetupCommands.schedulePublication source (eventId (first + 2)) (MeetupId id) localMoment
        |> ignore

type MeetupDuePublicationTests() =

    /// Головной критерий: наступивший момент публикует сходку, и поле очищается тем же
    /// переходом, а не отдельным запросом.
    [<Fact>]
    member _.``A meetup whose moment has come is published and gives the moment up``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        DuePublication.scheduled source DuePublication.meetupId 1

        test <@ MeetupCommands.scheduledPublicationIsSet dsn DuePublication.meetupId @>

        let report =
            DuePublicationReader.runTickAt source DuePublication.after DuePublication.batchSize

        test <@ report.Published = 1 @>
        test <@ MeetupCommands.visibilityOf dsn DuePublication.meetupId = "visible" @>
        test <@ not (MeetupCommands.scheduledPublicationIsSet dsn DuePublication.meetupId) @>

    /// Тот же повод, что у ручной публикации, и никакого нового типа события
    /// (ADR-024). Имя повода принимает не код, а `meetup_events_type_check`.
    [<Fact>]
    member _.``A deferred publication records the same occasion a manual one records``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        DuePublication.scheduled source DuePublication.meetupId 1

        DuePublicationReader.runTickAt source DuePublication.after DuePublication.batchSize
        |> ignore

        let occasions = MeetupCommands.eventTypes dsn DuePublication.meetupId

        test <@ List.last occasions = "meetup_published" @>

    /// Исполнителя-человека у публикации, начатой часами, нет, и журнал этого не
    /// выдумывает.
    [<Fact>]
    member _.``The journal records the clock as the performer, not a person``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        DuePublication.scheduled source DuePublication.meetupId 1

        DuePublicationReader.runTickAt source DuePublication.after DuePublication.batchSize
        |> ignore

        let performers = MeetupCommands.performers dsn DuePublication.meetupId

        test <@ List.last performers = Guid.Empty @>

        test
            <@
                performers
                |> List.take (List.length performers - 1)
                |> List.forall (fun id -> id <> Guid.Empty)
            @>

    /// Момент ещё не наступил — сходка не попадает в набор вовсе, и это свойство
    /// предиката выборки, а не ветки в коде.
    [<Fact>]
    member _.``A moment that has not come leaves the meetup alone``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        DuePublication.scheduled source DuePublication.meetupId 1

        let report =
            DuePublicationReader.runTickAt source DuePublication.before DuePublication.batchSize

        test <@ report.Backlog.Due = 0L && report.Published = 0 @>
        test <@ MeetupCommands.visibilityOf dsn DuePublication.meetupId = "hidden" @>
        test <@ MeetupCommands.scheduledPublicationIsSet dsn DuePublication.meetupId @>

    /// Критерий приёмки «два параллельных экземпляра публикуют сходку один раз».
    ///
    /// Соперник — второй полный тик, исполненный между выборкой первого и его записью.
    /// Это и есть окно гонки; вне его два экземпляра разойдутся сами. Проигрывает тот,
    /// чья ожидаемая версия устарела, и решает это предикат записи, а не порядок
    /// потоков: в сценарии их по-прежнему один.
    [<Fact>]
    member _.``Two instances racing for the same meetup publish it once, not twice``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        DuePublication.scheduled source DuePublication.meetupId 1

        let versionBefore = MeetupCommands.versionOf dsn DuePublication.meetupId

        let rival () =
            DuePublicationReader.runTickAt source DuePublication.after DuePublication.batchSize
            |> ignore

        let report =
            DuePublicationReader.runTickInterleaved source DuePublication.after DuePublication.batchSize rival

        // Соперник успел первым, поэтому проиграл тот тик, у которого снимок устарел.
        test <@ report.Published = 0 && report.Claimed = 1 @>

        let occasions =
            MeetupCommands.eventTypes dsn DuePublication.meetupId
            |> List.filter (fun occasion -> occasion = "meetup_published")

        test <@ List.length occasions = 1 @>
        test <@ MeetupCommands.versionOf dsn DuePublication.meetupId = versionBefore + 1L @>
        test <@ MeetupCommands.visibilityOf dsn DuePublication.meetupId = "visible" @>

    /// Критерий приёмки «отменённая после назначения сходка не публикуется и не
    /// оставляет поле заполненным» в самой острой форме: отмена приходит после того,
    /// как тик уже забрал сходку в пачку.
    [<Fact>]
    member _.``A meetup cancelled after the scan is not published and keeps no moment``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        DuePublication.scheduled source DuePublication.meetupId 1

        let rival () =
            MeetupCommands.cancel source (DuePublication.eventId 9) (MeetupId DuePublication.meetupId)
            |> ignore

        let report =
            DuePublicationReader.runTickInterleaved source DuePublication.after DuePublication.batchSize rival

        test <@ report.Published = 0 && report.Claimed = 1 @>
        test <@ MeetupCommands.visibilityOf dsn DuePublication.meetupId = "hidden" @>
        test <@ not (MeetupCommands.scheduledPublicationIsSet dsn DuePublication.meetupId) @>

        test
            <@
                MeetupCommands.eventTypes dsn DuePublication.meetupId
                |> List.contains "meetup_published"
                |> not
            @>

    /// Отменённая сходка в набор не попадает вовсе: применение отмены обнуляет момент,
    /// а `meetups_scheduled_publish_not_cancelled` делает обратную строку невыразимой.
    /// Отдельной ветки «пропустить отменённую» в коде поэтому нет, и проверять здесь
    /// нужно именно набор.
    [<Fact>]
    member _.``A cancelled meetup is not in the set at all``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        DuePublication.scheduled source DuePublication.meetupId 1

        MeetupCommands.cancel source (DuePublication.eventId 9) (MeetupId DuePublication.meetupId)
        |> ignore

        let report =
            DuePublicationReader.runTickAt source DuePublication.after DuePublication.batchSize

        test <@ report.Backlog.Due = 0L && report.Published = 0 @>

    /// Критерий приёмки «рестарт сервиса до срабатывания не теряет назначенный
    /// момент». Момент живёт в строке, и в памяти воркера состояния нет по построению,
    /// поэтому свежий источник соединений — достаточная модель перезапуска.
    [<Fact>]
    member _.``A moment set before a restart survives it``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString

        use before = MeetupCommands.source dsn
        DuePublication.scheduled before DuePublication.meetupId 1

        use after = MeetupCommands.source dsn

        let report =
            DuePublicationReader.runTickAt after DuePublication.after DuePublication.batchSize

        test <@ report.Published = 1 @>
        test <@ MeetupCommands.visibilityOf dsn DuePublication.meetupId = "visible" @>

    /// Критерий приёмки «по логам или метрикам видно, что набор не растёт»: сами числа
    /// приходят из базы, и подтвердить их может только она.
    [<Fact>]
    member _.``The tick reports the size of the set and the age of its oldest moment``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        DuePublication.scheduled source DuePublication.meetupId 1
        DuePublication.scheduled source DuePublication.otherMeetupId 4

        let observedAt = DuePublication.moment.AddMinutes 5.0

        let report =
            DuePublicationReader.runTickAt source observedAt DuePublication.batchSize

        test <@ report.Backlog.Due = 2L @>
        test <@ report.Backlog.OldestDueAt = Some DuePublication.moment @>
        test <@ report.OldestDueAge = Some(TimeSpan.FromMinutes 5.0) @>
        test <@ report.Published = 2 @>

    /// Сходка, снятая с публикации и получившая новый момент, публикуется возвратом.
    /// Сценарий живёт здесь, а не только в домене: до PER-204 он упирался в
    /// `meetups_scheduled_publish_only_when_hidden`, то есть в ограничение схемы, а
    /// доменный тест такого отказа не видит.
    [<Fact>]
    member _.``A meetup unpublished and scheduled again is republished without breaking the schema``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn

        DuePublication.scheduled source DuePublication.meetupId 1

        DuePublicationReader.runTickAt source DuePublication.after DuePublication.batchSize
        |> ignore

        MeetupCommands.unpublish source (DuePublication.eventId 9) (MeetupId DuePublication.meetupId)
        |> ignore

        MeetupCommands.schedulePublication
            source
            (DuePublication.eventId 10)
            (MeetupId DuePublication.meetupId)
            DuePublication.localMoment
        |> ignore

        let report =
            DuePublicationReader.runTickAt source DuePublication.after DuePublication.batchSize

        test <@ report.Published = 1 @>
        test <@ MeetupCommands.visibilityOf dsn DuePublication.meetupId = "visible" @>
        test <@ not (MeetupCommands.scheduledPublicationIsSet dsn DuePublication.meetupId) @>
