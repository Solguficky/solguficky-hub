/// Срез «отметить состоявшейся». Команда сформулирована как целевое состояние,
/// поэтому повтор на уже состоявшейся сходке — успех без события (ADR-031, I5), а не
/// отказ. Перевод ручной (ADR-022) и терминальный: отменённую сходку он не
/// перебивает. Независимой оси видимости команда не трогает — скрытая состоявшаяся
/// остаётся скрытой, а архив не делает её видимой.
module Meetups.Slices.MarkMeetupHeld

open System
open System.Threading.Tasks
open Meetups.Domain
open Meetups.Infrastructure

type Command =
    {
        Id: MeetupId
        Viewer: Viewer
    }

[<RequireQualifiedAccess; NoComparison>]
type MarkMeetupHeldError =
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
                -> MeetupState
                -> MeetupEvent
                -> Task<Result<MeetupSnapshot, MeetupStore.VersionConflict>>
        Now: unit -> DateTimeOffset
        NewEventId: unit -> Guid
    }

let execute (deps: Deps) (command: Command) : Task<Result<MeetupSnapshot, MarkMeetupHeldError>> =
    task {
        // Право спрашивается до загрузки: состояние в этом решении не участвует, а
        // проверка после чтения сделала бы отказ обычному смотрящему зависимым от
        // того, существует ли сходка.
        match Access.forCommand command.Viewer with
        | Error denied -> return Error(MarkMeetupHeldError.Forbidden denied)
        | Ok() ->
            let! existing = deps.Load command.Id
            let state = Meetup.restore existing

            match Meetup.decideMarkHeld state with
            | Error error -> return Error(MarkMeetupHeldError.Domain error)
            | Ok None ->
                // Повтор: домен сказал «уже состоялась», а это решение принимается
                // только из существующей сходки.
                match existing with
                | Some snapshot -> return Ok snapshot
                | None -> return invalidOp "the domain reported a held meetup without loading one"
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

                match! deps.Commit envelope state event with
                | Ok snapshot -> return Ok snapshot
                | Error MeetupStore.VersionConflict -> return Error MarkMeetupHeldError.Conflict
    }

/// Composition root среза: здесь заканчивается DI. Ниже живут только функции и
/// значения, поэтому workflow не знает ни про контейнер, ни про строку подключения.
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

    let private toStatus (error: MarkMeetupHeldError) : Status =
        match error with
        | MarkMeetupHeldError.Malformed invalid ->
            Status(StatusCode.InvalidArgument, $"{invalid.Field} {invalid.Problem}")
        | MarkMeetupHeldError.Forbidden NotAnAdministrator ->
            Status(StatusCode.PermissionDenied, "an administrator role is required")
        | MarkMeetupHeldError.Domain MeetupNotFound
        | MarkMeetupHeldError.Domain DraftBelongsToAnotherAuthor -> Status(StatusCode.NotFound, "meetup not found")
        // Инвариант публикации решает другой срез: пара невозможна, поэтому нарушение
        // внутреннего контракта, а не код отказа.
        | MarkMeetupHeldError.Domain TitleRequiredForPublication ->
            invalidOp "marking as held does not decide publication"
        // Единственный отклонённый переход этой оси — «отменена → состоялась»:
        // отмена необратима (ADR-022).
        | MarkMeetupHeldError.Domain TransitionNotAllowed ->
            Status(StatusCode.FailedPrecondition, "a cancelled meetup cannot be marked as held")
        // ABORTED — реализационный выбор, а не контрактное обещание: код и его место
        // среди описанных закрепляет PER-78 (integration.md).
        | MarkMeetupHeldError.Conflict -> Status(StatusCode.Aborted, "the meetup changed concurrently")

    let private toCommand (request: Meetups.V1.MarkMeetupHeldRequest) : Result<Command, Contract.InvalidRequest> =
        match Contract.Inbound.viewer request.Viewer, Contract.Inbound.meetupId request.Id with
        | Ok viewer, Ok id ->
            Ok
                {
                    Id = id
                    Viewer = viewer
                }
        | Error invalid, _
        | _, Error invalid -> Error invalid

    let handle (deps: Deps) (request: Meetups.V1.MarkMeetupHeldRequest) : Task<Meetups.V1.MeetupSnapshot> =
        task {
            match toCommand request with
            | Error invalid -> return raise (RpcException(toStatus (MarkMeetupHeldError.Malformed invalid)))
            | Ok command ->
                match! execute deps command with
                | Ok snapshot -> return Contract.Outbound.snapshot snapshot
                | Error error -> return raise (RpcException(toStatus error))
        }
