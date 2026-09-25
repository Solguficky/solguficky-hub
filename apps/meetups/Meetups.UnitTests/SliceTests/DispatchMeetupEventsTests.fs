/// Решение одного тика публикации: что уходит в порт, что отмечается, где тик
/// останавливается и что он рассказывает о себе. Базы здесь нет намеренно — всё, что
/// проверяется ниже, решает код, а не PostgreSQL, и поднимать ради этого контейнер
/// значило бы проверять самое дешёвое самым дорогим уровнем.
module Meetups.SliceTests.DispatchMeetupEventsTests

open System
open System.Threading
open System.Threading.Tasks
open Meetups
open Meetups.Slices.DispatchMeetupEvents
open Swensen.Unquote
open Xunit

/// Зависимость, которую тест не переопределил, обязана падать с внятным сообщением,
/// а не возвращать молчаливый успех: иначе тест на «порт не позван» проходил бы и на
/// реализации, которая его позвала и получила пустой ответ.
let private notReached (name: string) : 'a = failwith $"{name} must not be reached in this test"

let private now = DateTimeOffset(2026, 9, 7, 12, 0, 0, TimeSpan.Zero)

let private actor = Guid.Parse "0199c0de-0000-7000-8000-00000000000a"

/// Идентификаторы различаются только хвостом: в падении сразу видно, на какой записи
/// пачка разошлась с ожиданием.
let private eventId (n: int) = Guid.Parse("0199c0de-0000-7000-8000-" + n.ToString "D12")

let private meetupId (n: int) = Guid.Parse("0199c0de-0000-7000-8001-" + n.ToString "D12")

let private pendingEvent (n: int) (meetup: int) =
    {
        EventId = eventId n
        MeetupId = meetupId meetup
        Version = 1L
        EventType = "meetup_created"
        Payload = "{}"
        PerformedBy = actor
        OccurredAt = now
        RequestId = RequestId.create $"req-{n}"
        MaterialId = None
    }

let private backlog (pending: int64) (oldest: DateTimeOffset option) =
    {
        Pending = pending
        OldestOccurredAt = oldest
    }

/// Ход вместе со счётчиком освобождений: «тик отпустил ход» — утверждение о
/// поведении, и проверять его нужно наблюдением, а не верой в `finally`.
let private countingTurn () =
    let released = ref 0

    let turn =
        {
            Release = fun () -> task { released.Value <- released.Value + 1 }
        }

    turn, released

/// Часы и размер пачки — фиксированные значения, а не падающие заглушки: их вызов
/// ничего не наблюдает, и требовать от теста переопределять их означало бы шум в
/// каждом сценарии.
let private deps =
    {
        TakeTurn = fun () -> notReached "TakeTurn"
        ReadQueue = fun _ -> notReached "ReadQueue"
        Publish = fun _ _ -> notReached "Publish"
        MarkDispatched = fun _ _ -> notReached "MarkDispatched"
        Now = fun () -> now
        BatchSize = 10
    }

let private holding (turn: Turn) (pending: PendingEvent list) (observed: Backlog) =
    { deps with
        TakeTurn = fun () -> Task.FromResult(Some turn)
        ReadQueue = fun _ -> Task.FromResult(observed, pending)
    }

let private run deps (token: CancellationToken) =
    execute deps token
    |> Async.AwaitTask
    |> Async.RunSynchronously

/// `Async.RunSynchronously` заворачивает отказ в AggregateException, поэтому
/// утверждение о причине берёт самое внутреннее исключение, а не обёртку раннера.
let private causeOf (error: exn) = error.GetBaseException()

let private reportOf outcome =
    match outcome with
    | TickOutcome.Ran report -> report
    | TickOutcome.TurnBusy -> failwith "the tick reported a busy turn"

[<Fact>]
let ``A confirmed publication is marked exactly once`` () =
    let turn, _ = countingTurn ()
    let marked = ResizeArray<Guid>()

    let deps =
        { holding turn [ pendingEvent 1 1 ] (backlog 1L (Some now)) with
            Publish = fun _ _ -> Task.FromResult PublishOutcome.Confirmed
            MarkDispatched =
                fun dispatched _ ->
                    marked.Add(Dispatched.eventId dispatched)
                    Task.FromResult 1
        }

    let report = run deps CancellationToken.None |> reportOf

    test <@ List.ofSeq marked = [ eventId 1 ] @>
    test <@ report.Published = 1 @>

[<Fact>]
let ``A declined publication leaves its event and everything behind it unmarked`` () =
    let turn, _ = countingTurn ()
    let published = ResizeArray<Guid>()

    // Порт отказывает на второй записи из трёх. Третья не должна уехать вовсе:
    // выпустить её при неотправленной второй значит переставить события местами.
    let deps =
        { holding
              turn
              [
                  pendingEvent 1 1
                  pendingEvent 2 1
                  pendingEvent 3 1
              ]
              (backlog 3L (Some now)) with
            Publish =
                fun _ event ->
                    published.Add event.EventId

                    if event.EventId = eventId 2 then
                        Task.FromResult(PublishOutcome.Declined "nats is down")
                    else
                        Task.FromResult PublishOutcome.Confirmed
            MarkDispatched = fun _ _ -> Task.FromResult 1
        }

    let report = run deps CancellationToken.None |> reportOf

    test <@ List.ofSeq published = [ eventId 1; eventId 2 ] @>
    test <@ report.Published = 1 @>
    test <@ report.Declined |> Option.map _.EventId = Some(eventId 2) @>
    test <@ report.Declined |> Option.map _.Reason = Some "nats is down" @>

[<Fact>]
let ``A declined event is offered again with the same identifier`` () =
    let turn, _ = countingTurn ()
    let published = ResizeArray<Guid>()

    // Отказ ничего не отметил, поэтому следующий тик видит ту же строку. Повтор несёт
    // тот же `event_id` не по дисциплине, а потому, что идентификатор читается из
    // журнала и генератора в этом срезе нет ни одного.
    let deps =
        { holding turn [ pendingEvent 1 1 ] (backlog 1L (Some now)) with
            Publish =
                fun _ event ->
                    published.Add event.EventId
                    Task.FromResult(PublishOutcome.Declined "nats is down")
        }

    run deps CancellationToken.None |> ignore
    run deps CancellationToken.None |> ignore

    test <@ List.ofSeq published = [ eventId 1; eventId 1 ] @>

[<Fact>]
let ``A refused turn ends the tick before the first publication`` () =
    let deps =
        { deps with
            TakeTurn = fun () -> Task.FromResult None
        }

    let outcome = run deps CancellationToken.None

    // Чтение, публикация и отметка остались падающими заглушками: если тик их
    // тронул, сценарий не дойдёт до утверждения.
    test <@ outcome = TickOutcome.TurnBusy @>

[<Fact>]
let ``An empty batch reports a zero backlog without touching the port`` () =
    let turn, released = countingTurn ()
    let deps = holding turn [] (backlog 0L None)

    let report = run deps CancellationToken.None |> reportOf

    test <@ report.Published = 0 @>
    test <@ report.Declined = None @>
    test <@ report.Backlog.Pending = 0L @>
    test <@ report.OldestPendingAge = None @>
    test <@ released.Value = 1 @>

[<Fact>]
let ``Cancellation stops the tick before the next publication`` () =
    use stopping = new CancellationTokenSource()
    let turn, _ = countingTurn ()
    let published = ResizeArray<Guid>()

    let deps =
        { holding turn [ pendingEvent 1 1; pendingEvent 2 2 ] (backlog 2L (Some now)) with
            Publish =
                fun _ event ->
                    published.Add event.EventId
                    stopping.Cancel()
                    Task.FromResult PublishOutcome.Confirmed
            MarkDispatched = fun _ _ -> Task.FromResult 1
        }

    let report = run deps stopping.Token |> reportOf

    test <@ List.ofSeq published = [ eventId 1 ] @>
    test <@ report.Published = 1 @>
    test <@ report.Cancelled @>

[<Fact>]
let ``The report carries the backlog and the age of the oldest pending event`` () =
    let turn, _ = countingTurn ()
    let oldest = now - TimeSpan.FromMinutes 90.0
    let deps = holding turn [] (backlog 7L (Some oldest))

    let report = run deps CancellationToken.None |> reportOf

    test <@ report.Backlog.Pending = 7L @>
    test <@ report.OldestPendingAge = Some(TimeSpan.FromMinutes 90.0) @>

[<Fact>]
let ``An unexpected port failure ends the tick without marking anything`` () =
    let turn, _ = countingTurn ()

    let deps =
        { holding turn [ pendingEvent 1 1 ] (backlog 1L (Some now)) with
            Publish = fun _ _ -> Task.FromException<PublishOutcome>(InvalidOperationException "the port broke")
        }

    // MarkDispatched осталась падающей заглушкой, поэтому «ничего не отмечено»
    // проверяется типом отказа: наружу обязано выйти исключение порта, а не её.
    let thrown =
        try
            run deps CancellationToken.None |> ignore
            None
        with exn ->
            Some(causeOf exn)

    test <@ thrown |> Option.map _.Message = Some "the port broke" @>

[<Fact>]
let ``The turn is released even when the tick fails`` () =
    let turn, released = countingTurn ()

    let deps =
        { holding turn [ pendingEvent 1 1 ] (backlog 1L (Some now)) with
            Publish = fun _ _ -> Task.FromException<PublishOutcome>(InvalidOperationException "the port broke")
        }

    try
        run deps CancellationToken.None |> ignore
    with _ ->
        ()

    // Держатель, умерший не отпустив ход, остановил бы публикацию до перезапуска
    // процесса: это самый дорогой способ узнать, что `finally` внутри task не ждёт.
    test <@ released.Value = 1 @>

[<Fact>]
let ``A mark that touched no row is counted as an observed repeat`` () =
    let turn, _ = countingTurn ()

    // Ноль задетых строк означает, что отметку уже поставил кто-то другой: запись
    // уехала наружу дважды. Тик при этом успешен, и без счёта повторов он выглядел
    // бы обычным успешным тиком.
    let deps =
        { holding turn [ pendingEvent 1 1; pendingEvent 2 2 ] (backlog 2L (Some now)) with
            Publish = fun _ _ -> Task.FromResult PublishOutcome.Confirmed
            MarkDispatched =
                fun dispatched _ ->
                    if Dispatched.eventId dispatched = eventId 1 then Task.FromResult 0 else Task.FromResult 1
        }

    let report = run deps CancellationToken.None |> reportOf

    test <@ report.Published = 2 @>
    test <@ report.Repeats = 1 @>

[<Fact>]
let ``A tick whose every mark landed reports no repeats`` () =
    let turn, _ = countingTurn ()

    let deps =
        { holding turn [ pendingEvent 1 1 ] (backlog 1L (Some now)) with
            Publish = fun _ _ -> Task.FromResult PublishOutcome.Confirmed
            MarkDispatched = fun _ _ -> Task.FromResult 1
        }

    let report = run deps CancellationToken.None |> reportOf

    test <@ report.Repeats = 0 @>

[<Fact>]
let ``A failure to release the turn does not replace the failure of the tick`` () =
    let turn =
        {
            Release = fun () -> task { failwith "the lock connection is gone" }
        }

    let deps =
        { holding turn [ pendingEvent 1 1 ] (backlog 1L (Some now)) with
            Publish = fun _ _ -> Task.FromException<PublishOutcome>(InvalidOperationException "the port broke")
        }

    let thrown =
        try
            run deps CancellationToken.None |> ignore
            None
        with exn ->
            Some(causeOf exn)

    // База, уехавшая в середине тика, роняет и тик, и следующий за ним unlock на том
    // же мёртвом соединении. Наружу обязана выйти первопричина, иначе в журнале
    // останется жалоба на замок вместо отказа, из-за которого всё началось.
    test <@ thrown |> Option.map _.Message = Some "the port broke" @>

[<Fact>]
let ``A failure to release the turn surfaces when the tick itself succeeded`` () =
    let turn =
        {
            Release = fun () -> task { failwith "the lock connection is gone" }
        }

    let deps =
        { holding turn [] (backlog 0L None) with
            Publish = fun _ _ -> notReached "Publish"
        }

    let thrown =
        try
            run deps CancellationToken.None |> ignore
            None
        with exn ->
            Some(causeOf exn)

    test <@ thrown |> Option.map _.Message = Some "the lock connection is gone" @>

[<Fact>]
let ``The turn is released once the tick is done`` () =
    let turn, released = countingTurn ()

    let deps =
        { holding turn [ pendingEvent 1 1 ] (backlog 1L (Some now)) with
            Publish = fun _ _ -> Task.FromResult PublishOutcome.Confirmed
            MarkDispatched = fun _ _ -> Task.FromResult 1
        }

    run deps CancellationToken.None |> ignore

    test <@ released.Value = 1 @>

/// PER-227: релей переносит id из строки журнала и не рождает своего — порт получает
/// событие с тем же `RequestId`, что прочитан из журнала.
[<Fact>]
let ``Every published event keeps the request id of its journal row`` () =
    let turn, _ = countingTurn ()
    let offered = ResizeArray<PendingEvent>()

    let deps =
        { holding turn [ pendingEvent 1 1; pendingEvent 2 2 ] (backlog 2L (Some now)) with
            Publish =
                fun _ event ->
                    offered.Add event
                    Task.FromResult PublishOutcome.Confirmed
            MarkDispatched = fun _ _ -> Task.FromResult 1
        }

    run deps CancellationToken.None |> ignore

    test
        <@
            offered
            |> Seq.map (fun event -> event.EventId, event.RequestId |> Option.map RequestId.value)
            |> List.ofSeq = [
                eventId 1, Some "req-1"
                eventId 2, Some "req-2"
            ]
        @>

[<Fact>]
let ``A declined event names the chain it stalled`` () =
    let turn, _ = countingTurn ()

    let deps =
        { holding turn [ pendingEvent 1 1 ] (backlog 1L (Some now)) with
            Publish = fun _ _ -> Task.FromResult(PublishOutcome.Declined "nats is unreachable")
        }

    let report = run deps CancellationToken.None |> reportOf

    test
        <@
            report.Declined
            |> Option.bind (fun declined -> declined.RequestId)
            |> Option.map RequestId.value = Some "req-1"
        @>
