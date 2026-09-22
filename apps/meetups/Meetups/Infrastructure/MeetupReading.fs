/// Единственный путь продуктового чтения сходок. Обе gRPC-операции передают сюда
/// смотрящего и область выборки; SQL и отображение строки наружу не выставлены.
/// Командный MeetupStore.load остаётся отдельным служебным чтением состояния для
/// принятия решения и намеренно не применяет правила наблюдаемости.
module Meetups.Infrastructure.MeetupReading

open System
open System.Threading.Tasks
open Dapper
open Meetups.Domain
open Npgsql

[<RequireQualifiedAccess>]
type Scope =
    | All
    | ById of MeetupId

[<RequireQualifiedAccess>]
type ReadResult =
    | Snapshots of MeetupSnapshot list
    | NotFound
    | NotVisible

/// Страница служебного обхода: снимки и момент транзакции, в которой они прочитаны.
/// Отдельный тип, а не ReadResult: отказа наблюдаемости у этого чтения не бывает,
/// и вариант его отказа здесь значил бы ветку, которую нечем заполнить.
type StatesPage =
    {
        Snapshots: MeetupSnapshot list
        ConsistentAt: DateTimeOffset
    }

do Db.ensureTypeHandlers ()

let private selectAllSql =
    """
    SELECT
        id AS Id,
        author AS Author,
        title AS Title,
        description AS Description,
        venue AS Venue,
        kind AS Kind,
        calendar_link AS CalendarLink,
        materials AS Materials,
        lifecycle AS Lifecycle,
        visibility AS Visibility,
        first_published_at AS FirstPublishedAt,
        scheduled_publish_at AS ScheduledPublishAt,
        version AS Version,
        schedule_form AS ScheduleForm,
        schedule_precision AS SchedulePrecision,
        schedule_start_date AS ScheduleStartDate,
        schedule_start_time AS ScheduleStartTime,
        schedule_end_date AS ScheduleEndDate,
        schedule_end_time AS ScheduleEndTime
    FROM meetups
    """

let private visibleToViewerSql =
    """
    WHERE (
        visibility = 'visible'
        OR author = @viewer_id
        OR @is_administrator
    )
    """

let private selectVisibleSql = selectAllSql + visibleToViewerSql
let private selectVisibleByIdSql = selectVisibleSql + " AND id = @id"
let private existsByIdSql = "SELECT EXISTS (SELECT 1 FROM meetups WHERE id = @id)"

/// Keyset-страница служебного обхода. Фрагмент склеивается здесь, рядом с общим
/// списком колонок: вторая склейка из чужого модуля дала бы `WHERE ... WHERE`
/// молча, на пути, который никакой тест не проходит.
///
/// Нулевой UUID — минимум порядка `uuid` в PostgreSQL, и сходке он достаться не
/// может: идентификатор выдаётся UUIDv7. Поэтому начало обхода выражается тем же
/// сравнением, что и продолжение, и ветка `@after IS NULL`, из-за которой
/// планировщик теряет индекс по первичному ключу, запросу не нужна.
let private keysetPageSql =
    """
    WHERE id > @after
    ORDER BY id
    LIMIT @limit
    """

let private selectStatesPageSql = selectAllSql + keysetPageSql

let private consistencyMomentSql = "SELECT transaction_timestamp()"

/// Both lookup outcomes execute the same two statements in the same order. The
/// second lookup is not skipped after a visible hit: keeping the database work
/// independent of existence prevents the hidden/missing branch order from
/// becoming a useful timing oracle while retaining the real denial reason for
/// the boundary log.
let read (source: NpgsqlDataSource) (viewer: Viewer) (scope: Scope) : Task<ReadResult> =
    task {
        use! connection = source.OpenConnectionAsync()

        let (PersonId viewerId) = viewer.IdentityId

        let parameters =
            {|
                viewer_id = viewerId
                is_administrator = Viewer.isAdministrator viewer
            |}

        match scope with
        | Scope.All ->
            let! rows = connection.QueryAsync<MeetupRow.MeetupRow>(selectVisibleSql, parameters)

            return
                rows
                |> Seq.map MeetupRow.toSnapshot
                |> List.ofSeq
                |> ReadResult.Snapshots
        | Scope.ById(MeetupId id) ->
            let! rows =
                connection.QueryAsync<MeetupRow.MeetupRow>(
                    selectVisibleByIdSql,
                    {|
                        id = id
                        viewer_id = viewerId
                        is_administrator = Viewer.isAdministrator viewer
                    |}
                )

            let! exists =
                connection.ExecuteScalarAsync<bool>(
                    existsByIdSql,
                    {|
                        id = id
                    |}
                )

            match rows |> Seq.map MeetupRow.toSnapshot |> List.ofSeq with
            | [ snapshot ] -> return ReadResult.Snapshots [ snapshot ]
            | [] when exists -> return ReadResult.NotVisible
            | [] -> return ReadResult.NotFound
            | _ -> return invalidOp "a primary-key lookup returned more than one meetup"
    }

/// Служебный обход состояния страницами. Смотрящего не принимает и правил
/// наблюдаемости не применяет намеренно: страницу читает реплика, а не человек.
///
/// Момент берётся внутри той же repeatable-read транзакции, что и строки, поэтому
/// он называет ровно тот снимок базы, который уехал потребителю. Тип момента —
/// DateTime, а не DateTimeOffset: `timestamptz` Npgsql отдаёт именно им, а
/// скалярный путь Dapper идёт мимо десериализатора строки и знает только
/// `Convert.ChangeType`, которому преобразования DateTime → DateTimeOffset взять
/// неоткуда. Обёртка стоит здесь, на единственном скалярном чтении момента, а не
/// в общем handler: она не расширяет набор известных Dapper типов, а закрывает
/// один вызов.
let readStates (source: NpgsqlDataSource) (after: MeetupId option) (limit: int) : Task<StatesPage> =
    task {
        use! connection = source.OpenConnectionAsync()
        use! transaction = connection.BeginTransactionAsync(System.Data.IsolationLevel.RepeatableRead)

        let! at = connection.ExecuteScalarAsync<DateTime>(consistencyMomentSql, transaction = transaction)

        let afterId =
            match after with
            | Some(MeetupId id) -> id
            | None -> Guid.Empty

        let! rows =
            connection.QueryAsync<MeetupRow.MeetupRow>(
                selectStatesPageSql,
                {|
                    after = afterId
                    limit = limit
                |},
                transaction
            )

        do! transaction.CommitAsync()

        return
            {
                Snapshots = rows |> Seq.map MeetupRow.toSnapshot |> List.ofSeq
                ConsistentAt = DateTimeOffset(DateTime.SpecifyKind(at, DateTimeKind.Utc))
            }
    }
