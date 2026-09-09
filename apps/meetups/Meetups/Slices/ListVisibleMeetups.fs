/// Срез «показать список видимых сходок». PER-58 проводит запрос через единый
/// viewer-aware путь; само правило видимости добавляет PER-59.
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

let execute (read: Viewer -> Task<MeetupSnapshot list>) (query: Query) : Task<MeetupSnapshot list> =
    task {
        let! snapshots = read query.Viewer

        return
            snapshots
            |> List.sortBy (fun snapshot -> Schedule.order snapshot.Schedule)
    }

module Composition =

    open Microsoft.Extensions.DependencyInjection
    open Npgsql

    let buildRead (services: IServiceProvider) =
        let source = services.GetRequiredService<NpgsqlDataSource>()
        fun viewer -> MeetupReading.read source viewer MeetupReading.Scope.All

module Api =

    open Grpc.Core

    let private toStatus (error: ListVisibleMeetupsError) : Status =
        match error with
        | ListVisibleMeetupsError.Malformed invalid ->
            Status(StatusCode.InvalidArgument, $"{invalid.Field} {invalid.Problem}")

    let private summary (snapshot: MeetupSnapshot) : Meetups.V1.MeetupSummary =
        let (MeetupId id) = snapshot.Id

        Meetups.V1.MeetupSummary(
            Id = id.ToString "D",
            Title = snapshot.Title,
            Venue = snapshot.Venue,
            Schedule = Contract.Outbound.schedule snapshot.Schedule,
            Lifecycle = Contract.Outbound.lifecycle snapshot.Lifecycle,
            Visibility = Contract.Outbound.visibility snapshot.Visibility
        )

    let handle
        (read: Viewer -> Task<MeetupSnapshot list>)
        (request: Meetups.V1.ListVisibleMeetupsRequest)
        : Task<Meetups.V1.ListVisibleMeetupsResponse> =
        task {
            match Contract.Inbound.viewer request.Viewer with
            | Error invalid -> return raise (RpcException(toStatus (ListVisibleMeetupsError.Malformed invalid)))
            | Ok viewer ->
                let! snapshots =
                    execute
                        read
                        {
                            Viewer = viewer
                        }

                let response = Meetups.V1.ListVisibleMeetupsResponse()
                response.Meetups.Add(snapshots |> Seq.map summary)
                return response
        }
