/// Срез «изменить атрибуты». Команда несёт целевое состояние всех пяти
/// информационных атрибутов целиком, поэтому совпадение с текущими значениями всё
/// равно порождает событие (ADR-031): пустой diff — забота потребителя, а не
/// причина промолчать.
module Meetups.Slices.ChangeMeetupAttributes

open System
open System.Threading.Tasks
open Meetups.Domain
open Meetups.Infrastructure

type Command =
    {
        Id: MeetupId
        Viewer: Viewer
        Attributes: MeetupAttributes
    }

[<RequireQualifiedAccess; NoComparison>]
type ChangeMeetupAttributesError =
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

let execute (deps: Deps) (command: Command) : Task<Result<MeetupSnapshot, ChangeMeetupAttributesError>> =
    task {
        // Право спрашивается до загрузки: состояние в этом решении не участвует, а
        // проверка после чтения сделала бы отказ обычному смотрящему зависимым от
        // того, существует ли сходка.
        match Access.forCommand command.Viewer with
        | Error denied -> return Error(ChangeMeetupAttributesError.Forbidden denied)
        | Ok() ->
            let! existing = deps.Load command.Id
            let state = Meetup.restore existing

            // Решение этой команды события не опускает: единственный её отказ —
            // несуществующая сходка, поэтому ветки «успех без события» здесь нет.
            match Meetup.decideChangeAttributes command.Attributes state with
            | Error error -> return Error(ChangeMeetupAttributesError.Domain error)
            | Ok event ->
                let envelope: MeetupStore.EventEnvelope =
                    {
                        EventId = deps.NewEventId()
                        PerformedBy = command.Viewer.IdentityId
                        OccurredAt = deps.Now()
                    }

                match! deps.Commit envelope state event with
                | Ok snapshot -> return Ok snapshot
                | Error MeetupStore.VersionConflict -> return Error ChangeMeetupAttributesError.Conflict
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

    let private toStatus (error: ChangeMeetupAttributesError) : Status =
        match error with
        | ChangeMeetupAttributesError.Malformed invalid ->
            Status(StatusCode.InvalidArgument, $"{invalid.Field} {invalid.Problem}")
        | ChangeMeetupAttributesError.Forbidden NotAnAdministrator ->
            Status(StatusCode.PermissionDenied, "an administrator role is required")
        | ChangeMeetupAttributesError.Domain MeetupNotFound
        | ChangeMeetupAttributesError.Domain DraftBelongsToAnotherAuthor ->
            Status(StatusCode.NotFound, "meetup not found")
        // Инвариант публикации решает другой срез: пара невозможна, поэтому нарушение
        // внутреннего контракта, а не код отказа.
        | ChangeMeetupAttributesError.Domain TitleRequiredForPublication ->
            invalidOp "changing attributes does not decide publication"
        // ABORTED — реализационный выбор, а не контрактное обещание: код и его место
        // среди описанных закрепляет PER-78 (integration.md).
        | ChangeMeetupAttributesError.Conflict -> Status(StatusCode.Aborted, "the meetup changed concurrently")

    /// Атрибуты тотальны: пустая строка — легитимное значение «не указано», поэтому
    /// отказа разбора у них нет и быть не может (ADR-031). Разбор живёт здесь, а не в
    /// Contract: потребитель у него ровно один.
    let private toCommand
        (request: Meetups.V1.ChangeMeetupAttributesRequest)
        : Result<Command, Contract.InvalidRequest> =
        match Contract.Inbound.viewer request.Viewer, Contract.Inbound.meetupId request.Id with
        | Ok viewer, Ok id ->
            Ok
                {
                    Id = id
                    Viewer = viewer
                    Attributes =
                        {
                            Title = request.Title
                            Description = request.Description
                            Venue = request.Venue
                            Kind = request.Kind
                            CalendarLink = request.CalendarLink
                        }
                }
        | Error invalid, _
        | _, Error invalid -> Error invalid

    let handle (deps: Deps) (request: Meetups.V1.ChangeMeetupAttributesRequest) : Task<Meetups.V1.MeetupSnapshot> =
        task {
            match toCommand request with
            | Error invalid -> return raise (RpcException(toStatus (ChangeMeetupAttributesError.Malformed invalid)))
            | Ok command ->
                match! execute deps command with
                | Ok snapshot -> return Contract.Outbound.snapshot snapshot
                | Error error -> return raise (RpcException(toStatus error))
        }
