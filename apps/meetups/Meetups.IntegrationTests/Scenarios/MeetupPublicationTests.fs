/// Публикация из журнала в настоящий JetStream: команда пишет событие, тик
/// продуктового среза отдаёт его адаптеру, и сообщение читается из стрима. Здесь
/// только то, на что отвечает брокер, — ack, дедупликация по `Nats-Msg-Id`, отказ
/// при отсутствии стрима и при замершем сервере. Классы отказов и раскладка конверта
/// проверены на L0 и сюда не дублируются.
namespace Meetups.IntegrationTests.Scenarios

open System
open Meetups.Domain
open Meetups.IntegrationTests.Infrastructure
open Meetups.Slices.DispatchMeetupEvents
open Meetups.Transport
open Swensen.Unquote
open Xunit

module private Publication =
    let meetupId = MeetupId(Guid.Parse "0199c0de-0000-7000-8001-0000000000c1")
    let created = Guid.Parse "0199c0de-0000-7000-8000-0000000000c1"
    let changed = Guid.Parse "0199c0de-0000-7000-8000-0000000000c2"
    let batchSize = 10

    /// Предел ack короче значения по умолчанию: сценарий паузы ждёт отказа, и
    /// секунда достаточна, чтобы живой брокер ответил, а замерший — нет.
    let publisher (broker: NatsBroker.Broker) =
        NatsEventPublisher.publish (NatsEventPublisher.ofContext broker.Context) (TimeSpan.FromSeconds 1.0)

    let decode (body: byte[]) = Meetups.V1.MeetupEvent.Parser.ParseFrom body

/// Сценарии делят один брокер и один стрим, поэтому идут последовательно: xUnit не
/// распараллеливает тесты одного класса, а пауза брокера в соседнем классе уронила
/// бы чужие публикации.
type MeetupPublicationTests(nats: NatsBroker.Container) =
    interface IClassFixture<NatsBroker.Container>


    [<Fact>]
    member _.``An event written by a command reaches the stream in the contract form``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn
        use broker = new NatsBroker.Broker(nats)

        MeetupCommands.create source Publication.created Publication.meetupId MeetupCommands.administrator
        |> ignore

        let report =
            DispatchReader.runTickWith source (Publication.publisher broker) Publication.batchSize
            |> DispatchReader.reportOf

        let messages = broker.Messages()
        let body, msgId = List.exactlyOne messages
        let message = Publication.decode body

        test
            <@
                report.Published = 1
                && report.Declined = None
                && msgId = Publication.created.ToString "D"
                && message.EventId = msgId
                && message.OccasionCase = Meetups.V1.MeetupEvent.OccasionOneofCase.MeetupCreated
                && message.Version = 1L
                && message.State.Author = "0199c0de-0000-7000-8000-00000000000a"
                && DispatchScenario.pendingEvents dsn = []
            @>

    /// Сервер, который не подтвердил публикацию, не даёт отметки: строка остаётся
    /// pending, и следующий тик приходит к ней с тем же `event_id`.
    [<Fact>]
    member _.``A publication the stream does not acknowledge leaves the row pending``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn
        use broker = new NatsBroker.Broker(nats)

        MeetupCommands.create source Publication.created Publication.meetupId MeetupCommands.administrator
        |> ignore

        broker.DropStream()

        let report =
            DispatchReader.runTickWith source (Publication.publisher broker) Publication.batchSize
            |> DispatchReader.reportOf

        test
            <@
                report.Published = 0
                && report.Declined |> Option.map _.EventId = Some Publication.created
                && DispatchScenario.pendingEvents dsn = [ Publication.created ]
            @>

    /// Критерий «остановленный NATS»: пока брокер молчит, записи остаются pending и
    /// тик не висит дольше предела попытки; после возвращения они уходят с теми же
    /// `event_id`, и в стриме каждое лежит один раз — повтор попытки, которую сервер
    /// принял за паузу, отсекает дедупликация по `Nats-Msg-Id`.
    [<Fact>]
    member _.``Events written while the broker is frozen go out once with the same ids after it returns``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn
        use broker = new NatsBroker.Broker(nats)
        let publish = Publication.publisher broker

        MeetupCommands.create source Publication.created Publication.meetupId MeetupCommands.administrator
        |> ignore

        MeetupCommands.change source Publication.changed Publication.meetupId
        |> ignore

        broker.Pause()

        let frozen =
            try
                DispatchReader.runTickWith source publish Publication.batchSize
                |> DispatchReader.reportOf
            finally
                broker.Unpause()

        let pendingWhileFrozen = DispatchScenario.pendingEvents dsn

        // Клиенту нужно время вернуться к серверу: соединение пережило паузу, но
        // первый ответ после неё приходит не мгновенно. Повторы — это тики, ровно
        // как в продукте, а не отдельная логика теста.
        let rec drain attempts =
            let report =
                DispatchReader.runTickWith source publish Publication.batchSize
                |> DispatchReader.reportOf

            if report.Declined.IsSome && attempts > 1 then
                Threading.Thread.Sleep 500
                drain (attempts - 1)

        drain 20

        let ids = broker.Messages() |> List.map snd

        test
            <@
                frozen.Published = 0
                && frozen.Declined |> Option.map _.EventId = Some Publication.created
                && pendingWhileFrozen = [
                    Publication.created
                    Publication.changed
                ]
                && ids = [
                    Publication.created.ToString "D"
                    Publication.changed.ToString "D"
                ]
                && DispatchScenario.pendingEvents dsn = []
            @>
