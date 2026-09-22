/// Срез «опубликовать наступившее»: один тик отложенной публикации.
///
/// Сценарий начинают часы, а не человек, поэтому смотрящего у него нет и
/// `Access.forCommand` он не применяет — ровно как соседний `DispatchMeetupEvents`.
/// Единица работы — тик: снять набор наступивших моментов и попытаться опубликовать
/// каждый. Расписание, отмена и живучесть цикла принадлежат фоновой границе
/// (`Transport/DuePublicationWorker.fs`).
///
/// `PublishMeetup` отсюда не вызывается: срез не вызывает другой срез
/// (standards/architecture/functional-slices.md). Общее лежит ниже и переиспользуется
/// целиком — `Meetup.decidePublish` и `MeetupStore.commit`. Поэтому событие
/// получается буквально то же, что у ручной публикации, и нового типа события
/// отложенность не вводит (ADR-024).
module Meetups.Slices.PublishDueMeetups

open System
open System.Runtime.ExceptionServices
open System.Threading
open System.Threading.Tasks
open Meetups.Domain
open Meetups.Infrastructure

/// Исполнитель публикации, начатой часами. `performed_by` объявлен `NOT NULL` без
/// внешнего ключа, а человека у этого сценария нет.
///
/// Нулевой UUID, а не выдуманный идентификатор: `Identity` выдаёт UUIDv7, нули в нём
/// невозможны, поэтому значение заведомо не принадлежит человеку и утверждаемо в
/// тесте. Тем же доводом пользуется начало keyset-обхода в `MeetupReading`.
/// Подставить автора нельзя — он этого не делал, и вопрос «кто это сделал» перестал
/// бы иметь ответ.
///
/// Значение живёт в срезе, а не в общем модуле: потребитель у него один, и норматив
/// срезов разрешает общий модуль со второго.
let clockPerformer = PersonId Guid.Empty

/// Набор, который тик застал.
type DueBacklog =
    {
        Due: int64
        OldestDueAt: DateTimeOffset option
    }

/// Исход одной сходки из набора. Размеченное объединение, а не булев успех: каждый
/// исход обязан доехать до отчёта, иначе проигранная гонка и отказ инварианта
/// сливаются в «не опубликовали» и различить их в эксплуатации нечем.
[<RequireQualifiedAccess; NoComparison>]
type Attempt =
    | Published of MeetupId
    /// Расхождение версий: строку изменил кто-то другой — ручная публикация, отмена
    /// момента, отмена сходки, правка или второй экземпляр воркера. Тик не разбирает,
    /// кто именно, и `SafeRetry.discriminate` не зовёт: у человека следующей попытки
    /// нет, а у тика она есть — следующий тик перечитает набор и увидит актуальное
    /// состояние.
    ///
    /// Сюда же приходит сходка, которую между сканом и записью опубликовали вручную:
    /// снимок тика устарел, и предикат записи отвечает тем же расхождением. Отдельного
    /// исхода «нас опередили» нет, и это не упущение — см. `attempt`.
    | Claimed of MeetupId
    /// Домен отклонил переход. Единственный достижимый здесь повод —
    /// `TitleRequiredForPublication`: момент можно назначить черновику без заголовка,
    /// и такая сходка остаётся в наборе, пока заголовок не появится. Именно этот
    /// режим видно по возрасту старейшего момента.
    | Blocked of MeetupId * DomainError
    /// Неожиданный отказ на одной сходке: оборванное соединение, нарушенное
    /// ограничение схемы. Значение, а не исключение наружу, потому что пачка обязана
    /// пережить одну плохую строку — иначе тик теряет отчёт целиком вместе с уже
    /// записанными публикациями, и остановка, убранная для доменных отказов, вернулась
    /// бы с другой стороны.
    | Failed of MeetupId * string

type TickReport =
    {
        Backlog: DueBacklog
        OldestDueAge: TimeSpan option
        Published: int
        Claimed: int
        Blocked: (MeetupId * DomainError) list
        Failed: (MeetupId * string) list
        Cancelled: bool
    }

[<NoEquality; NoComparison>]
type Deps =
    {
        /// Размер набора и пачка приходят вместе, потому что описывают один набор и
        /// обязаны быть прочитаны в одном снимке.
        ReadDue: DateTimeOffset -> int -> Task<DueBacklog * MeetupSnapshot list>
        Commit:
            MeetupStore.EventEnvelope
                -> int64 option
                -> MeetupState
                -> MeetupEvent
                -> Task<Result<MeetupSnapshot, MeetupStore.VersionConflict>>
        Now: unit -> DateTimeOffset
        NewEventId: unit -> Guid
        BatchSize: int
    }

/// Счёт пройденного пачкой.
type private BatchTally =
    {
        Published: int
        Claimed: int
        Blocked: (MeetupId * DomainError) list
        Failed: (MeetupId * string) list
        Cancelled: bool
    }

/// Одна сходка из набора.
///
/// Решение принимается из снимка, прочитанного сканом, и он же даёт ожидаемую
/// версию. В этом и состоит защита от двойного выполнения: `MeetupStore.commit`
/// пишет состояние предикатом `WHERE id = @id AND version = @expected_version`, и
/// второй претендент на ту же строку получает `VersionConflict` вместо второго
/// события (ADR-024, ось 3b; «Однократность даёт не отметка о публикации, а атомарный
/// переход состояния»). Момент очищается тем же переходом — обнуление живёт в
/// применении события, а не в отдельном UPDATE (PER-280).
let private attempt (deps: Deps) (now: DateTimeOffset) (snapshot: MeetupSnapshot) : Task<Attempt> =
    task {
        let state = Meetup.restore (Some snapshot)

        match Meetup.decidePublish now state with
        | Error error -> return Attempt.Blocked(snapshot.Id, error)
        // «Цель уже достигнута» здесь невыразимо, и это свойство выборки, а не удача:
        // `Ok None` приходит только от уже видимой сходки, а набор отбирает строки
        // предикатом `visibility = 'hidden'`, который schema держит CHECK-ограничением
        // `meetups_scheduled_publish_only_when_hidden`. Отдельного тихого исхода «нас
        // опередили» поэтому нет: ручная публикация в окне гонки не меняет снимок тика
        // и приходит расхождением версий, то есть `Claimed`.
        //
        // `invalidOp`, а не молчаливый пропуск, по той же причине, по которой он стоит
        // в `PublishMeetup`: это нарушение внутреннего контракта между выборкой и
        // решением, а не отказ, который кто-то должен читать. Тик от него не гибнет —
        // обход пачки ловит его на этой сходке и идёт дальше.
        | Ok None -> return invalidOp "the due set yielded a meetup that is already visible"
        | Ok(Some event) ->
            let envelope: MeetupStore.EventEnvelope =
                {
                    EventId = deps.NewEventId()
                    PerformedBy = clockPerformer
                    OccurredAt = now
                }

            match! deps.Commit envelope (Some snapshot.Version) state event with
            | Ok _ -> return Attempt.Published snapshot.Id
            | Error MeetupStore.VersionConflict -> return Attempt.Claimed snapshot.Id
    }

/// Обход пачки. Первый неуспех её НЕ останавливает, и это осознанное расхождение с
/// `DispatchMeetupEvents`: там остановка защищает порядок версий одного потребителя,
/// здесь сходки независимы друг от друга, и остановка дала бы одному черновику без
/// заголовка держать публикацию всех остальных.
let rec private publishBatch
    (deps: Deps)
    (now: DateTimeOffset)
    (token: CancellationToken)
    (remaining: MeetupSnapshot list)
    (tally: BatchTally)
    : Task<BatchTally> =
    task {
        match remaining with
        | [] -> return tally
        | snapshot :: rest ->
            if token.IsCancellationRequested then
                return
                    { tally with
                        Cancelled = true
                    }
            else
                // Отказ ловится на сходке, а не на пачке. Выпущенное наружу
                // исключение унесло бы весь отчёт тика — вместе с публикациями,
                // которые эта же пачка уже записала, — и остановка, убранная выше для
                // доменных отказов, вернулась бы через исключение.
                let! outcome =
                    task {
                        try
                            return! attempt deps now snapshot
                        with
                        // Отмена — не отказ сходки: её несёт цикл, и глотать её здесь
                        // значило бы отчитаться о плохой строке вместо остановки.
                        // `reraise` доступен только прямо в `with`, поэтому исключение
                        // переносится тем же `ExceptionDispatchInfo`, что и в соседнем
                        // срезе.
                        | :? OperationCanceledException as cancelled ->
                            ExceptionDispatchInfo.Capture(cancelled).Throw()
                            return Attempt.Failed(snapshot.Id, "cancelled")
                        | failure -> return Attempt.Failed(snapshot.Id, failure.Message)
                    }

                let advanced =
                    match outcome with
                    | Attempt.Published _ ->
                        { tally with
                            Published = tally.Published + 1
                        }
                    | Attempt.Claimed _ ->
                        { tally with
                            Claimed = tally.Claimed + 1
                        }
                    | Attempt.Blocked(id, error) ->
                        { tally with
                            Blocked = tally.Blocked @ [ id, error ]
                        }
                    | Attempt.Failed(id, reason) ->
                        { tally with
                            Failed = tally.Failed @ [ id, reason ]
                        }

                return! publishBatch deps now token rest advanced
    }

/// Один тик отложенной публикации.
///
/// Часы читаются ровно один раз и идут и в выборку параметром `@now`, и в
/// `decidePublish`, и в конверт события. Иначе размер набора и опубликованное
/// описывали бы разные мгновения, а тест «момент наступил» пришлось бы изображать
/// сном.
let execute (deps: Deps) (token: CancellationToken) : Task<TickReport> =
    task {
        let now = deps.Now()
        let! backlog, due = deps.ReadDue now deps.BatchSize

        let! tally =
            publishBatch
                deps
                now
                token
                due
                {
                    Published = 0
                    Claimed = 0
                    Blocked = []
                    Failed = []
                    Cancelled = false
                }

        return
            {
                Backlog = backlog
                // Возраст меряется от назначенного момента, то есть это просрочка
                // публикации, а не возраст строки.
                OldestDueAge =
                    backlog.OldestDueAt
                    |> Option.map (fun dueAt -> now - dueAt)
                Published = tally.Published
                Claimed = tally.Claimed
                Blocked = tally.Blocked
                Failed = tally.Failed
                Cancelled = tally.Cancelled
            }
    }

/// Composition root среза: здесь заканчивается DI.
module Composition =

    open Microsoft.Extensions.Configuration
    open Microsoft.Extensions.DependencyInjection
    open Npgsql

    /// Рабочие параметры, а не решения: ADR-024 прямо назвал интервал опроса тем, что
    /// меняется без нового ADR, и требований к точности момента продукт не
    /// предъявляет.
    [<Literal>]
    let BatchSizeVariable = "MEETUPS_PUBLICATION_BATCH_SIZE"

    [<Literal>]
    let IntervalVariable = "MEETUPS_PUBLICATION_INTERVAL_SECONDS"

    let defaultBatchSize = 100

    /// Потолок пачки: обход рекурсивен, и неограниченное значение из конфигурации
    /// превратилось бы в переполнение стека вместо отказа настройки.
    let maxBatchSize = 1000

    /// Тридцать секунд, а не две, как у публикации из журнала: допустимая задержка
    /// здесь — единицы минут (ADR-024), и опрашивать таблицу сходок чаще незачем.
    let defaultIntervalSeconds = 30

    /// Час — предел защитный, а не осмысленный: он оставляет опечатку в конфигурации
    /// наблюдаемой как редкий тик, а не как молчащий сервис.
    let maxIntervalSeconds = 3600

    /// Второй экземпляр разбора после `DispatchMeetupEvents.Composition`. Общий модуль
    /// не заводится: три строки на границе DI дешевле, чем модуль, ради которого
    /// обеим фоновым границам пришлось бы знать друг о друге.
    let private positive (configuration: IConfiguration) (name: string) (fallback: int) (ceiling: int) =
        match Int32.TryParse configuration[name] with
        | true, value when value > 0 -> min value ceiling
        | _ -> fallback

    let batchSize (configuration: IConfiguration) =
        positive configuration BatchSizeVariable defaultBatchSize maxBatchSize

    let interval (configuration: IConfiguration) =
        positive configuration IntervalVariable defaultIntervalSeconds maxIntervalSeconds
        |> float
        |> TimeSpan.FromSeconds

    let private toBacklog (row: DuePublicationStore.DueBacklogRow) : DueBacklog =
        {
            Due = row.Due
            OldestDueAt = Option.ofNullable row.OldestDueAt
        }

    let buildDeps (services: IServiceProvider) : Deps =
        let source = services.GetRequiredService<NpgsqlDataSource>()
        let configuration = services.GetRequiredService<IConfiguration>()

        {
            ReadDue =
                fun now limit ->
                    task {
                        let! backlog, snapshots = DuePublicationStore.readDue source now limit

                        return toBacklog backlog, snapshots
                    }
            Commit = MeetupStore.commit source
            // UtcNow, а не Now: TIMESTAMPTZ принимает DateTimeOffset только с нулевым
            // смещением, и локальное время упало бы уже в рантайме.
            Now = fun () -> DateTimeOffset.UtcNow
            NewEventId = Guid.CreateVersion7
            BatchSize = batchSize configuration
        }
