/// Срез «отменить запланированную публикацию». Команда сформулирована как целевое
/// состояние «запланированной публикации нет», поэтому повтор и сходка без момента —
/// успех без события (ADR-031, I5). Момент, который уже прошёл, а воркер ещё не
/// забрал, отменяется так же, как будущий: человек передумал до публикации, а гонку
/// с воркером разрешает версия строки, а не проверка часов здесь.
module Meetups.Slices.CancelMeetupPublication

open System
open System.Threading.Tasks
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
type CancelMeetupPublicationError =
    | Malformed of Contract.InvalidRequest
    | Forbidden of AccessDenied
    | Domain of DomainError
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
    }

let execute (deps: Deps) (command: Command) : Task<Result<MeetupSnapshot, CancelMeetupPublicationError>> =
    task {
        // Право спрашивается до загрузки: состояние в этом решении не участвует, а
        // проверка после чтения сделала бы отказ обычному смотрящему зависимым от
        // того, существует ли сходка.
        match Access.forCommand command.Viewer with
        | Error denied -> return Error(CancelMeetupPublicationError.Forbidden denied)
        | Ok() ->
            let! existing = deps.Load command.Id
            let state = Meetup.restore existing

            match Meetup.decideCancelScheduledPublication state with
            | Error error -> return Error(CancelMeetupPublicationError.Domain error)
            | Ok None ->
                // Повтор: домен сказал «момента нет», а это решение принимается
                // только из существующей сходки.
                match existing with
                | Some snapshot -> return Ok snapshot
                | None -> return invalidOp "the domain reported an unscheduled meetup without loading one"
            | Ok(Some event) ->
                // Часы читаются один раз и только на записывающем пути: в состояние
                // этот момент не попадает, его единственный потребитель —
                // `occurred_at` конверта.
                let envelope: MeetupStore.EventEnvelope =
                    {
                        EventId = deps.NewEventId()
                        PerformedBy = command.Viewer.IdentityId
                        OccurredAt = deps.Now()
                    }

                match! deps.Commit envelope (Some command.ExpectedVersion) state event with
                | Ok snapshot -> return Ok snapshot
                // Расхождение версий ещё не конфликт: PER-78 велит перечитать
                // состояние и различить безопасный повтор от настоящего конфликта.
                | Error MeetupStore.VersionConflict ->
                    match! SafeRetry.discriminate deps.Load event command.Id with
                    | Some snapshot -> return Ok snapshot
                    | None -> return Error CancelMeetupPublicationError.Conflict
    }

/// Composition root среза: здесь заканчивается DI. Ниже живут только функции и
/// значения, поэтому workflow не знает ни про контейнер, ни про строку подключения.
/// Каждый срез собирает свои зависимости сам: единый набор функций на весь сервис
/// вернул бы связность, ради устранения которой выбраны срезы.
module Composition =

    open Microsoft.Extensions.DependencyInjection
    open Npgsql

    let buildDeps (services: IServiceProvider) : Deps =
        let source = services.GetRequiredService<NpgsqlDataSource>()

        {
            Load = MeetupStore.load source
            Commit = MeetupStore.commit source
            // UtcNow, а не Now: TIMESTAMPTZ принимает DateTimeOffset только с нулевым
            // смещением, и локальное время упало бы уже в рантайме.
            Now = fun () -> DateTimeOffset.UtcNow
            NewEventId = Guid.CreateVersion7
        }

/// Транспортная граница среза: разбор запроса и отображение отказов в коды.
/// Отображение объявляет срез, а не диспетчер — общий mapError на сервис заставил бы
/// каждую операцию разбирать чужие отказы и убил бы проверку полноты.
module Api =

    open Grpc.Core

    let private toStatus (error: CancelMeetupPublicationError) : Status =
        match error with
        | CancelMeetupPublicationError.Malformed invalid ->
            Status(StatusCode.InvalidArgument, $"{invalid.Field} {invalid.Problem}")
        | CancelMeetupPublicationError.Forbidden NotAnAdministrator ->
            Status(StatusCode.PermissionDenied, "an administrator role is required")
        | CancelMeetupPublicationError.Domain MeetupNotFound
        | CancelMeetupPublicationError.Domain DraftBelongsToAnotherAuthor ->
            Status(StatusCode.NotFound, "meetup not found")
        // Прочие инварианты решают соседние срезы: отмена запланированной
        // публикации не публикует и не двигает переходы, поэтому каждая такая пара —
        // нарушение внутреннего контракта, а не код отказа.
        | CancelMeetupPublicationError.Domain TitleRequiredForPublication ->
            invalidOp "cancelling a scheduled publication does not decide publication"
        | CancelMeetupPublicationError.Domain TransitionNotAllowed ->
            invalidOp "cancelling a scheduled publication does not move a transition"
        | CancelMeetupPublicationError.Domain PublicationMomentInThePast ->
            invalidOp "cancelling a scheduled publication does not decide a moment"
        // ABORTED — реализационный выбор, а не контрактное обещание: код и его место
        // среди описанных закрепляет PER-78 (integration.md).
        | CancelMeetupPublicationError.Conflict -> Status(StatusCode.Aborted, "the meetup changed concurrently")

    let private toCommand
        (request: Meetups.V1.CancelMeetupPublicationRequest)
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

    let handle (deps: Deps) (request: Meetups.V1.CancelMeetupPublicationRequest) : Task<Meetups.V1.MeetupSnapshot> =
        task {
            match toCommand request with
            | Error invalid -> return raise (RpcException(toStatus (CancelMeetupPublicationError.Malformed invalid)))
            | Ok command ->
                match! execute deps command with
                | Ok snapshot -> return Contract.Outbound.snapshot snapshot
                | Error error -> return raise (RpcException(toStatus error))
        }
