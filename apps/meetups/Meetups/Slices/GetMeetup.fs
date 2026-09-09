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

[<RequireQualifiedAccess; NoComparison>]
type GetMeetupError =
    | Malformed of Contract.InvalidRequest
    | NotFound

let execute
    (read: Viewer -> MeetupId -> Task<MeetupSnapshot option>)
    (query: Query)
    : Task<Result<MeetupSnapshot, GetMeetupError>> =
    task {
        match! read query.Viewer query.Id with
        | None -> return Error GetMeetupError.NotFound
        | Some snapshot -> return Ok snapshot
    }

module Composition =

    open Microsoft.Extensions.DependencyInjection
    open Npgsql

    let buildRead (services: IServiceProvider) =
        let source = services.GetRequiredService<NpgsqlDataSource>()

        fun viewer id ->
            task {
                match! MeetupReading.read source viewer (MeetupReading.Scope.ById id) with
                | [] -> return None
                | [ snapshot ] -> return Some snapshot
                | _ -> return invalidOp "a primary-key lookup returned more than one meetup"
            }

module Api =

    open Grpc.Core

    let private toStatus (error: GetMeetupError) : Status =
        match error with
        | GetMeetupError.Malformed invalid -> Status(StatusCode.InvalidArgument, $"{invalid.Field} {invalid.Problem}")
        | GetMeetupError.NotFound -> Status(StatusCode.NotFound, "meetup not found")

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
        (read: Viewer -> MeetupId -> Task<MeetupSnapshot option>)
        (request: Meetups.V1.GetMeetupRequest)
        : Task<Meetups.V1.MeetupSnapshot> =
        task {
            match toQuery request with
            | Error invalid -> return raise (RpcException(toStatus (GetMeetupError.Malformed invalid)))
            | Ok query ->
                match! execute read query with
                | Ok snapshot -> return Contract.Outbound.snapshot snapshot
                | Error error -> return raise (RpcException(toStatus error))
        }
