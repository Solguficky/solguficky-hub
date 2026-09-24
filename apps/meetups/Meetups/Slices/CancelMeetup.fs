/// Срез «отменить». Команда сформулирована как целевое состояние, поэтому повтор на
/// уже отменённой сходке — успех без события (ADR-031, I5), а не отказ. Отмена
/// терминальна и независимой оси видимости не трогает: видимая отменённая сходка
/// остаётся видимой, потому что извещение об отмене и есть то, что сообществу нужно
/// показать.
module Meetups.Slices.CancelMeetup

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
type CancelMeetupError =
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

let execute (deps: Deps) (command: Command) : Task<Result<MeetupSnapshot, CancelMeetupError>> =
    task {
        // Право спрашивается до загрузки: состояние в этом решении не участвует, а
        // проверка после чтения сделала бы отказ обычному смотрящему зависимым от
        // того, существует ли сходка.
        match Access.actOnBehalf command.Viewer with
        | Error denied -> return Error(CancelMeetupError.Forbidden denied)
        | Ok() ->
            let! existing = deps.Load command.Id
            let state = Meetup.restore existing

            match Meetup.decideCancel state with
            | Error error -> return Error(CancelMeetupError.Domain error)
            | Ok None ->
                // Повтор: домен сказал «уже отменена», а это решение принимается
                // только из существующей сходки.
                match existing with
                | Some snapshot -> return Ok snapshot
                | None -> return invalidOp "the domain reported a cancelled meetup without loading one"
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
                    | None -> return Error CancelMeetupError.Conflict
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

    let private toStatus (error: CancelMeetupError) : Status =
        match error with
        | CancelMeetupError.Malformed invalid ->
            Status(StatusCode.InvalidArgument, $"{invalid.Field} {invalid.Problem}")
        | CancelMeetupError.Forbidden NotAnAdministrator ->
            Status(StatusCode.PermissionDenied, "an administrator role is required")
        | CancelMeetupError.Domain MeetupNotFound
        | CancelMeetupError.Domain DraftBelongsToAnotherAuthor -> Status(StatusCode.NotFound, "meetup not found")
        // Инвариант публикации решает другой срез: пара невозможна, поэтому нарушение
        // внутреннего контракта, а не код отказа.
        | CancelMeetupError.Domain TitleRequiredForPublication -> invalidOp "cancelling does not decide publication"
        | CancelMeetupError.Domain PublicationMomentInThePast ->
            invalidOp "cancelling does not decide a publication moment"
        // Единственный отклонённый переход этой оси — «состоялась → отменена»:
        // прошедшую сходку не отменяют, её отменять уже поздно.
        | CancelMeetupError.Domain TransitionNotAllowed ->
            Status(StatusCode.FailedPrecondition, "a meetup that already took place cannot be cancelled")
        // ABORTED — реализационный выбор, а не контрактное обещание: код и его место
        // среди описанных закрепляет PER-78 (integration.md).
        | CancelMeetupError.Conflict -> Status(StatusCode.Aborted, "the meetup changed concurrently")

    let private toCommand (request: Meetups.V1.CancelMeetupRequest) : Result<Command, Contract.InvalidRequest> =
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

    let handle (deps: Deps) (request: Meetups.V1.CancelMeetupRequest) : Task<Meetups.V1.MeetupSnapshot> =
        task {
            match toCommand request with
            | Error invalid -> return raise (RpcException(toStatus (CancelMeetupError.Malformed invalid)))
            | Ok command ->
                match! execute deps command with
                | Ok snapshot -> return Contract.Outbound.snapshot snapshot
                | Error error -> return raise (RpcException(toStatus error))
        }
