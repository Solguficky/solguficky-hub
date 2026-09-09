/// Единственный путь продуктового чтения сходок. Обе gRPC-операции передают сюда
/// смотрящего и область выборки; SQL и отображение строки наружу не выставлены.
/// Командный MeetupStore.load остаётся отдельным служебным чтением состояния для
/// принятия решения и намеренно не применяет правила наблюдаемости.
module Meetups.Infrastructure.MeetupReading

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
        lifecycle AS Lifecycle,
        visibility AS Visibility,
        first_published_at AS FirstPublishedAt,
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
            return rows |> Seq.map MeetupRow.toSnapshot |> List.ofSeq |> ReadResult.Snapshots
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

            let! exists = connection.ExecuteScalarAsync<bool>(existsByIdSql, {| id = id |})

            match rows |> Seq.map MeetupRow.toSnapshot |> List.ofSeq with
            | [ snapshot ] -> return ReadResult.Snapshots [ snapshot ]
            | [] when exists -> return ReadResult.NotVisible
            | [] -> return ReadResult.NotFound
            | _ -> return invalidOp "a primary-key lookup returned more than one meetup"
    }
