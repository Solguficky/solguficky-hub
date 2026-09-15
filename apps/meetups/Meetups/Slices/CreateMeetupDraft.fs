/// Срез «завести черновик». Идентификатор генерирует вызывающая сторона, он же
/// ключ идемпотентности (ADR-031): повтор тем же автором возвращает текущий снимок
/// и события не порождает, повтор чужим автором отклоняется, чтобы не подтвердить
/// существование чужого черновика.
///
/// Срез свёрнут в один модуль: вход, отказы, оркестрация, сборка зависимостей и
/// транспортная граница читаются как один сценарий, а пустой файл типов ради
/// симметрии с соседом — шум, а не структура.
module Meetups.Slices.CreateMeetupDraft

open System
open System.Threading.Tasks
open Meetups.Domain
open Meetups.Infrastructure

type Command =
    {
        Id: MeetupId
        Viewer: Viewer
    }

/// Свой error DU у каждого среза. Одинаковый набор вариантов у четырёх команд
/// сегодня — совпадение, а не абстракция: отображение в коды отказов у них уже
/// разное, и общий тип заставил бы каждый срез разбирать невозможные для него
/// случаи. RequireQualifiedAccess здесь не украшение: без него одноимённые Conflict
/// соседних срезов перекрывали бы друг друга по правилу последнего открытого модуля.
[<RequireQualifiedAccess; NoComparison>]
type CreateMeetupDraftError =
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

let execute (deps: Deps) (command: Command) : Task<Result<MeetupSnapshot, CreateMeetupDraftError>> =
    task {
        // Право спрашивается до загрузки: состояние в этом решении не участвует, а
        // проверка после чтения сделала бы отказ обычному смотрящему зависимым от
        // того, существует ли сходка, то есть способом узнать про чужой черновик.
        match Access.forCommand command.Viewer with
        | Error denied -> return Error(CreateMeetupDraftError.Forbidden denied)
        | Ok() ->
            let! existing = deps.Load command.Id
            let state = Meetup.restore existing

            match Meetup.decideCreateDraft command.Viewer.IdentityId command.Id state with
            | Error error -> return Error(CreateMeetupDraftError.Domain error)
            | Ok None ->
                // Успех без события: сходка уже заведена этим же автором. Записи нет,
                // поэтому и транзакции нет — возвращается то, что уже лежит в базе.
                match existing with
                | Some snapshot -> return Ok snapshot
                | None -> return invalidOp "the domain reported an existing draft without loading one"
            | Ok(Some event) ->
                let envelope: MeetupStore.EventEnvelope =
                    {
                        EventId = deps.NewEventId()
                        PerformedBy = command.Viewer.IdentityId
                        OccurredAt = deps.Now()
                    }

                match! deps.Commit envelope state event with
                | Ok snapshot -> return Ok snapshot
                | Error MeetupStore.VersionConflict -> return Error CreateMeetupDraftError.Conflict
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
/// каждую операцию разбирать чужие отказы и убил бы проверку полноты. Endpoint-а у
/// среза при этом нет: класс gRPC-сервиса один на весь сервис, и это свойство
/// ASP.NET Core, а не выбор раскладки.
module Api =

    open Grpc.Core

    let private toStatus (error: CreateMeetupDraftError) : Status =
        match error with
        | CreateMeetupDraftError.Malformed invalid ->
            Status(StatusCode.InvalidArgument, $"{invalid.Field} {invalid.Problem}")
        | CreateMeetupDraftError.Forbidden NotAnAdministrator ->
            Status(StatusCode.PermissionDenied, "an administrator role is required")
        // Чужой черновик отвечает как несуществующий: иначе ответ подтвердил бы, что
        // он существует (ADR-031, ADR-022). Видимость своего кода не имеет.
        | CreateMeetupDraftError.Domain DraftBelongsToAnotherAuthor
        | CreateMeetupDraftError.Domain MeetupNotFound -> Status(StatusCode.NotFound, "meetup not found")
        // Инвариант публикации решает другой срез. Эта пара невозможна, поэтому
        // нарушение внутреннего контракта, а не код отказа.
        | CreateMeetupDraftError.Domain TitleRequiredForPublication ->
            invalidOp "creating a draft does not decide publication"
        // ABORTED — реализационный выбор, а не контрактное обещание: код и его место
        // среди описанных закрепляет PER-78 (integration.md).
        | CreateMeetupDraftError.Conflict -> Status(StatusCode.Aborted, "the meetup changed concurrently")

    let private toCommand (request: Meetups.V1.CreateMeetupDraftRequest) : Result<Command, Contract.InvalidRequest> =
        match Contract.Inbound.viewer request.Viewer, Contract.Inbound.meetupId request.Id with
        | Ok viewer, Ok id ->
            Ok
                {
                    Id = id
                    Viewer = viewer
                }
        | Error invalid, _
        | _, Error invalid -> Error invalid

    /// Принимает Deps, а не контейнер: сборка зависимостей остаётся в Composition, и
    /// весь набор отказов достижим подстановкой без поднятого хоста.
    let handle (deps: Deps) (request: Meetups.V1.CreateMeetupDraftRequest) : Task<Meetups.V1.MeetupSnapshot> =
        task {
            match toCommand request with
            | Error invalid -> return raise (RpcException(toStatus (CreateMeetupDraftError.Malformed invalid)))
            | Ok command ->
                match! execute deps command with
                | Ok snapshot -> return Contract.Outbound.snapshot snapshot
                | Error error -> return raise (RpcException(toStatus error))
        }
