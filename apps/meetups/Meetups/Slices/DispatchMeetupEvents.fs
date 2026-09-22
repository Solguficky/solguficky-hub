/// Срез «отправить события сходок»: один тик публикации из журнала-outbox.
///
/// Сценарий начинают часы, а не человек, поэтому смотрящего у него нет и правил
/// человеческой видимости он не применяет. Единица работы — тик: взять ход,
/// посмотреть бэклог, отдать порту пачку неотправленного и отметить подтверждённое.
/// Расписание, интервал и переживание отказов принадлежат фоновой границе
/// (`Transport/OutboxDispatchWorker.fs`), а сам транспорт — адаптеру порта (PER-209).
module Meetups.Slices.DispatchMeetupEvents

open System
open System.Runtime.ExceptionServices
open System.Threading
open System.Threading.Tasks
open Meetups.Infrastructure

/// Запись журнала в том виде, в каком её получает порт публикации.
/// Transport-neutral буквально: ни одного типа из `Meetups.V1`, ни subject, ни
/// конверта. Их форма принята (PER-206) — сообщение `meetups.v1.MeetupEvent` и
/// subject `events.meetups.` плюс `EventType`, — но раскладывает запись в конверт
/// адаптер порта (PER-209), а не этот срез.
///
/// `position` в запись не входит намеренно. ADR-035 оставил его порядком обхода и
/// прямо запретил делать курсором; порт, получивший номер, рано или поздно начнёт
/// на него опираться, и запрет придётся держать уже дисциплиной.
///
/// Доменные обёртки (`MeetupId`, `PersonId`) здесь тоже не нужны: это строка
/// журнала на пути наружу, инварианта она не несёт, а порт всё равно разложит её в
/// конверт. Домен на этом пути уже отработал — снимок записан командой.
type PendingEvent =
    {
        EventId: Guid
        MeetupId: Guid
        Version: int64
        EventType: string
        Payload: string
        PerformedBy: Guid
        OccurredAt: DateTimeOffset
    }

/// Исход попытки публикации. Значение, а не исключение: недоступность соседа —
/// ожидаемый отказ, и адаптер возвращает его вызывающему, а не логирует
/// (logging.md, «Кто не логирует»).
[<RequireQualifiedAccess; NoComparison>]
type PublishOutcome =
    | Confirmed
    | Declined of reason: string

/// Подтверждённая публикация. Конструктор закрыт представлением, поэтому значение
/// рождается только в ветке `Confirmed`.
///
/// Это не церемония: «отметить неопубликованное» — единственный режим этой работы с
/// безвозвратной ценой. ADR-035 говорит прямо, что ошибочно поставленная отметка
/// означает потерю события, а восстановить её из истории нечем. Закрытый
/// конструктор превращает эту ошибку из той, что ловит тест, в ту, что ловит
/// компилятор.
type Dispatched = private Dispatched of Guid

module Dispatched =

    let internal confirm (event: PendingEvent) = Dispatched event.EventId

    let eventId (Dispatched id) = id

/// Порт публикации. `Unconfigured` — не заглушка, а состояние сервиса: адаптера
/// ещё нет (PER-209).
///
/// Вариант нужен потому, что обе заглушки хуже. Порт, подтверждающий публикацию
/// молча, проставил бы `dispatched_at` всему журналу и потерял бы события
/// навсегда. Порт, отказывающий всегда, писал бы поток `dependency_unavailable` о
/// зависимости, которой не существует. Явное состояние не даёт циклу стартовать
/// вовсе, и это единственный честный ответ, пока транспорта нет.
[<RequireQualifiedAccess; NoComparison>]
type Port =
    | Unconfigured
    | Publish of (CancellationToken -> PendingEvent -> Task<PublishOutcome>)

/// Ход публикации: пока он занят, другой экземпляр за журнал не берётся.
/// Запись функций, а не тип Npgsql — иначе решение «что делает тик, когда ход
/// занят» пришлось бы проверять с поднятой базой.
[<NoEquality; NoComparison>]
type Turn =
    {
        Release: unit -> Task<unit>
    }

/// Очередь, которую тик застал. Возраст меряется от `occurred_at` самой ранней
/// неотправленной записи, то есть это лаг публикации, а не возраст строки.
type Backlog =
    {
        Pending: int64
        OldestOccurredAt: DateTimeOffset option
    }

/// Отказ, на котором тик остановился.
type Decline =
    {
        EventId: Guid
        MeetupId: Guid
        Reason: string
    }

type TickReport =
    {
        Backlog: Backlog
        OldestPendingAge: TimeSpan option
        Published: int
        /// Публикации, чья отметка не задела ни одной строки: запись успел отметить
        /// кто-то другой, то есть событие уехало наружу дважды. Это единственный
        /// повтор, который релей способен наблюдать сам — смерть процесса между
        /// публикацией и отметкой не наблюдаема ничем без нового состояния на строке,
        /// а его ADR-035 назвал ценой своего пересмотра.
        Repeats: int
        Declined: Decline option
        Cancelled: bool
    }

[<RequireQualifiedAccess; NoComparison>]
type TickOutcome =
    /// Ход держит другой экземпляр. Отдельный случай, а не пустой отчёт: иначе
    /// «публиковать было нечего» и «публиковал не я» стали бы неразличимы, и тест
    /// на изоляцию проходил бы на пустой очереди.
    | TurnBusy
    | Ran of TickReport

[<NoEquality; NoComparison>]
type Deps =
    {
        TakeTurn: unit -> Task<Turn option>
        /// Бэклог и пачка приходят вместе, потому что описывают одну очередь и
        /// обязаны быть прочитаны в одном снимке.
        ReadQueue: int -> Task<Backlog * PendingEvent list>
        Publish: CancellationToken -> PendingEvent -> Task<PublishOutcome>
        /// Возвращает число задетых строк: ноль означает наблюдённый повтор.
        MarkDispatched: Dispatched -> DateTimeOffset -> Task<int>
        Now: unit -> DateTimeOffset
        BatchSize: int
    }

/// Счёт пройденного пачкой: опубликовано, из них наблюдённых повторов, на чём
/// остановились и была ли остановка отменой.
type private BatchTally =
    {
        Published: int
        Repeats: int
        Declined: Decline option
        Cancelled: bool
    }

/// Обход пачки. Отметка ставится сразу за подтверждением, а не пачкой в конце тика:
/// окно между публикацией и отметкой — это окно повтора, и на одну запись оно
/// короче, чем на сто.
///
/// Первый отказ останавливает пачку целиком, а не пропускает запись. Пропуск
/// выпустил бы версию n+1 при неотправленной n, и потребитель, обязанный ADR-035
/// сравнивать `version`, применил бы n+1 и отбросил бы n как устаревшую — молчаливая
/// потеря применения снимка. Цена названа: одна недоставляемая запись держит
/// очередь, и виден этот режим только по возрасту старейшей записи.
let rec private publishBatch
    (deps: Deps)
    (token: CancellationToken)
    (remaining: PendingEvent list)
    (tally: BatchTally)
    : Task<BatchTally> =
    task {
        match remaining with
        | [] -> return tally
        | event :: rest ->
            if token.IsCancellationRequested then
                return
                    { tally with
                        Cancelled = true
                    }
            else
                match! deps.Publish token event with
                | PublishOutcome.Confirmed ->
                    let! affected = deps.MarkDispatched (Dispatched.confirm event) (deps.Now())

                    // Ноль задетых строк — не безобидная идемпотентность: отметку уже
                    // поставил кто-то другой, значит эту запись опубликовали дважды.
                    // Проглотить его означало бы отчитаться `result=ok` о двойной
                    // публикации.
                    return!
                        publishBatch
                            deps
                            token
                            rest
                            { tally with
                                Published = tally.Published + 1
                                Repeats = tally.Repeats + (if affected = 0 then 1 else 0)
                            }
                | PublishOutcome.Declined reason ->
                    return
                        { tally with
                            Declined =
                                Some
                                    {
                                        EventId = event.EventId
                                        MeetupId = event.MeetupId
                                        Reason = reason
                                    }
                        }
    }

let private runTick (deps: Deps) (token: CancellationToken) : Task<TickReport> =
    task {
        // Очередь снимается до публикации и одним снимком: числа обязаны описывать
        // ту очередь, которую тик застал, а не остаток после своей же работы и не две
        // разные очереди, между которыми успела закоммититься команда.
        let! backlog, pending = deps.ReadQueue deps.BatchSize
        let observedAt = deps.Now()

        let! tally =
            publishBatch
                deps
                token
                pending
                {
                    Published = 0
                    Repeats = 0
                    Declined = None
                    Cancelled = false
                }

        return
            {
                Backlog = backlog
                OldestPendingAge =
                    backlog.OldestOccurredAt
                    |> Option.map (fun occurredAt -> observedAt - occurredAt)
                Published = tally.Published
                Repeats = tally.Repeats
                Declined = tally.Declined
                Cancelled = tally.Cancelled
            }
    }

/// Один тик публикации.
///
/// Ход отпускается при любом исходе, включая неожиданный отказ: держатель, который
/// умер, не отпустив ход, остановил бы публикацию до перезапуска процесса.
/// `finally` внутри `task` не умеет ждать, поэтому освобождение стоит явным шагом, а
/// исключение переносится через `ExceptionDispatchInfo` — тем же способом, каким это
/// делает `BoundaryLog`, и по той же причине: `reraise` доступен только прямо в
/// `with`-блоке.
let execute (deps: Deps) (token: CancellationToken) : Task<TickOutcome> =
    task {
        match! deps.TakeTurn() with
        | None -> return TickOutcome.TurnBusy
        | Some turn ->
            let! attempt =
                task {
                    try
                        let! report = runTick deps token
                        return Ok report
                    with unexpected ->
                        return Error unexpected
                }

            // Отказ освобождения тоже ловится: база, уехавшая в середине тика, роняет
            // и сам тик, и следующий за ним `unlock` на том же мёртвом соединении.
            // Непойманный, он вытеснил бы первопричину, и в журнале осталась бы
            // жалоба на замок вместо отказа, из-за которого всё началось.
            let! releaseFailure =
                task {
                    try
                        do! turn.Release()
                        return None
                    with unexpected ->
                        return Some unexpected
                }

            match attempt, releaseFailure with
            | Error unexpected, _ ->
                ExceptionDispatchInfo.Capture(unexpected).Throw()
                return TickOutcome.TurnBusy
            | Ok _, Some unexpected ->
                ExceptionDispatchInfo.Capture(unexpected).Throw()
                return TickOutcome.TurnBusy
            | Ok report, None -> return TickOutcome.Ran report
    }

/// Composition root среза: здесь заканчивается DI. Отображение строк журнала в
/// `PendingEvent` живёт тут же — потребитель у него один, и до второго общий модуль
/// не заводится.
module Composition =

    open Microsoft.Extensions.Configuration
    open Microsoft.Extensions.DependencyInjection
    open Npgsql

    /// Рабочие параметры, а не решения: ADR-024 прямо назвал интервал опроса тем,
    /// что меняется без нового ADR. Имена переменных стоят рядом со значениями по
    /// образцу `Migrations.DatabaseUrlVariable`.
    [<Literal>]
    let BatchSizeVariable = "MEETUPS_DISPATCH_BATCH_SIZE"

    [<Literal>]
    let IntervalVariable = "MEETUPS_DISPATCH_INTERVAL_SECONDS"

    let defaultBatchSize = 100

    /// Потолок пачки. Обход рекурсивен, и синхронно отвечающий порт не даёт
    /// состоянию машины разгрузить стек, поэтому неограниченное значение из
    /// конфигурации превратилось бы в переполнение вместо отказа настройки.
    let maxBatchSize = 1000

    let defaultIntervalSeconds = 2

    let private positive (configuration: IConfiguration) (name: string) (fallback: int) (ceiling: int) =
        match Int32.TryParse configuration[name] with
        | true, value when value > 0 -> min value ceiling
        | _ -> fallback

    let batchSize (configuration: IConfiguration) =
        positive configuration BatchSizeVariable defaultBatchSize maxBatchSize

    /// Час — предел не осмысленный, а защитный: он оставляет опечатку в конфигурации
    /// наблюдаемой как редкий тик, а не как молчащий сервис.
    let maxIntervalSeconds = 3600

    let interval (configuration: IConfiguration) =
        positive configuration IntervalVariable defaultIntervalSeconds maxIntervalSeconds
        |> float
        |> TimeSpan.FromSeconds

    let private toPendingEvent (row: DispatchStore.PendingRow) : PendingEvent =
        {
            EventId = row.EventId
            MeetupId = row.MeetupId
            Version = row.Version
            EventType = row.EventType
            Payload = row.Payload
            PerformedBy = row.PerformedBy
            OccurredAt = row.OccurredAt
        }

    let private toBacklog (row: DispatchStore.BacklogRow) : Backlog =
        {
            Pending = row.Pending
            OldestOccurredAt = Option.ofNullable row.OldestOccurredAt
        }

    let buildDeps
        (services: IServiceProvider)
        (publish: CancellationToken -> PendingEvent -> Task<PublishOutcome>)
        : Deps =
        let source = services.GetRequiredService<NpgsqlDataSource>()
        let configuration = services.GetRequiredService<IConfiguration>()

        {
            TakeTurn =
                fun () ->
                    task {
                        let! turn = DispatchStore.tryTakeTurn source

                        return
                            turn
                            |> Option.map (fun release ->
                                {
                                    Release = release
                                }
                            )
                    }
            ReadQueue =
                fun limit ->
                    task {
                        let! backlog, rows = DispatchStore.readQueue source limit

                        return toBacklog backlog, rows |> List.map toPendingEvent
                    }
            Publish = publish
            MarkDispatched = fun dispatched at -> DispatchStore.markDispatched source (Dispatched.eventId dispatched) at
            // UtcNow, а не Now: TIMESTAMPTZ принимает DateTimeOffset только с нулевым
            // смещением, и локальное время упало бы уже в рантайме.
            Now = fun () -> DateTimeOffset.UtcNow
            BatchSize = batchSize configuration
        }
