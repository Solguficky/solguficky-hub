/// Срез «стоит ли человек в одном из принимаемых отношений к сходке». Отвечает
/// только о праве: сценарий вызывающей стороны — рассылка Notifications или что-то
/// следующее — сюда не входит, поэтому ни в запросе, ни в ответе его нет (PER-224).
///
/// Вызывающий приносит человека и набор отношений, но не роли: глобальную роль для
/// отношения «администратор» Meetups спрашивает у Identity сам, на каждом запросе и
/// без кэша (ADR-051). Роль, присланную вызывающим, пришлось бы принимать на веру.
///
/// Решение по-прежнему принимается до загрузки: единственное отношение держится на
/// глобальной роли, а не на записи сходки. Посторонний получает один и тот же отказ
/// для существующей, скрытой и отсутствующей сходки, а работа сервиса от
/// существования не зависит, поэтому ответ неразличим и по времени. Различать
/// «сходки нет» и «права нет» можно только тому, чьё право уже подтверждено:
/// администратор видит любую сходку, и существование для него не тайна.
module Meetups.Slices.CheckMeetupAuthority

open System
open System.Threading.Tasks
open Meetups
open Meetups.Domain
open Meetups.Infrastructure

type Query =
    {
        Id: MeetupId
        Person: PersonId
        Accepted: Set<MeetupRelation>
    }

/// Отказ Identity ответить. Два случая, а не один, потому что вызывающему они
/// сообщают разное: недоступность — «право не подтверждено, попробуйте позже»,
/// прочее — дефект одной из сторон. Ни один не превращается в «права нет» и тем
/// более в «право есть» (ADR-051, п. 6). Неизвестный Identity человек сюда не
/// попадает: адаптер сводит его к отказу в праве, чтобы NOT_FOUND не утёк.
[<RequireQualifiedAccess>]
type IdentityFailure =
    | Unavailable of string
    | Failed of string

/// Держит ли человек хотя бы одну из ролей — вопрос `CheckGlobalRole`.
type AskRoles = PersonId -> Set<GlobalRole> -> Task<Result<bool, IdentityFailure>>

/// То, что входящий вызов передаёт вызову Identity. `request_id` и `use_case`
/// уходят заголовками: цепочка одна, и они рождены на краю, а не здесь (logging.md).
/// Срок и отмена вызывающего ограничивают вызов Identity: ждать ответа дольше, чем
/// его ждёт вызывающий, значит отвечать в закрытый поток.
[<NoComparison>]
type Forwarded =
    {
        RequestId: RequestId option
        UseCase: string option
        /// Срок входящего вызова в UTC; `DateTime.MaxValue`, когда вызывающий его
        /// не задал — так его отдаёт gRPC.
        Deadline: DateTime
        Cancellation: Threading.CancellationToken
    }

/// Порт Identity. `Unconfigured` — не заглушка, а состояние сервиса, запущенного
/// без адреса Identity, как у порта публикации без адреса шины. Порт, отвечающий
/// «нет», выдал бы отсутствие настройки за отсутствие права; порт, отвечающий «да»,
/// раздал бы право всем. Честный ответ без источника права — UNAVAILABLE.
[<RequireQualifiedAccess; NoComparison; NoEquality>]
type Port =
    | Unconfigured
    | Connected of (Forwarded -> AskRoles)

[<NoComparison; NoEquality>]
type Deps =
    {
        AskRoles: AskRoles option
        Load: MeetupId -> Task<MeetupSnapshot option>
    }

[<RequireQualifiedAccess; NoComparison>]
type CheckMeetupAuthorityError =
    | Malformed of Contract.InvalidRequest
    | Forbidden
    | IdentityUnavailable of string
    | IdentityFailed of string
    | NotFound

/// Ответ свежий на каждый вызов: кэша нет ни здесь, ни в контракте, потому что
/// устаревшее разрешение равносильно пропущенной проверке (ADR-026).
let execute (deps: Deps) (query: Query) : Task<Result<unit, CheckMeetupAuthorityError>> =
    task {
        match deps.AskRoles with
        | None -> return Error(CheckMeetupAuthorityError.IdentityUnavailable "identity is not configured")
        | Some ask ->
            match! ask query.Person (Access.globalRolesFor query.Accepted) with
            | Error(IdentityFailure.Unavailable reason) ->
                return Error(CheckMeetupAuthorityError.IdentityUnavailable reason)
            | Error(IdentityFailure.Failed reason) -> return Error(CheckMeetupAuthorityError.IdentityFailed reason)
            | Ok false -> return Error CheckMeetupAuthorityError.Forbidden
            | Ok true ->
                match! deps.Load query.Id with
                | Some _ -> return Ok()
                | None -> return Error CheckMeetupAuthorityError.NotFound
    }

/// Загрузка та же, что у команд: вопрос задаётся от их имени, и видимость на него
/// не влияет — к этой точке дошёл только тот, чьё право Identity подтвердил.
module Composition =

    open Microsoft.Extensions.DependencyInjection
    open Npgsql

    let buildDeps (services: IServiceProvider) (forwarded: Forwarded) : Deps =
        {
            AskRoles =
                match services.GetRequiredService<Port>() with
                | Port.Unconfigured -> None
                | Port.Connected connect -> Some(connect forwarded)
            Load =
                fun id ->
                    // Источник соединений берётся лениво: к загрузке доходит только
                    // подтверждённое право, и отказ не должен требовать базы.
                    MeetupStore.load (services.GetRequiredService<NpgsqlDataSource>()) id
        }

module Api =

    open Grpc.Core

    let private toStatus (error: CheckMeetupAuthorityError) : Status =
        match error with
        | CheckMeetupAuthorityError.Malformed invalid ->
            Status(StatusCode.InvalidArgument, $"{invalid.Field} {invalid.Problem}")
        | CheckMeetupAuthorityError.Forbidden ->
            Status(StatusCode.PermissionDenied, "none of the accepted relations holds")
        | CheckMeetupAuthorityError.IdentityUnavailable reason ->
            Status(StatusCode.Unavailable, $"the right cannot be confirmed now: {reason}")
        | CheckMeetupAuthorityError.IdentityFailed reason ->
            Status(StatusCode.Internal, $"identity refused the role check: {reason}")
        | CheckMeetupAuthorityError.NotFound -> Status(StatusCode.NotFound, "meetup not found")

    /// Разбор целиком до Identity: запрос, собранный неверно, в Identity не уходит, а
    /// ответ Identity на неверный идентификатор стал бы у нас INTERNAL вместо
    /// INVALID_ARGUMENT.
    let private toQuery (request: Meetups.V1.CheckMeetupAuthorityRequest) : Result<Query, Contract.InvalidRequest> =
        match
            Contract.Inbound.meetupId request.Id,
            Contract.Inbound.identityId request.IdentityId,
            Contract.Inbound.acceptedRelations request.AcceptedRelations
        with
        | Ok id, Ok person, Ok accepted ->
            Ok
                {
                    Id = id
                    Person = person
                    Accepted = accepted
                }
        | Error invalid, _, _
        | _, Error invalid, _
        | _, _, Error invalid -> Error invalid

    let handle (deps: Deps) (request: Meetups.V1.CheckMeetupAuthorityRequest) : Task<Meetups.V1.MeetupAuthority> =
        task {
            match toQuery request with
            | Error invalid -> return raise (RpcException(toStatus (CheckMeetupAuthorityError.Malformed invalid)))
            | Ok query ->
                match! execute deps query with
                | Ok() -> return Meetups.V1.MeetupAuthority()
                | Error error -> return raise (RpcException(toStatus error))
        }
