/// Публикация из журнала против настоящего PostgreSQL. Здесь только то, на что
/// отвечает база: видимость поздно закоммиченной строки, взаимное исключение через
/// advisory-блокировку, отметка и её отсутствие, размеры бэклога.
///
/// Решение тика — порядок, правило остановки, состав отчёта — проверено на L0 и
/// сюда не дублируется.
namespace Meetups.IntegrationTests.Scenarios

open System
open Meetups.IntegrationTests.Infrastructure
open Npgsql
open Swensen.Unquote
open Xunit

module private Dispatch =
    let meetupId (n: int) = Guid.Parse("0199c0de-0000-7000-8001-" + n.ToString "D12")

    let eventId (n: int) = Guid.Parse("0199c0de-0000-7000-8000-" + n.ToString "D12")

    let occurredAt = DateTimeOffset(2026, 9, 7, 12, 0, 0, TimeSpan.Zero)

    let batchSize = 10

type MeetupDispatchTests() =

    [<Fact>]
    member _.``An event committed after the batch was read is published on the next turn``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = NpgsqlDataSource.Create dsn

        // Транзакция с меньшим `position` остаётся открытой, пока вторая коммитится.
        // Это и есть сценарий, из-за которого ADR-035 запретил high-water mark:
        // номер выдан при вставке, а строка появляется при коммите.
        use late = new CommandTransaction(dsn)
        let latePosition = late.Insert(Dispatch.meetupId 1, Dispatch.eventId 1)

        use early = new CommandTransaction(dsn)
        let earlyPosition = early.Insert(Dispatch.meetupId 2, Dispatch.eventId 2)
        early.Commit()

        let port = DispatchReader.confirming ()

        DispatchReader.runTick source port Dispatch.batchSize
        |> ignore

        late.Commit()

        DispatchReader.runTick source port Dispatch.batchSize
        |> ignore

        test <@ latePosition < earlyPosition @>

        test
            <@
                port.PublishedIds = [
                    Dispatch.eventId 2
                    Dispatch.eventId 1
                ]
            @>

    [<Fact>]
    member _.``A rival holding the turn leaves every pending row untouched``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = NpgsqlDataSource.Create dsn

        DispatchScenario.seedEvent dsn (Dispatch.meetupId 3) (Dispatch.eventId 3) Dispatch.occurredAt

        use rival = new DispatchReader.RivalTurn(dsn)

        // Без этой проверки сценарий был бы зелёным и на незахваченном замке: тик
        // просто не нашёл бы, что публиковать.
        test <@ rival.Held @>

        let port = DispatchReader.confirming ()
        let outcome = DispatchReader.runTick source port Dispatch.batchSize

        test <@ outcome = Meetups.Slices.DispatchMeetupEvents.TickOutcome.TurnBusy @>
        test <@ port.PublishedIds = [] @>
        test <@ DispatchScenario.pendingEvents dsn = [ Dispatch.eventId 3 ] @>

    [<Fact>]
    member _.``The turn is free again once the previous tick ended``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = NpgsqlDataSource.Create dsn

        DispatchScenario.seedEvent dsn (Dispatch.meetupId 4) (Dispatch.eventId 4) Dispatch.occurredAt

        let port = DispatchReader.confirming ()

        DispatchReader.runTick source port Dispatch.batchSize
        |> ignore

        // Утверждение об исходе, а не о механизме: ход свободен, кто бы его ни
        // отпустил — явный `unlock` или сброс сессии при возврате в пул. Тик, который
        // удержал бы соединение, сделал бы сервис одноразовым, и узнали бы об этом не
        // из прогона, а из остановившейся публикации.
        use rival = new DispatchReader.RivalTurn(dsn)

        test <@ rival.Held @>

    [<Fact>]
    member _.``A confirmed publication stamps the row and drops it from the next batch``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = NpgsqlDataSource.Create dsn

        DispatchScenario.seedEvent dsn (Dispatch.meetupId 5) (Dispatch.eventId 5) Dispatch.occurredAt

        let before = DispatchScenario.readRecord dsn (Dispatch.eventId 5)

        let port = DispatchReader.confirming ()

        DispatchReader.runTick source port Dispatch.batchSize
        |> ignore

        let after = DispatchScenario.readRecord dsn (Dispatch.eventId 5)
        let mark = DispatchScenario.readDispatchMark dsn (Dispatch.eventId 5)

        let second = DispatchReader.confirming ()

        DispatchReader.runTick source second Dispatch.batchSize
        |> ignore

        test <@ mark |> Option.isSome @>
        // Сама запись события не сдвинулась. Отказ MT001 на попытку её тронуть уже
        // закреплён тестами схемы и здесь не дублируется.
        test <@ after = before @>
        test <@ DispatchScenario.pendingEvents dsn = [] @>
        test <@ second.PublishedIds = [] @>

    [<Fact>]
    member _.``A refused port leaves the row pending and the retry carries the same identifier``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = NpgsqlDataSource.Create dsn

        DispatchScenario.seedEvent dsn (Dispatch.meetupId 6) (Dispatch.eventId 6) Dispatch.occurredAt

        let refused = DispatchReader.declining "nats is unreachable"

        DispatchReader.runTick source refused Dispatch.batchSize
        |> ignore

        let mark = DispatchScenario.readDispatchMark dsn (Dispatch.eventId 6)
        let stillPending = DispatchScenario.pendingEvents dsn

        let retry = DispatchReader.confirming ()

        DispatchReader.runTick source retry Dispatch.batchSize
        |> ignore

        // Отметка не ставится без подтверждения — на L0 это закрыто типом, здесь
        // проверяется, что UPDATE действительно не выполнился.
        test <@ mark = None @>
        test <@ stillPending = [ Dispatch.eventId 6 ] @>
        test <@ retry.PublishedIds = [ Dispatch.eventId 6 ] @>

    [<Fact>]
    member _.``The backlog reports the count and the age of its oldest row``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = NpgsqlDataSource.Create dsn

        let oldest = Dispatch.occurredAt
        DispatchScenario.seedEvent dsn (Dispatch.meetupId 7) (Dispatch.eventId 7) oldest

        DispatchScenario.seedEvent dsn (Dispatch.meetupId 8) (Dispatch.eventId 8) (oldest + TimeSpan.FromMinutes 30.0)

        let port = DispatchReader.declining "nats is unreachable"

        let report =
            DispatchReader.runTick source port Dispatch.batchSize
            |> DispatchReader.reportOf

        // Возраст берётся от самой ранней записи и считается от часов процесса,
        // поэтому утверждение о нижней границе, а не о равенстве: точное значение
        // зависело бы от момента прогона.
        test <@ report.Backlog.Pending = 2L @>

        test
            <@
                report.OldestPendingAge
                |> Option.exists (fun age -> age >= TimeSpan.FromMinutes 30.0)
            @>

    [<Fact>]
    member _.``A batch never carries more rows than it was asked for``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = NpgsqlDataSource.Create dsn

        for n in 10..12 do
            DispatchScenario.seedEvent dsn (Dispatch.meetupId n) (Dispatch.eventId n) Dispatch.occurredAt

        let port = DispatchReader.confirming ()

        let report =
            DispatchReader.runTick source port 2
            |> DispatchReader.reportOf

        test <@ report.Published = 2 @>
        test <@ DispatchScenario.pendingEvents dsn = [ Dispatch.eventId 12 ] @>

    /// PER-227, критерий «цепочка не рвётся на задержке между командой и
    /// публикацией»: команда закоммичена, публикует её отдельный тик позже, и порт
    /// получает тот же id — прочитанный из строки журнала, а не из запроса, которого
    /// к этому моменту уже нет.
    [<Fact>]
    member _.``The relay hands the port the request id the command stored``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn
        let meetupId = Dispatch.meetupId 41

        MeetupCommands.createFrom
            source
            (Dispatch.eventId 41)
            (Meetups.Domain.MeetupId meetupId)
            MeetupCommands.administrator
            (Meetups.RequestId.create "req-bot-frame")
        |> ignore

        let port = DispatchReader.confirming ()

        DispatchReader.runTick source port Dispatch.batchSize
        |> ignore

        test
            <@
                port.Published
                |> List.map (fun event ->
                    event.EventId,
                    event.RequestId
                    |> Option.map Meetups.RequestId.value
                ) = [
                    Dispatch.eventId 41, Some "req-bot-frame"
                ]
            @>

    /// Строка без id (вызов без заголовка, запись старше миграции 008) уходит в порт
    /// без него, а не с пустой строкой.
    [<Fact>]
    member _.``A row without a request id reaches the port without one``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = NpgsqlDataSource.Create dsn

        DispatchScenario.seedEvent dsn (Dispatch.meetupId 42) (Dispatch.eventId 42) Dispatch.occurredAt

        let port = DispatchReader.confirming ()

        DispatchReader.runTick source port Dispatch.batchSize
        |> ignore

        test <@ port.Published |> List.map _.RequestId = [ None ] @>
