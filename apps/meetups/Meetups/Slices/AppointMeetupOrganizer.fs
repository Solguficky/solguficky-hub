/// Срез «назначить организатора». Команда сформулирована как целевое состояние
/// «человек в составе»: повтор на человеке, который уже там, — успех без события,
/// даже если он потерял право (ADR-076, п. 6; integration.md, «Состав организаторов»).
///
/// Порядок проверок наблюдаем снаружи и закреплён каталогом: форма запроса; право
/// смотрящего (администратор или организатор этой сходки, решается после загрузки
/// для всех, кроме администратора); сходка найдена; версия; повтор целевого
/// состояния; затем отменённая сходка и, последним, право назначаемого у Identity.
/// Вопрос к Identity — самый дорогой шаг, поэтому идёт после всех, которые отказывают
/// без сети.
module Meetups.Slices.AppointMeetupOrganizer

open System
open System.Threading.Tasks
open Meetups
open Meetups.Domain
open Meetups.Infrastructure

type Command =
    {
        Id: MeetupId
        Viewer: Viewer
        Person: PersonId
        /// Версия показанного снимка, из которого принято решение (PER-78).
        ExpectedVersion: int64
    }

[<RequireQualifiedAccess; NoComparison>]
type AppointMeetupOrganizerError =
    | Malformed of Contract.InvalidRequest
    | Forbidden of AccessDenied
    | Roster of RosterError
    /// Назначаемый не держит `organize_meetups`, заблокирован или Identity его не
    /// знает: один отказ, чтобы команда не стала оракулом «этот человек существует».
    | PersonNotEligible
    | IdentityUnavailable of string
    | IdentityFailed of string
    | Conflict

[<NoEquality; NoComparison>]
type Deps =
    {
        Load: MeetupId -> Task<MeetupSnapshot option>
        Commit:
            MeetupStore.EventEnvelope
                -> int64 option
                -> MeetupState
                -> MeetupEvent
                -> Task<Result<MeetupSnapshot, MeetupStore.VersionConflict>>
        /// Право назначаемого у Identity. `None` — сервис запущен без адреса Identity:
        /// честный ответ без источника права — UNAVAILABLE, а не «нет» и не «да».
        AskRight: CheckMeetupAuthority.AskRight option
        Now: unit -> DateTimeOffset
        NewEventId: unit -> Guid
        /// Запрос, начавший команду (PER-227). `None` — граница его не получила.
        RequestId: RequestId option
    }

let execute (deps: Deps) (command: Command) : Task<Result<MeetupSnapshot, AppointMeetupOrganizerError>> =
    task {
        // Загрузка раньше решения о праве, как у остальных команд: чужая и
        // отсутствующая сходка проходят одну последовательность запросов.
        let! existing = deps.Load command.Id

        match Access.actOnBehalf command.Viewer existing with
        | Error denied -> return Error(AppointMeetupOrganizerError.Forbidden denied)
        | Ok() ->
            let state = Meetup.restore existing

            // Устаревшая версия при недостигнутой цели — конфликт, и он стоит раньше
            // отмены и вопроса к Identity: решение принято из снимка, которого уже нет.
            let stale =
                existing
                |> Option.exists (fun snapshot -> snapshot.Version <> command.ExpectedVersion)

            match Meetup.decideAppointOrganizer command.Person state with
            | Error RosterError.MeetupNotFound ->
                return Error(AppointMeetupOrganizerError.Roster RosterError.MeetupNotFound)
            | Error _ when stale -> return Error AppointMeetupOrganizerError.Conflict
            | Error error -> return Error(AppointMeetupOrganizerError.Roster error)
            | Ok None ->
                match existing with
                | Some snapshot -> return Ok snapshot
                | None -> return invalidOp "the domain reported a roster member without loading a meetup"
            | Ok(Some _) when stale -> return Error AppointMeetupOrganizerError.Conflict
            | Ok(Some event) ->
                match deps.AskRight with
                | None -> return Error(AppointMeetupOrganizerError.IdentityUnavailable "identity is not configured")
                | Some ask ->
                    match! ask command.Person OrganizeMeetups with
                    | Error(CheckMeetupAuthority.IdentityFailure.Unavailable reason) ->
                        return Error(AppointMeetupOrganizerError.IdentityUnavailable reason)
                    | Error(CheckMeetupAuthority.IdentityFailure.Failed reason) ->
                        return Error(AppointMeetupOrganizerError.IdentityFailed reason)
                    | Ok false -> return Error AppointMeetupOrganizerError.PersonNotEligible
                    | Ok true ->
                        let envelope: MeetupStore.EventEnvelope =
                            {
                                EventId = deps.NewEventId()
                                PerformedBy = command.Viewer.IdentityId
                                OccurredAt = deps.Now()
                                RequestId = deps.RequestId
                            }

                        match! deps.Commit envelope (Some command.ExpectedVersion) state event with
                        | Ok snapshot -> return Ok snapshot
                        | Error MeetupStore.VersionConflict ->
                            match! SafeRetry.discriminate deps.Load event command.Id with
                            | Some snapshot -> return Ok snapshot
                            | None -> return Error AppointMeetupOrganizerError.Conflict
    }

/// Composition root среза: здесь заканчивается DI.
module Composition =

    open Microsoft.Extensions.DependencyInjection
    open Npgsql

    let buildDeps
        (services: IServiceProvider)
        (requestId: RequestId option)
        (forwarded: CheckMeetupAuthority.Forwarded)
        : Deps =
        let source = services.GetRequiredService<NpgsqlDataSource>()

        {
            Load = MeetupStore.load source
            Commit = MeetupStore.commit source
            AskRight =
                match services.GetRequiredService<CheckMeetupAuthority.Port>() with
                | CheckMeetupAuthority.Port.Unconfigured -> None
                | CheckMeetupAuthority.Port.Connected connect -> Some(connect forwarded)
            // UtcNow, а не Now: TIMESTAMPTZ принимает DateTimeOffset только с нулевым
            // смещением, и локальное время упало бы уже в рантайме.
            Now = fun () -> DateTimeOffset.UtcNow
            NewEventId = Guid.CreateVersion7
            RequestId = requestId
        }

/// Транспортная граница среза: разбор запроса и отображение отказов в коды.
module Api =

    open Grpc.Core

    let private toStatus (error: AppointMeetupOrganizerError) : Status =
        match error with
        | AppointMeetupOrganizerError.Malformed invalid ->
            Status(StatusCode.InvalidArgument, $"{invalid.Field} {invalid.Problem}")
        | AppointMeetupOrganizerError.Forbidden CannotActOnMeetup ->
            Status(StatusCode.PermissionDenied, "the viewer may not act on this meetup")
        // Дойти сюда может только администратор: остальным отсутствующая сходка
        // отвечает отказом по праву.
        | AppointMeetupOrganizerError.Roster RosterError.MeetupNotFound ->
            Status(StatusCode.NotFound, "meetup not found")
        | AppointMeetupOrganizerError.Roster RosterError.TransitionNotAllowed ->
            Status(StatusCode.FailedPrecondition, "a cancelled meetup cannot get a new organizer")
        // Эти два отказа назначение не решает: они принадлежат снятию и выходу.
        | AppointMeetupOrganizerError.Roster RosterError.AuthorProtected
        | AppointMeetupOrganizerError.Roster RosterError.LastOrganizer ->
            invalidOp "appointing does not decide the roster invariants"
        | AppointMeetupOrganizerError.PersonNotEligible ->
            Status(StatusCode.FailedPrecondition, "the person cannot become an organizer")
        | AppointMeetupOrganizerError.IdentityUnavailable reason ->
            Status(StatusCode.Unavailable, $"the right cannot be confirmed now: {reason}")
        | AppointMeetupOrganizerError.IdentityFailed reason ->
            Status(StatusCode.Internal, $"identity refused the right check: {reason}")
        | AppointMeetupOrganizerError.Conflict -> Status(StatusCode.Aborted, "the meetup changed concurrently")

    let private toCommand
        (request: Meetups.V1.AppointMeetupOrganizerRequest)
        : Result<Command, Contract.InvalidRequest> =
        match
            Contract.Inbound.viewer request.Viewer,
            Contract.Inbound.meetupId request.Id,
            Contract.Inbound.identityId request.IdentityId,
            Contract.Inbound.expectedVersion request.ExpectedVersion
        with
        | Ok viewer, Ok id, Ok person, Ok expectedVersion ->
            Ok
                {
                    Id = id
                    Viewer = viewer
                    Person = person
                    ExpectedVersion = expectedVersion
                }
        | Error invalid, _, _, _
        | _, Error invalid, _, _
        | _, _, Error invalid, _
        | _, _, _, Error invalid -> Error invalid

    let handle (deps: Deps) (request: Meetups.V1.AppointMeetupOrganizerRequest) : Task<Meetups.V1.MeetupSnapshot> =
        task {
            match toCommand request with
            | Error invalid -> return raise (RpcException(toStatus (AppointMeetupOrganizerError.Malformed invalid)))
            | Ok command ->
                match! execute deps command with
                | Ok snapshot -> return Contract.Outbound.snapshot snapshot
                | Error error -> return raise (RpcException(toStatus error))
        }
