/// Состав записи фоновой границы. Каркас из docs/standards/observability/logging.md
/// проверяется по именам полей, а не по отформатированному тексту, и без хоста: то,
/// что поля обязаны быть именно такими, — требование норматива, а не свойство цикла.
module Meetups.OutboxDispatchLogTests

open System
open System.Threading
open System.Threading.Tasks
open Meetups
open Meetups.Slices.DispatchMeetupEvents
open Meetups.Transport
open Microsoft.Extensions.Logging
open Swensen.Unquote
open Xunit

let private duration = 1234L

let private eventId = Guid.Parse "0199c0de-0000-7000-8000-000000000001"

let private meetupId = Guid.Parse "0199c0de-0000-7000-8001-000000000001"

let private report pending age published declined cancelled =
    {
        Backlog =
            {
                Pending = pending
                OldestOccurredAt = None
            }
        OldestPendingAge = age
        Published = published
        Repeats = 0
        Declined = declined
        Cancelled = cancelled
    }

let private decline =
    Some
        {
            EventId = eventId
            MeetupId = meetupId
            RequestId = RequestId.create "req-declined"
            Reason = "nats is unreachable"
        }

let private described outcome =
    let level, fields = OutboxDispatchLog.describe outcome duration

    level,
    fields
    |> List.map (fun (name, value) -> name, string value)
    |> Map.ofList

[<Fact>]
let ``A tick that published carries the frame of an operation`` () =
    let level, fields =
        described (TickOutcome.Ran(report 3L (Some(TimeSpan.FromSeconds 5.0)) 2 None false))

    test <@ level = LogLevel.Information @>
    test <@ fields.TryFind "service" = Some "meetups" @>
    test <@ fields.TryFind "operation" = Some OutboxDispatchLog.Operation @>
    test <@ fields.TryFind "result" = Some "ok" @>
    test <@ fields.TryFind "duration_us" = Some "1234" @>

[<Fact>]
let ``A tick nobody started carries neither a use case nor a request id`` () =
    let _, fields = described (TickOutcome.Ran(report 0L None 0 None false))

    // Периодическая фоновая работа — операция без сценария: `use_case` отсутствует,
    // а не заполняется заглушкой. Цепочки у тика тоже нет, поэтому `request_id`
    // опущен, а не придуман на месте.
    test <@ fields.ContainsKey "use_case" = false @>
    test <@ fields.ContainsKey "request_id" = false @>

[<Fact>]
let ``A tick reports the backlog it saw and what it managed to publish`` () =
    let _, fields =
        described (TickOutcome.Ran(report 9L (Some(TimeSpan.FromSeconds 90.0)) 4 None false))

    test <@ fields.TryFind "pending" = Some "9" @>
    test <@ fields.TryFind "published" = Some "4" @>
    test <@ fields.TryFind "oldest_pending_age_us" = Some "90000000" @>

[<Fact>]
let ``An empty backlog omits the age instead of calling it zero`` () =
    let _, fields = described (TickOutcome.Ran(report 0L None 0 None false))

    // Ноль означал бы «запись есть, и ей ноль секунд»: пустая очередь стала бы
    // неотличима от свежей ровно на том графике, ради которого поле и заведено.
    test <@ fields.TryFind "pending" = Some "0" @>
    test <@ fields.ContainsKey "oldest_pending_age_us" = false @>

[<Fact>]
let ``A declined publication is a warning about an unavailable dependency`` () =
    let level, fields = described (TickOutcome.Ran(report 3L None 1 decline false))

    test <@ level = LogLevel.Warning @>
    test <@ fields.TryFind "result" = Some "error" @>
    test <@ fields.TryFind "error_category" = Some "dependency_unavailable" @>
    test <@ fields.TryFind "error" = Some "nats is unreachable" @>
    test <@ fields.TryFind "event_id" = Some(string eventId) @>
    test <@ fields.TryFind "meetup_id" = Some(string meetupId) @>

[<Fact>]
let ``A declined publication carries no stack`` () =
    let _, fields = described (TickOutcome.Ran(report 3L None 1 decline false))

    // Отказ соседа — часть контракта, а не сбой сервиса: норматив держит stack для
    // неожиданного отказа, и недоступный NATS не должен выглядеть аварией.
    test <@ fields.ContainsKey "stack" = false @>

[<Fact>]
let ``A busy turn stays below information`` () =
    let level, fields = described TickOutcome.TurnBusy

    // Резервный экземпляр опрашивает ход каждые несколько секунд: на Information это
    // был бы поток записей ни о чём.
    test <@ level = LogLevel.Debug @>
    test <@ fields.TryFind "turn" = Some "busy" @>
    test <@ fields.TryFind "result" = Some "ok" @>

[<Fact>]
let ``A tick that published nothing stays below information`` () =
    let level, _ = described (TickOutcome.Ran(report 0L None 0 None false))

    test <@ level = LogLevel.Debug @>

[<Fact>]
let ``A tick stopped by shutdown says so`` () =
    let _, fields = described (TickOutcome.Ran(report 3L None 1 None true))

    test <@ fields.TryFind "cancelled" = Some "True" @>

[<Fact>]
let ``A tick without repeats omits the field instead of writing a zero`` () =
    let _, fields = described (TickOutcome.Ran(report 3L None 2 None false))

    // Поле, присутствующее с нулём в каждой записи, превращает запрос «были ли
    // повторы» в запрос по значению.
    test <@ fields.ContainsKey "repeats" = false @>

[<Fact>]
let ``An observed repeat is a warning about a successful tick`` () =
    let repeated =
        { report 3L None 2 None false with
            Repeats = 1
        }

    let level, fields = described (TickOutcome.Ran repeated)

    // Публикация состоялась, поэтому `ok`; но запись уехала вторым экземпляром, и
    // молча это выглядело бы как обычный успешный тик.
    test <@ level = LogLevel.Warning @>
    test <@ fields.TryFind "result" = Some "ok" @>
    test <@ fields.TryFind "repeats" = Some "1" @>

[<Fact>]
let ``An unexpected failure carries its category and its stack`` () =
    let broken =
        try
            raise (InvalidOperationException "the port broke")
        with exn ->
            exn

    let fields =
        OutboxDispatchLog.unexpected broken duration
        |> List.map (fun (name, value) -> name, string value)
        |> Map.ofList

    test <@ fields.TryFind "result" = Some "error" @>
    test <@ fields.TryFind "error_category" = Some "unexpected" @>
    test <@ fields.TryFind "error" = Some "the port broke" @>
    test <@ fields.ContainsKey "stack" @>

let private pending (requestId: RequestId option) =
    {
        EventId = eventId
        MeetupId = meetupId
        Version = 1L
        EventType = "meetup_created"
        Payload = "{}"
        PerformedBy = Guid.Empty
        OccurredAt = DateTimeOffset(2026, 9, 7, 12, 0, 0, TimeSpan.Zero)
        RequestId = requestId
    }

let private relayedFields (event: PendingEvent) =
    OutboxDispatchLog.relayed duration event
    |> List.map (fun (name, value) -> name, string value)
    |> Map.ofList

/// Критерий PER-227 «по идентификатору из кадра бота находится доменное событие»:
/// поиск по `request_id` находит запись о публикации, и она называет событие.
[<Fact>]
let ``A relayed event carries the request id of the chain it continues`` () =
    let fields = relayedFields (pending (RequestId.create "req-bot-frame"))

    test <@ fields.TryFind "request_id" = Some "req-bot-frame" @>
    test <@ fields.TryFind "event_id" = Some(string eventId) @>
    test <@ fields.TryFind "meetup_id" = Some(string meetupId) @>
    test <@ fields.TryFind "operation" = Some OutboxDispatchLog.Operation @>
    test <@ fields.TryFind "result" = Some "ok" @>
    test <@ fields.ContainsKey "duration_us" @>

/// Событие без id (вызов без заголовка, строка старше миграции 008) пишется без поля,
/// а не с пустой строкой и не с придуманным значением.
[<Fact>]
let ``A relayed event without a request id omits the field`` () =
    let fields = relayedFields (pending None)

    test <@ fields.ContainsKey "request_id" = false @>

[<Fact>]
let ``A declined publication names the chain it stalled`` () =
    let _, fields = described (TickOutcome.Ran(report 1L None 0 decline false))

    test <@ fields.TryFind "request_id" = Some "req-declined" @>

/// Порт, обёрнутый границей, вместе с записями, которые он оставил.
let private announced (answer: PublishOutcome) =
    let written = ResizeArray<(string * obj) list>()

    let publish =
        OutboxDispatchLog.announcing written.Add (fun _ _ -> Task.FromResult answer)

    let outcome =
        publish CancellationToken.None (pending (RequestId.create "req-bot-frame"))
        |> Async.AwaitTask
        |> Async.RunSynchronously

    outcome, List.ofSeq written

/// Запись пишется в момент подтверждения, а не из отчёта тика: отказ на следующем
/// событии уносит отчёт, а уже опубликованное событие без записи не нашлось бы.
[<Fact>]
let ``A confirmed publication is recorded the moment it is confirmed`` () =
    let outcome, written = announced PublishOutcome.Confirmed

    test <@ outcome = PublishOutcome.Confirmed @>

    test
        <@
            written
            |> List.map (
                Map.ofList
                >> Map.tryFind "request_id"
                >> Option.map string
            ) = [ Some "req-bot-frame" ]
        @>

[<Fact>]
let ``A declined publication leaves no relayed record`` () =
    let outcome, written = announced (PublishOutcome.Declined "nats is unreachable")

    test <@ outcome = PublishOutcome.Declined "nats is unreachable" @>
    test <@ written = [] @>
