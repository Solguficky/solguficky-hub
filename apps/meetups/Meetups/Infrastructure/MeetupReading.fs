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

let private selectByIdSql = selectAllSql + " WHERE id = @id"

/// PER-58 вводит обязательный viewer-aware шов, но правило наблюдаемости остаётся
/// границей PER-59. Поэтому смотрящий пока намеренно не влияет на результат: этот
/// временный путь пропускает все строки и не обращается к Identity.
let read (source: NpgsqlDataSource) (_viewer: Viewer) (scope: Scope) : Task<MeetupSnapshot list> =
    task {
        use! connection = source.OpenConnectionAsync()

        let! rows =
            match scope with
            | Scope.All -> connection.QueryAsync<MeetupRow.MeetupRow>(selectAllSql)
            | Scope.ById(MeetupId id) ->
                connection.QueryAsync<MeetupRow.MeetupRow>(
                    selectByIdSql,
                    {|
                        id = id
                    |}
                )

        return rows |> Seq.map MeetupRow.toSnapshot |> List.ofSeq
    }
