namespace Meetups.Transport

open System
open System.Diagnostics
open System.Threading
open System.Threading.Tasks
open Meetups
open Meetups.Observability
open Meetups.Slices
open Meetups.Slices.DispatchMeetupEvents
open Microsoft.Extensions.Configuration
open Microsoft.Extensions.Hosting
open Microsoft.Extensions.Logging

/// Запись о тике фоновой границы: уровень и поля каркаса из
/// docs/standards/observability/logging.md.
///
/// Вынесена чистой функцией, потому что состав полей — это требование норматива, а
/// не деталь цикла: проверять его с поднятым хостом, живым таймером и базой значило
/// бы проверять самое дешёвое самым дорогим уровнем.
module OutboxDispatchLog =

    /// Транспортное имя операции: «какой код исполнялся». Вопроса «что делал
    /// человек» у этой границы нет.
    [<Literal>]
    let Operation = "meetups.outbox.dispatch"

    /// Каркас без `use_case` и без `request_id`, и оба отсутствия намеренные.
    ///
    /// `use_case` — logging.md прямо называет периодическую фоновую работу операцией
    /// без сценария: поле отсутствует, а не заполняется заглушкой.
    ///
    /// `request_id` — тик обслуживает много цепочек сразу, и ни одна из них не его:
    /// придумать значение здесь — значит выдать его за сквозное. Id событий пишет
    /// запись `relayed`, по одной на публикацию, а запись тика поле опускает.
    let private frame (result: string) (durationMicroseconds: int64) =
        [
            "service", box Failures.Service
            "operation", box Operation
            "result", box result
            "duration_us", box durationMicroseconds
        ]

    let private backlogFields (report: TickReport) =
        [
            "pending", box report.Backlog.Pending
            "published", box report.Published
        ]
        // Повтор пишется только когда он был: поле, присутствующее с нулём в каждой
        // записи, превращает запрос «были ли повторы» в запрос по значению.
        |> fun fields -> if report.Repeats > 0 then fields @ [ "repeats", box report.Repeats ] else fields
        |> fun fields ->
            match report.OldestPendingAge with
            | Some age ->
                fields
                @ [
                    "oldest_pending_age_us", box (int64 age.TotalMicroseconds)
                ]
            | None -> fields
        |> fun fields -> if report.Cancelled then fields @ [ "cancelled", box true ] else fields

    let private requestIdField (requestId: RequestId option) =
        match requestId with
        | Some value ->
            [
                "request_id", box (RequestId.value value)
            ]
        | None -> []

    /// Запись об одной подтверждённой публикации (PER-227). Здесь `request_id` уже не
    /// выдуман: он пришёл из строки журнала, то есть это id той цепочки, которую
    /// событие продолжает. Поиск по id из кадра бота находит именно эту запись.
    /// Событие без id (вызов без заголовка, строка старше миграции 008) пишется без
    /// поля — logging.md велит опускать значение, которого граница не получила.
    /// Длительность — самой публикации, а не тика.
    let relayed (durationMicroseconds: int64) (event: PendingEvent) : (string * obj) list =
        frame "ok" durationMicroseconds
        @ [
            "meetup_id", box event.MeetupId
            "event_id", box event.EventId
        ]
        @ requestIdField event.RequestId

    /// Порт, который пишет `relayed` в момент подтверждения, а не после тика.
    ///
    /// Запись из отчёта тика терялась бы вместе с ним: неожиданный отказ на следующем
    /// событии уносит отчёт, а уже подтверждённое событие отмечено и повторно не
    /// уйдёт — его id не нашёлся бы в логах вовсе. Запись о публикации стоит до
    /// отметки: если отметка потом упадёт, событие опубликуют ещё раз и запишут ещё
    /// раз, и это правда о шине, а не шум. Отказ и исключение порта записи не дают:
    /// публикации не было.
    let announcing
        (write: (string * obj) list -> unit)
        (publish: CancellationToken -> PendingEvent -> Task<PublishOutcome>)
        : CancellationToken -> PendingEvent -> Task<PublishOutcome> =
        fun token event ->
            task {
                let started = Stopwatch.GetTimestamp()
                let! outcome = publish token event

                match outcome with
                | PublishOutcome.Confirmed ->
                    write (relayed (int64 (Stopwatch.GetElapsedTime started).TotalMicroseconds) event)
                | PublishOutcome.Declined _ -> ()

                return outcome
            }

    let describe (outcome: TickOutcome) (durationMicroseconds: int64) : LogLevel * (string * obj) list =
        match outcome with
        // Ход занят другим экземпляром — это норма, а не отказ: ровно так изоляция и
        // выглядит снаружи. Debug, потому что на горячем цикле резервного экземпляра
        // Information означал бы запись каждые несколько секунд ни о чём.
        | TickOutcome.TurnBusy ->
            LogLevel.Debug,
            frame "ok" durationMicroseconds
            @ [ "turn", box "busy" ]
        | TickOutcome.Ran report ->
            match report.Declined with
            // Отказ соседа — ожидаемый исход, а не сбой сервиса: Warning и никакого
            // stack, норматив держит stack для неожиданного отказа.
            | Some declined ->
                LogLevel.Warning,
                frame "error" durationMicroseconds
                @ backlogFields report
                @ [
                    "error_category", box "dependency_unavailable"
                    "error", box declined.Reason
                    "meetup_id", box declined.MeetupId
                    "event_id", box declined.EventId
                ]
                @ requestIdField declined.RequestId
            // Тик отработал, но чью-то запись он опубликовал вторым. Результат
            // остаётся `ok` — публикация состоялась, — а уровень поднимается:
            // одновременно работающих релеев быть не должно, и молча это выглядело бы
            // как обычный успешный тик.
            | None when report.Repeats > 0 ->
                LogLevel.Warning,
                frame "ok" durationMicroseconds
                @ backlogFields report
            | None when report.Published > 0 ->
                LogLevel.Information,
                frame "ok" durationMicroseconds
                @ backlogFields report
            // Публиковать было нечего. Подробность успешного шага внутри горячего
            // цикла относится к Debug.
            | None ->
                LogLevel.Debug,
                frame "ok" durationMicroseconds
                @ backlogFields report

    /// Неожиданный отказ: та же рамка плюс `stack`, которого у объявленных отказов
    /// быть не должно.
    let unexpected (error: exn) (durationMicroseconds: int64) : (string * obj) list =
        frame "error" durationMicroseconds
        @ [
            "error_category", box "unexpected"
            "error", box error.Message
            "stack", box error.StackTrace
        ]

/// Фоновая граница сервиса: единственное место, откуда начинается публикация из
/// журнала. Границей её делает logging.md — каркас записи заполняет тот, кто принял
/// вызов, а сюда вызов приходит от часов.
///
/// Класс остаётся диспетчером, как и gRPC-класс рядом: он владеет расписанием,
/// отменой и живучестью цикла, но решение одного тика целиком принадлежит срезу.
type OutboxDispatchWorker
    (port: Port, services: IServiceProvider, configuration: IConfiguration, logger: ILogger<OutboxDispatchWorker>) =
    inherit BackgroundService()

    let write (level: LogLevel) (error: exn option) (fields: (string * obj) list) =
        let template =
            "outbox dispatch "
            + String.concat
                " "
                (fields
                 |> List.map (fun (name, _) -> "{" + name + "}"))

        let values = fields |> List.map snd |> List.toArray

        match error with
        | Some exn -> logger.Log(level, exn, template, values)
        | None -> logger.Log(level, template, values)

    let elapsedMicroseconds (started: int64) = int64 (Stopwatch.GetElapsedTime started).TotalMicroseconds

    /// Один тик вместе со своей записью. Наружу из него не выходит ничего:
    /// `BackgroundServiceExceptionBehavior` по умолчанию останавливает хост целиком,
    /// а один неудачный тик этого не стоит. Отказ записывает та граница, на которой
    /// он стал наблюдаемым, — она здесь.
    let tick (deps: Deps) (token: CancellationToken) : Task<unit> =
        task {
            let started = Stopwatch.GetTimestamp()

            try
                let! outcome = DispatchMeetupEvents.execute deps token

                let level, fields = OutboxDispatchLog.describe outcome (elapsedMicroseconds started)

                write level None fields

                match outcome with
                | TickOutcome.TurnBusy -> ()
                | TickOutcome.Ran report ->

                    let declined = if report.Declined.IsSome then 1 else 0

                    if declined > 0 then
                        Failures.count "dependency_unavailable"

                    DispatchTelemetry.observe
                        report.Backlog.Pending
                        report.OldestPendingAge
                        report.Published
                        declined
                        report.Repeats
            with
            | :? OperationCanceledException -> ()
            | unexpected ->
                Failures.count "unexpected"

                write
                    LogLevel.Error
                    (Some unexpected)
                    (OutboxDispatchLog.unexpected unexpected (elapsedMicroseconds started))
        }

    /// Следующая попытка — это следующий тик, и другого механизма повтора нет.
    /// Отсюда и частота повторов ограничена интервалом по построению: отдельного
    /// состояния попыток, которому можно протухнуть, не существует.
    let rec cycle (deps: Deps) (timer: PeriodicTimer) (token: CancellationToken) : Task<unit> =
        task {
            if token.IsCancellationRequested then
                return ()
            else
                do! tick deps token

                let! due =
                    task {
                        try
                            return! timer.WaitForNextTickAsync token
                        with :? OperationCanceledException ->
                            return false
                    }

                if due then return! cycle deps timer token else return ()
        }

    override _.ExecuteAsync(token: CancellationToken) : Task =
        match port with
        // Адрес NATS в этом запуске не задан. Это запись о жизненном цикле процесса,
        // а не об операции: длительности и результата у неё нет, и повторять её
        // каждый тик было бы враньём про недоступную зависимость — зависимости нет.
        | Port.Unconfigured ->
            write
                LogLevel.Information
                None
                [
                    "service", box Failures.Service
                    "dispatch", box "unconfigured"
                ]

            Task.CompletedTask
        | Port.Publish publish ->
            let deps =
                DispatchMeetupEvents.Composition.buildDeps
                    services
                    (OutboxDispatchLog.announcing (write LogLevel.Information None) publish)

            let timer =
                new PeriodicTimer(DispatchMeetupEvents.Composition.interval configuration)

            task {
                try
                    do! cycle deps timer token
                finally
                    timer.Dispose()
            }
