/// Срез «показать список актуальных сходок». Запрос идёт через единый viewer-aware
/// путь, и правило видимости ADR-022 применяет он же, а не этот срез. Архивные
/// сходки — состоявшиеся, отменённые и прошедшие по расписанию — отсеиваются здесь
/// доменным правилом Archive; их читает соседний срез ListArchivedMeetups.
module Meetups.Slices.ListVisibleMeetups

open System
open System.Threading.Tasks
open Meetups.Domain
open Meetups.Infrastructure

type Query =
    {
        Viewer: Viewer
    }

[<RequireQualifiedAccess; NoComparison>]
type ListVisibleMeetupsError = Malformed of Contract.InvalidRequest

/// Календарный день сообщества приходит значением, как и часы команд: домен часов
/// не читает, а тест подставляет день без базы и без сна.
[<NoEquality; NoComparison>]
type Deps =
    {
        Read: Viewer -> Task<MeetupSnapshot list>
        Today: unit -> DateOnly
    }

let execute (deps: Deps) (query: Query) : Task<MeetupSnapshot list> =
    task {
        let! snapshots = deps.Read query.Viewer
        let today = deps.Today()

        return
            snapshots
            |> List.filter (fun snapshot -> not (Archive.isArchived today snapshot))
            |> List.sortBy (fun snapshot -> Schedule.order snapshot.Schedule)
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

    let private toStatus (error: ListVisibleMeetupsError) : Status =
        match error with
        | ListVisibleMeetupsError.Malformed invalid ->
            Status(StatusCode.InvalidArgument, $"{invalid.Field} {invalid.Problem}")

    let handle
        (deps: Deps)
        (request: Meetups.V1.ListVisibleMeetupsRequest)
        : Task<Meetups.V1.ListVisibleMeetupsResponse> =
        task {
            match Contract.Inbound.viewer request.Viewer with
            | Error invalid -> return raise (RpcException(toStatus (ListVisibleMeetupsError.Malformed invalid)))
            | Ok viewer ->
                let! snapshots =
                    execute
                        deps
                        {
                            Viewer = viewer
                        }

                let response = Meetups.V1.ListVisibleMeetupsResponse()
                response.Meetups.Add(snapshots |> Seq.map Contract.Outbound.summary)
                return response
        }
