/// Срез «выйти из организаторов». Опора выхода — запись в составе, а не право:
/// человек, потерявший `organize_meetups`, выйти может. Смотрящий вне состава, который
/// сходку читает, получает снимок без события, прочие — отказ по праву, как у
/// остальных команд (ADR-076, п. 6 и 9). Выход пишет тот же повод, что снятие, с
/// `performed_by`, равным человеку, и адресного сообщения не порождает.
module Meetups.Slices.LeaveMeetupOrganizers

open System
open System.Threading.Tasks
open Meetups
open Meetups.Domain
open Meetups.Infrastructure

type Command =
    {
        Id: MeetupId
        Viewer: Viewer
        /// Версия показанного снимка, из которого принято решение (PER-78).
        ExpectedVersion: int64
    }

[<RequireQualifiedAccess; NoComparison>]
type LeaveMeetupOrganizersError =
    | Malformed of Contract.InvalidRequest
    | Forbidden of AccessDenied
    | Roster of RosterError
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
        Now: unit -> DateTimeOffset
        NewEventId: unit -> Guid
        /// Запрос, начавший команду (PER-227). `None` — граница его не получила.
        RequestId: RequestId option
    }

let execute (deps: Deps) (command: Command) : Task<Result<MeetupSnapshot, LeaveMeetupOrganizersError>> =
    task {
        // Загрузка раньше решения о праве, как у остальных команд: чужая и
        // отсутствующая сходка проходят одну последовательность запросов.
        let! existing = deps.Load command.Id

        match Access.mayLeave command.Viewer existing with
        | Error denied -> return Error(LeaveMeetupOrganizersError.Forbidden denied)
        | Ok() ->
            let state = Meetup.restore existing
            let byAdministrator = Viewer.canManageMeetups command.Viewer

            // Устаревшая версия при недостигнутой цели — конфликт, и он стоит раньше
            // инвариантов состава: решение принято из снимка, которого уже нет.
            let stale =
                existing
                |> Option.exists (fun snapshot -> snapshot.Version <> command.ExpectedVersion)

            match Meetup.decideLeaveOrganizers byAdministrator command.Viewer.IdentityId state with
            | Error RosterError.MeetupNotFound ->
                return Error(LeaveMeetupOrganizersError.Roster RosterError.MeetupNotFound)
            | Error _ when stale -> return Error LeaveMeetupOrganizersError.Conflict
            | Error error -> return Error(LeaveMeetupOrganizersError.Roster error)
            | Ok None ->
                match existing with
                | Some snapshot -> return Ok snapshot
                | None -> return invalidOp "the domain reported a roster state without loading a meetup"
            | Ok(Some _) when stale -> return Error LeaveMeetupOrganizersError.Conflict
            | Ok(Some event) ->
                let envelope: MeetupStore.EventEnvelope =
                    {
                        EventId = deps.NewEventId()
                        PerformedBy = command.Viewer.IdentityId
                        OccurredAt = deps.Now()
                        RequestId = deps.RequestId
                    }

                match! deps.Commit envelope (Some command.ExpectedVersion) state event with
                | Ok snapshot -> return Ok snapshot
                // Расхождение версий ещё не конфликт: PER-78 велит перечитать
                // состояние и различить безопасный повтор от настоящего конфликта.
                | Error MeetupStore.VersionConflict ->
                    match! SafeRetry.discriminate deps.Load event command.Id with
                    | Some snapshot -> return Ok snapshot
                    | None -> return Error LeaveMeetupOrganizersError.Conflict
    }

/// Composition root среза: здесь заканчивается DI.
module Composition =

    open Microsoft.Extensions.DependencyInjection
    open Npgsql

    let buildDeps (services: IServiceProvider) (requestId: RequestId option) : Deps =
        let source = services.GetRequiredService<NpgsqlDataSource>()

        {
            Load = MeetupStore.load source
            Commit = MeetupStore.commit source
            // UtcNow, а не Now: TIMESTAMPTZ принимает DateTimeOffset только с нулевым
            // смещением, и локальное время упало бы уже в рантайме.
            Now = fun () -> DateTimeOffset.UtcNow
            NewEventId = Guid.CreateVersion7
            RequestId = requestId
        }

/// Транспортная граница среза: разбор запроса и отображение отказов в коды.
module Api =

    open Grpc.Core

    let private toStatus (error: LeaveMeetupOrganizersError) : Status =
        match error with
        | LeaveMeetupOrganizersError.Malformed invalid ->
            Status(StatusCode.InvalidArgument, $"{invalid.Field} {invalid.Problem}")
        | LeaveMeetupOrganizersError.Forbidden CannotActOnMeetup ->
            Status(StatusCode.PermissionDenied, "the viewer may not act on this meetup")
        // Дойти сюда может только администратор: остальным отсутствующая сходка
        // отвечает отказом по праву.
        | LeaveMeetupOrganizersError.Roster RosterError.MeetupNotFound ->
            Status(StatusCode.NotFound, "meetup not found")
        | LeaveMeetupOrganizersError.Roster RosterError.LastOrganizer ->
            Status(StatusCode.FailedPrecondition, "the last person in the roster stays")
        // Отменённая сходка закрывает только назначение: снятие и выход открыты.
        | LeaveMeetupOrganizersError.Roster RosterError.TransitionNotAllowed ->
            invalidOp "the roster command does not decide the cancelled meetup"
        | LeaveMeetupOrganizersError.Conflict -> Status(StatusCode.Aborted, "the meetup changed concurrently")

    let private toCommand
        (request: Meetups.V1.LeaveMeetupOrganizersRequest)
        : Result<Command, Contract.InvalidRequest> =
        match
            Contract.Inbound.viewer request.Viewer,
            Contract.Inbound.meetupId request.Id,
            Contract.Inbound.expectedVersion request.ExpectedVersion
        with
        | Ok viewer, Ok id, Ok expectedVersion ->
            Ok
                {
                    Id = id
                    Viewer = viewer
                    ExpectedVersion = expectedVersion
                }
        | Error invalid, _, _
        | _, Error invalid, _
        | _, _, Error invalid -> Error invalid

    let handle (deps: Deps) (request: Meetups.V1.LeaveMeetupOrganizersRequest) : Task<Meetups.V1.MeetupSnapshot> =
        task {
            match toCommand request with
            | Error invalid -> return raise (RpcException(toStatus (LeaveMeetupOrganizersError.Malformed invalid)))
            | Ok command ->
                match! execute deps command with
                | Ok snapshot -> return Contract.Outbound.snapshot snapshot
                | Error error -> return raise (RpcException(toStatus error))
        }
