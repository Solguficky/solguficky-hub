/// Срез «в каком состоянии сходка». Служебный, как `ListMeetupStates`: человека
/// в запросе нет, и правил человеческой видимости он не применяет. Вызывающий —
/// экран зала Auction — решает по состоянию свои ворота сам и данных сходки не
/// показывает, поэтому скрытая сходка в ответе — не утечка, а условие задачи
/// (ADR-040, дополнение 2026-10-19). Для обратимой видимости это синхронный ответ
/// вместо реплики в Auction (ADR-047, отвергнутые варианты дополнения 2026-10-12).
module Meetups.Slices.GetMeetupStanding

open System
open System.Threading.Tasks
open Meetups.Domain
open Meetups.Infrastructure

[<RequireQualifiedAccess; NoComparison>]
type GetMeetupStandingError =
    | Malformed of Contract.InvalidRequest
    | NotFound

let execute
    (load: MeetupId -> Task<MeetupSnapshot option>)
    (id: MeetupId)
    : Task<Result<MeetupSnapshot, GetMeetupStandingError>> =
    task {
        match! load id with
        | Some meetup -> return Ok meetup
        | None -> return Error GetMeetupStandingError.NotFound
    }

module Composition =

    open Microsoft.Extensions.DependencyInjection
    open Npgsql

    let buildLoad (services: IServiceProvider) = MeetupStore.load (services.GetRequiredService<NpgsqlDataSource>())

module Api =

    open Grpc.Core

    let private toStatus (error: GetMeetupStandingError) : Status =
        match error with
        | GetMeetupStandingError.Malformed invalid ->
            Status(StatusCode.InvalidArgument, $"{invalid.Field} {invalid.Problem}")
        | GetMeetupStandingError.NotFound -> Status(StatusCode.NotFound, "meetup not found")

    let handle
        (load: MeetupId -> Task<MeetupSnapshot option>)
        (request: Meetups.V1.GetMeetupStandingRequest)
        : Task<Meetups.V1.MeetupStanding> =
        task {
            match Contract.Inbound.meetupId request.Id with
            | Error invalid -> return raise (RpcException(toStatus (GetMeetupStandingError.Malformed invalid)))
            | Ok id ->
                match! execute load id with
                | Ok meetup ->
                    return
                        Meetups.V1.MeetupStanding(
                            Lifecycle = Contract.Outbound.lifecycle meetup.Lifecycle,
                            Visibility = Contract.Outbound.visibility meetup.Visibility
                        )
                | Error error -> return raise (RpcException(toStatus error))
        }
