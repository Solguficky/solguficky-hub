namespace Meetups.Transport

open System
open System.Diagnostics
open System.Threading
open System.Threading.Tasks
open Meetups
open Meetups.Domain
open Meetups.Infrastructure
open Meetups.Observability
open Meetups.Slices
open Meetups.Slices.PublishDueMeetups
open Microsoft.Extensions.Configuration
open Microsoft.Extensions.Hosting
open Microsoft.Extensions.Logging

/// Запись о тике отложенной публикации: уровень и поля каркаса из
/// docs/standards/observability/logging.md.
///
/// Вынесена чистой функцией по той же причине, что и у соседней фоновой границы:
/// состав полей — требование норматива, а не деталь цикла, и проверять его с
/// поднятым хостом, живым таймером и базой значило бы проверять самое дешёвое самым
/// дорогим уровнем.
module DuePublicationLog =

    /// Транспортное имя операции: «какой код исполнялся». Вопроса «что делал человек»
    /// у этой границы нет.
    [<Literal>]
    let Operation = "meetups.publication.due"

    /// Каркас без `use_case` и без `request_id`, и оба отсутствия намеренные:
    /// logging.md называет периодическую фоновую работу операцией без сценария, а
    /// тик цепочкой не является — он начинает по одной на каждую опубликованную
    /// сходку, и их id пишет запись `started`, а не запись тика.
    let private frame (result: string) (durationMicroseconds: int64) =
        [
            "service", box Failures.Service
            "operation", box Operation
            "result", box result
            "duration_us", box durationMicroseconds
        ]

    /// «Допиши поле, если его стоит писать» — одна форма на все необязательные поля
    /// записи. Хелпер локальный: соседняя фоновая граница пишет свой набор полей, и
    /// общий модуль ради этой формы связал бы две границы, которым друг о друге знать
    /// незачем, — та же причина, по которой рядом не вынесен разбор конфигурации.
    let private appendWhen (present: bool) (field: unit -> string * obj) (fields: (string * obj) list) =
        if present then fields @ [ field () ] else fields

    /// `due` пишется всегда: это и есть ответ на «набор не растёт», и поле, которое
    /// появляется только при ненулевом значении, превращает запрос «сколько ждёт» в
    /// запрос по наличию поля. Остальные счётчики пишутся, только когда были: поле с
    /// нулём в каждой записи делает вопрос «были ли проигранные гонки» вопросом по
    /// значению.
    let private setFields (report: TickReport) =
        [
            "due", box report.Backlog.Due
            "published", box report.Published
        ]
        |> appendWhen (report.Claimed > 0) (fun () -> "claimed", box report.Claimed)
        |> appendWhen (not (List.isEmpty report.Blocked)) (fun () -> "blocked", box (List.length report.Blocked))
        |> appendWhen (not (List.isEmpty report.Failed)) (fun () -> "failed", box (List.length report.Failed))
        |> appendWhen
            report.OldestDueAge.IsSome
            (fun () -> "oldest_due_age_us", box (int64 report.OldestDueAge.Value.TotalMicroseconds))
        |> appendWhen report.Cancelled (fun () -> "cancelled", box true)

    /// Неожиданный отказ на строке идёт раньше отклонённого перехода: он означает
    /// сломанный путь, а не сходку, которая ждёт человека, и прятать его за чужим
    /// Warning значило бы потерять более срочный из двух.
    ///
    /// Оба случая называют только головную сходку: запись — событие фиксированной
    /// формы, а не список, и число рядом говорит, сколько их всего. Ценой этого
    /// хвост списка виден лишь числом, и при устойчивом заторе головной
    /// идентификатор повторяется из тика в тик — предел назван в README сервиса.
    let describe (report: TickReport) (durationMicroseconds: int64) : LogLevel * (string * obj) list =
        match report.Failed, report.Blocked with
        | (MeetupId id, reason) :: _, _ ->
            LogLevel.Error,
            frame "error" durationMicroseconds
            @ setFields report
            @ [
                "error_category", box "unexpected"
                "error", box reason
                "meetup_id", box id
            ]
        // Домен отклонил переход, и сам он не рассосётся: сходка остаётся в наборе,
        // пока человек не поправит её или не отменит момент. Warning и никакого
        // stack — норматив держит stack для неожиданного отказа, а это ожидаемый.
        // Результат остаётся `error`: тик сделал не всё, что был должен.
        | [], (MeetupId id, error) :: _ ->
            LogLevel.Warning,
            frame "error" durationMicroseconds
            @ setFields report
            @ [
                "error_category", box "invariant"
                "error", box (string error)
                "meetup_id", box id
            ]
        | [], [] ->
            match report.Published with
            | 0 ->
                // Публиковать было нечего. Подробность успешного шага внутри горячего
                // цикла относится к Debug.
                LogLevel.Debug, frame "ok" durationMicroseconds @ setFields report
            | _ -> LogLevel.Information, frame "ok" durationMicroseconds @ setFields report

    /// Запись о цепочке, которую начал тик: сходка опубликована по расписанию под
    /// собственным `request_id` (logging.md, PER-227). Без неё id повода жил бы только
    /// в журнале, и поиск по логам — первое, чем разбирают «почему не пришло», — его
    /// не нашёл бы. Длительность — записи этой сходки, а не тика.
    let started (durationMicroseconds: int64) (MeetupId id, requestId: RequestId) : (string * obj) list =
        frame "ok" durationMicroseconds
        @ [
            "request_id", box (RequestId.value requestId)
            "meetup_id", box id
        ]

    /// Запись, которая пишет `started` в момент коммита, а не после тика.
    ///
    /// Запись из отчёта тика терялась бы вместе с ним: отмена или неожиданный отказ
    /// посреди пачки уносят отчёт, а уже закоммиченные публикации остались бы с id
    /// только в журнале. Проигранная гонка записи не даёт: события нет, и цепочка не
    /// началась. Конверт без id сюда не приходит — срез рождает его на каждую
    /// попытку, — а если придёт, записи нет: придумывать id граница не вправе.
    let announcing
        (write: (string * obj) list -> unit)
        (commit:
            MeetupStore.EventEnvelope
                -> int64 option
                -> MeetupState
                -> MeetupEvent
                -> Task<Result<MeetupSnapshot, MeetupStore.VersionConflict>>)
        =
        fun (envelope: MeetupStore.EventEnvelope) expectedVersion state event ->
            task {
                let began = Stopwatch.GetTimestamp()
                let! result = commit envelope expectedVersion state event

                match result, envelope.RequestId with
                | Ok snapshot, Some requestId ->
                    write (started (int64 (Stopwatch.GetElapsedTime began).TotalMicroseconds) (snapshot.Id, requestId))
                | Ok _, None
                | Error MeetupStore.VersionConflict, _ -> ()

                return result
            }

    /// Неожиданный отказ: та же рамка плюс `stack`, которого у объявленных отказов
    /// быть не должно.
    let unexpected (error: exn) (durationMicroseconds: int64) : (string * obj) list =
        frame "error" durationMicroseconds
        @ [
            "error_category", box "unexpected"
            "error", box error.Message
            "stack", box error.StackTrace
        ]

/// Фоновая граница отложенной публикации: единственное место, откуда наступивший
/// момент превращается в публикацию. Границей её делает logging.md — каркас записи
/// заполняет тот, кто принял вызов, а сюда вызов приходит от часов.
///
/// Класс остаётся диспетчером, как и gRPC-класс рядом: он владеет расписанием,
/// отменой и живучестью цикла, но решение одного тика целиком принадлежит срезу.
///
/// Варианта «не настроен» у неё нет, в отличие от публикации из журнала: там порту
/// нужен адрес шины, которого в запуске может не быть, а здесь всё, что нужно тику,
/// — та же база, в которую сервис уже пишет команды.
type DuePublicationWorker
    (services: IServiceProvider, configuration: IConfiguration, logger: ILogger<DuePublicationWorker>) =
    inherit BackgroundService()

    let write (level: LogLevel) (error: exn option) (fields: (string * obj) list) =
        let template =
            "due publication "
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
    /// `BackgroundServiceExceptionBehavior` по умолчанию останавливает хост целиком, а
    /// один неудачный тик этого не стоит. Отказ записывает та граница, на которой он
    /// стал наблюдаемым, — она здесь.
    let tick (deps: Deps) (token: CancellationToken) : Task<unit> =
        task {
            let started = Stopwatch.GetTimestamp()

            try
                let! report = PublishDueMeetups.execute deps token

                let level, fields = DuePublicationLog.describe report (elapsedMicroseconds started)

                write level None fields

                if not (List.isEmpty report.Blocked) then
                    Failures.count "invariant"

                if not (List.isEmpty report.Failed) then
                    Failures.count "unexpected"

                DuePublicationTelemetry.observe
                    report.Backlog.Due
                    report.OldestDueAge
                    report.Published
                    report.Claimed
                    (List.length report.Blocked)
                    (List.length report.Failed)
            with
            | :? OperationCanceledException -> ()
            | unexpected ->
                Failures.count "unexpected"

                write
                    LogLevel.Error
                    (Some unexpected)
                    (DuePublicationLog.unexpected unexpected (elapsedMicroseconds started))
        }

    /// Следующая попытка — это следующий тик, и другого механизма повтора нет. Отсюда
    /// и частота повторов ограничена интервалом по построению: отдельного состояния
    /// попыток, которому можно протухнуть, не существует.
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
        let deps =
            let composed = PublishDueMeetups.Composition.buildDeps services

            { composed with
                Commit = DuePublicationLog.announcing (write LogLevel.Information None) composed.Commit
            }

        let timer = new PeriodicTimer(PublishDueMeetups.Composition.interval configuration)

        task {
            try
                do! cycle deps timer token
            finally
                timer.Dispose()
        }
