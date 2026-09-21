/// Срез «показать архив сходок». Архив — не ось и не четвёртое значение жизненного
/// цикла, а производное чтение: сюда попадают состоявшиеся, отменённые и прошедшие
/// по расписанию. Читает срез тем же единым viewer-aware путём, что и актуальный
/// список, поэтому архив не открывает скрытое.
module Meetups.Slices.ListArchivedMeetups

open System
open System.Threading.Tasks
open Meetups.Domain
open Meetups.Infrastructure

type Query =
    {
        Viewer: Viewer
    }

[<RequireQualifiedAccess; NoComparison>]
type ListArchivedMeetupsError = Malformed of Contract.InvalidRequest

[<NoEquality; NoComparison>]
type Deps =
    {
        Read: Viewer -> Task<MeetupSnapshot list>
        Today: unit -> DateOnly
    }

/// Архив читают с конца: новейшая сходка первой. Сходка без даты не получает
/// вымышленного места среди датированных и идёт после них. Равные расписания
/// остаются без дополнительного порядка — как и в актуальном списке (ADR-022).
let private newestFirst (snapshots: MeetupSnapshot list) =
    let dated, undated =
        snapshots
        |> List.partition (fun snapshot ->
            match Schedule.order snapshot.Schedule with
            | ScheduleOrder.Dated _ -> true
            | ScheduleOrder.Undated -> false
        )

    (dated
     |> List.sortByDescending (fun snapshot -> Archive.sortOrder snapshot.Schedule))
    @ undated

let execute (deps: Deps) (query: Query) : Task<MeetupSnapshot list> =
    task {
        let! snapshots = deps.Read query.Viewer
        let today = deps.Today()

        return
            snapshots
            |> List.filter (Archive.isArchived today)
            |> newestFirst
    }

module Composition =

    open Microsoft.Extensions.DependencyInjection
    open Npgsql

    let buildDeps (services: IServiceProvider) : Deps =
        let source = services.GetRequiredService<NpgsqlDataSource>()
        let zone = services.GetRequiredService<TimeZoneInfo>()

        {
            Read =
                fun viewer ->
                    task {
                        match! MeetupReading.read source viewer MeetupReading.Scope.All with
                        | MeetupReading.ReadResult.Snapshots snapshots -> return snapshots
                        | MeetupReading.ReadResult.NotFound
                        | MeetupReading.ReadResult.NotVisible ->
                            return invalidOp "an unscoped meetup read returned a lookup denial"
                    }
            Today = fun () -> CommunityTime.today zone (DateTimeOffset.UtcNow)
        }

module Api =

    open Grpc.Core

    let private toStatus (error: ListArchivedMeetupsError) : Status =
        match error with
        | ListArchivedMeetupsError.Malformed invalid ->
            Status(StatusCode.InvalidArgument, $"{invalid.Field} {invalid.Problem}")

    let handle
        (deps: Deps)
        (request: Meetups.V1.ListArchivedMeetupsRequest)
        : Task<Meetups.V1.ListArchivedMeetupsResponse> =
        task {
            match Contract.Inbound.viewer request.Viewer with
            | Error invalid -> return raise (RpcException(toStatus (ListArchivedMeetupsError.Malformed invalid)))
            | Ok viewer ->
                let! snapshots =
                    execute
                        deps
                        {
                            Viewer = viewer
                        }

                let response = Meetups.V1.ListArchivedMeetupsResponse()
                response.Meetups.Add(snapshots |> Seq.map Contract.Outbound.summary)
                return response
        }
