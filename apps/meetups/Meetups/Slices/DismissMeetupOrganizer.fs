/// Срез «снять организатора». Целевое состояние «человека в составе нет»: снятие
/// того, кого уже нет, — успех без события. Снимает только администратор, держатель
/// `manage_meetups`: любого, в том числе автора и последнего в составе; организатор
/// назначает, но не снимает (ADR-076, дополнение 2026-11-13 к п. 6). Снять самого
/// себя этой командой нельзя: для этого есть выход, который не называет другого
/// человека.
module Meetups.Slices.DismissMeetupOrganizer

open System
open System.Threading.Tasks
open Meetups
open Meetups.Domain
open Meetups.Infrastructure

type Command =
    {
        Id: MeetupId
        Viewer: Viewer
        /// Кого снять; не смотрящий.
        Person: PersonId
        /// Версия показанного снимка, из которого принято решение (PER-78).
        ExpectedVersion: int64
    }

[<RequireQualifiedAccess; NoComparison>]
type DismissMeetupOrganizerError =
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

let execute (deps: Deps) (command: Command) : Task<Result<MeetupSnapshot, DismissMeetupOrganizerError>> =
    task {
        // Снимает только администратор, и право не зависит от сходки: отказ стоит
        // до загрузки, как у CreateMeetupDraft, и одинаков для существующей и
        // отсутствующей сходки без единого запроса.
        if not (Access.mayDismissOrganizer command.Viewer) then
            return Error(DismissMeetupOrganizerError.Forbidden CannotActOnMeetup)
        else
            let! existing = deps.Load command.Id
            let state = Meetup.restore existing

            // Устаревшая версия при недостигнутой цели — конфликт: решение принято из
            // снимка, которого уже нет.
            let stale =
                existing
                |> Option.exists (fun snapshot -> snapshot.Version <> command.ExpectedVersion)

            match Meetup.decideDismissOrganizer command.Person state with
            | Error RosterError.MeetupNotFound ->
                return Error(DismissMeetupOrganizerError.Roster RosterError.MeetupNotFound)
            | Error error -> return Error(DismissMeetupOrganizerError.Roster error)
            | Ok None ->
                match existing with
                | Some snapshot -> return Ok snapshot
                | None -> return invalidOp "the domain reported a roster state without loading a meetup"
            | Ok(Some _) when stale -> return Error DismissMeetupOrganizerError.Conflict
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
                    | None -> return Error DismissMeetupOrganizerError.Conflict
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

    let private toStatus (error: DismissMeetupOrganizerError) : Status =
        match error with
        | DismissMeetupOrganizerError.Malformed invalid ->
            Status(StatusCode.InvalidArgument, $"{invalid.Field} {invalid.Problem}")
        | DismissMeetupOrganizerError.Forbidden CannotActOnMeetup ->
            Status(StatusCode.PermissionDenied, "the viewer may not act on this meetup")
        // Дойти сюда может только администратор: остальные получают отказ по праву
        // до загрузки.
        | DismissMeetupOrganizerError.Roster RosterError.MeetupNotFound ->
            Status(StatusCode.NotFound, "meetup not found")
        // Снимает только администратор, и последнего он снять может; отменённая
        // сходка закрывает только назначение.
        | DismissMeetupOrganizerError.Roster RosterError.LastOrganizer
        | DismissMeetupOrganizerError.Roster RosterError.TransitionNotAllowed ->
            invalidOp "dismissing does not decide the roster invariants"
        | DismissMeetupOrganizerError.Conflict -> Status(StatusCode.Aborted, "the meetup changed concurrently")

    let private toCommand
        (request: Meetups.V1.DismissMeetupOrganizerRequest)
        : Result<Command, Contract.InvalidRequest> =
        match
            Contract.Inbound.viewer request.Viewer,
            Contract.Inbound.meetupId request.Id,
            Contract.Inbound.identityId request.IdentityId,
            Contract.Inbound.expectedVersion request.ExpectedVersion
        with
        | Ok viewer, Ok id, Ok person, Ok expectedVersion ->
            if person = viewer.IdentityId then
                Error(Contract.invalid "identity_id" "must name another person; use LeaveMeetupOrganizers")
            else
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

    let handle (deps: Deps) (request: Meetups.V1.DismissMeetupOrganizerRequest) : Task<Meetups.V1.MeetupSnapshot> =
        task {
            match toCommand request with
            | Error invalid -> return raise (RpcException(toStatus (DismissMeetupOrganizerError.Malformed invalid)))
            | Ok command ->
                match! execute deps command with
                | Ok snapshot -> return Contract.Outbound.snapshot snapshot
                | Error error -> return raise (RpcException(toStatus error))
        }
