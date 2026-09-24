/// Срез «может ли человек действовать от имени сходки». Отвечает только о праве:
/// сценарий вызывающей стороны — рассылка Notifications или что-то следующее — сюда
/// не входит, поэтому ни в запросе, ни в ответе его нет (PER-224).
///
/// Правило то же, что у пишущих команд, — `Access.actOnBehalf`, и спрашивается оно
/// так же, до загрузки: посторонний получает один и тот же отказ для существующей,
/// скрытой и отсутствующей сходки, а работа сервиса от существования не зависит,
/// поэтому ответ неразличим и по времени. Различать «сходки нет» и «права нет»
/// можно только тому, кто право имеет: администратор видит любую сходку, и
/// существование для него не тайна.
module Meetups.Slices.CheckMeetupAuthority

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
type CheckMeetupAuthorityError =
    | Malformed of Contract.InvalidRequest
    | Forbidden of AccessDenied
    | NotFound

/// Ответ свежий на каждый вызов: кэша нет ни здесь, ни в контракте, потому что
/// устаревшее разрешение равносильно пропущенной проверке (ADR-026).
let execute
    (load: MeetupId -> Task<MeetupSnapshot option>)
    (query: Query)
    : Task<Result<unit, CheckMeetupAuthorityError>> =
    task {
        match Access.actOnBehalf query.Viewer with
        | Error denied -> return Error(CheckMeetupAuthorityError.Forbidden denied)
        | Ok() ->
            match! load query.Id with
            | Some _ -> return Ok()
            | None -> return Error CheckMeetupAuthorityError.NotFound
    }

/// Загрузка та же, что у команд: вопрос задаётся от их имени, и видимость на него
/// не влияет — к этой точке дошёл только тот, кто видит любую сходку.
module Composition =

    open Microsoft.Extensions.DependencyInjection
    open Npgsql

    let buildLoad (services: IServiceProvider) : MeetupId -> Task<MeetupSnapshot option> =
        let source = services.GetRequiredService<NpgsqlDataSource>()
        MeetupStore.load source

module Api =

    open Grpc.Core

    let private toStatus (error: CheckMeetupAuthorityError) : Status =
        match error with
        | CheckMeetupAuthorityError.Malformed invalid ->
            Status(StatusCode.InvalidArgument, $"{invalid.Field} {invalid.Problem}")
        | CheckMeetupAuthorityError.Forbidden NotAnAdministrator ->
            Status(StatusCode.PermissionDenied, "an administrator role is required")
        | CheckMeetupAuthorityError.NotFound -> Status(StatusCode.NotFound, "meetup not found")

    let private toQuery (request: Meetups.V1.CheckMeetupAuthorityRequest) : Result<Query, Contract.InvalidRequest> =
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
        (load: MeetupId -> Task<MeetupSnapshot option>)
        (request: Meetups.V1.CheckMeetupAuthorityRequest)
        : Task<Meetups.V1.MeetupAuthority> =
        task {
            match toQuery request with
            | Error invalid -> return raise (RpcException(toStatus (CheckMeetupAuthorityError.Malformed invalid)))
            | Ok query ->
                match! execute load query with
                | Ok() -> return Meetups.V1.MeetupAuthority()
                | Error error -> return raise (RpcException(toStatus error))
        }
