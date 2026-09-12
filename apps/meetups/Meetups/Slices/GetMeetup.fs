/// Срез «показать сходку». Отсутствующая строка и будущий отказ наблюдаемости
/// сходятся в одном NotFound, поэтому transport не сможет различить их.
module Meetups.Slices.GetMeetup

open System
open System.Threading.Tasks
open Meetups.Domain
open Meetups.Infrastructure

type Query =
    {
        Id: MeetupId
        Viewer: Viewer
    }

[<RequireQualifiedAccess>]
type NotFoundReason =
    | Missing
    | NotVisible

[<RequireQualifiedAccess; NoComparison>]
type GetMeetupError =
    | Malformed of Contract.InvalidRequest
    | NotFound of reason: NotFoundReason

[<RequireQualifiedAccess>]
type LookupResult =
    | Found of MeetupSnapshot
    | Missing
    | NotVisible

let execute
    (read: Viewer -> MeetupId -> Task<LookupResult>)
    (query: Query)
    : Task<Result<MeetupSnapshot, GetMeetupError>> =
    task {
        match! read query.Viewer query.Id with
        | LookupResult.Found snapshot -> return Ok snapshot
        | LookupResult.Missing -> return Error(GetMeetupError.NotFound NotFoundReason.Missing)
        | LookupResult.NotVisible -> return Error(GetMeetupError.NotFound NotFoundReason.NotVisible)
    }

module Composition =

    open Microsoft.Extensions.DependencyInjection
    open Npgsql

    let buildRead (services: IServiceProvider) =
        let source = services.GetRequiredService<NpgsqlDataSource>()

        fun viewer id ->
            task {
                match! MeetupReading.read source viewer (MeetupReading.Scope.ById id) with
                | MeetupReading.ReadResult.Snapshots [ snapshot ] -> return LookupResult.Found snapshot
                | MeetupReading.ReadResult.NotFound -> return LookupResult.Missing
                | MeetupReading.ReadResult.NotVisible -> return LookupResult.NotVisible
                | MeetupReading.ReadResult.Snapshots _ ->
                    return invalidOp "a primary-key lookup returned an invalid result count"
            }

module Api =

    open Grpc.Core

    let private toStatus (error: GetMeetupError) : Status =
        match error with
        | GetMeetupError.Malformed invalid -> Status(StatusCode.InvalidArgument, $"{invalid.Field} {invalid.Problem}")
        | GetMeetupError.NotFound _ -> Status(StatusCode.NotFound, "meetup not found")

    let private notFoundException reason =
        let declined = RpcException(toStatus (GetMeetupError.NotFound reason))

        declined.Data["meetups.denial_reason"] <-
            match reason with
            | NotFoundReason.Missing -> "missing"
            | NotFoundReason.NotVisible -> "not_visible"

        declined

    let private toQuery (request: Meetups.V1.GetMeetupRequest) : Result<Query, Contract.InvalidRequest> =
        match Contract.Inbound.viewer request.Viewer, Contract.Inbound.meetupId request.Id with
        | Ok viewer, Ok id ->
            Ok
                {
                    Id = id
                    Viewer = viewer
                }
        | Error invalid, _
        | _, Error invalid -> Error invalid

    let handle
        (read: Viewer -> MeetupId -> Task<LookupResult>)
        (request: Meetups.V1.GetMeetupRequest)
        : Task<Meetups.V1.MeetupSnapshot> =
        task {
            match toQuery request with
            | Error invalid -> return raise (RpcException(toStatus (GetMeetupError.Malformed invalid)))
            | Ok query ->
                match! execute read query with
                | Ok snapshot -> return Contract.Outbound.snapshot snapshot
                | Error(GetMeetupError.NotFound reason) -> return raise (notFoundException reason)
                | Error error -> return raise (RpcException(toStatus error))
        }
