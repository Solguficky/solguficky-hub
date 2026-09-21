/// Срез «CancelMeetup». Команда задаёт целевое состояние; повтор успешен без события.
module Meetups.Slices.CancelMeetup

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
        match Access.forCommand command.Viewer with
        | Error denied -> return Error(CancelMeetupError.Forbidden denied)
        | Ok() ->
            let! existing = deps.Load command.Id
            let state = Meetup.restore existing

            // Часы читаются один раз на команду: этот же момент становится отметкой
            // первой публикации в состоянии и `occurred_at` в конверте события. Два
            // чтения дали бы одному факту два времени.
            let now = deps.Now()

            match Meetup.decideCancel state with
            | Error error -> return Error(CancelMeetupError.Domain error)
            | Ok None ->
                match existing with
                | Some snapshot -> return Ok snapshot
                | None -> return invalidOp "the domain reported a visible meetup without loading one"
            | Ok(Some event) ->
                let envelope: MeetupStore.EventEnvelope =
                    {
                        EventId = deps.NewEventId()
                        PerformedBy = command.Viewer.IdentityId
                        OccurredAt = now
                    }

                match! deps.Commit envelope state event with
                | Ok snapshot -> return Ok snapshot
                | Error MeetupStore.VersionConflict -> return Error CancelMeetupError.Conflict
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
        // Единственный срез, который решает переход к публикации, поэтому единственный,
        // где этот инвариант достижим. FAILED_PRECONDITION, а не INVALID_ARGUMENT:
        // запрос собран верно, но домен не позволяет переход.
        | CancelMeetupError.Domain TitleRequiredForPublication ->
            Status(StatusCode.FailedPrecondition, "the requested transition does not require a title")
        // Тот же класс отказа, что и отсутствующий заголовок, и потому тот же код:
        // запрос собран верно, но домен не позволяет переход. Различие с отказом по
        // праву несёт код, различие с отсутствующим заголовком — деталь статуса.
        | CancelMeetupError.Domain TransitionNotAllowed ->
            Status(StatusCode.FailedPrecondition, "the requested state transition is not allowed")
        // ABORTED — реализационный выбор, а не контрактное обещание: код и его место
        // среди описанных закрепляет PER-78 (integration.md).
        | CancelMeetupError.Conflict -> Status(StatusCode.Aborted, "the meetup changed concurrently")

    let private toCommand (request: Meetups.V1.CancelMeetupRequest) : Result<Command, Contract.InvalidRequest> =
        match Contract.Inbound.viewer request.Viewer, Contract.Inbound.meetupId request.Id with
        | Ok viewer, Ok id ->
            Ok
                {
                    Id = id
                    Viewer = viewer
                }
        | Error invalid, _
        | _, Error invalid -> Error invalid

    let handle (deps: Deps) (request: Meetups.V1.CancelMeetupRequest) : Task<Meetups.V1.MeetupSnapshot> =
        task {
            match toCommand request with
            | Error invalid -> return raise (RpcException(toStatus (CancelMeetupError.Malformed invalid)))
            | Ok command ->
                match! execute deps command with
                | Ok snapshot -> return Contract.Outbound.snapshot snapshot
                | Error error -> return raise (RpcException(toStatus error))
        }
