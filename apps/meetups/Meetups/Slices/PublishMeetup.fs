/// Срез «опубликовать». Команда сформулирована как целевое состояние, поэтому
/// повтор на уже видимой сходке — успех без события (ADR-031, I5), а не отказ.
module Meetups.Slices.PublishMeetup

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
        /// Первая публикация без адресного факта «новая сходка». На возврате после
        /// снятия поле не действует: повод тогда `MeetupRepublished`.
        Silent: bool
    }

[<RequireQualifiedAccess; NoComparison>]
type PublishMeetupError =
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
        /// Запрос, начавший команду (PER-227). `None` — граница его не получила.
        RequestId: RequestId option
    }

let execute (deps: Deps) (command: Command) : Task<Result<MeetupSnapshot, PublishMeetupError>> =
    task {
        // Загрузка идёт раньше решения о праве: организатор — это запись в составе
        // сходки. Чужая и отсутствующая сходка проходят одну и ту же последовательность
        // запросов и получают один отказ (ADR-076, п. 12).
        let! existing = deps.Load command.Id

        match Access.actOnBehalf command.Viewer existing with
        | Error denied -> return Error(PublishMeetupError.Forbidden denied)
        | Ok() ->
            let state = Meetup.restore existing

            // Часы читаются один раз на команду: этот же момент становится отметкой
            // первой публикации в состоянии и `occurred_at` в конверте события. Два
            // чтения дали бы одному факту два времени.
            let now = deps.Now()

            match Meetup.decidePublish now command.Silent state with
            | Error error -> return Error(PublishMeetupError.Domain error)
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
                        RequestId = deps.RequestId
                    }

                match! deps.Commit envelope (Some command.ExpectedVersion) state event with
                | Ok snapshot -> return Ok snapshot
                // Расхождение версий ещё не конфликт: PER-78 велит перечитать
                // состояние и различить безопасный повтор от настоящего конфликта.
                | Error MeetupStore.VersionConflict ->
                    match! SafeRetry.discriminate deps.Load event command.Id with
                    | Some snapshot -> return Ok snapshot
                    | None -> return Error PublishMeetupError.Conflict
    }

/// Composition root среза: здесь заканчивается DI. Ниже живут только функции и
/// значения, поэтому workflow не знает ни про контейнер, ни про строку подключения.
/// Каждый срез собирает свои зависимости сам: единый набор функций на весь сервис
/// вернул бы связность, ради устранения которой выбраны срезы.
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
/// Отображение объявляет срез, а не диспетчер — общий mapError на сервис заставил бы
/// каждую операцию разбирать чужие отказы и убил бы проверку полноты.
module Api =

    open Grpc.Core

    let private toStatus (error: PublishMeetupError) : Status =
        match error with
        | PublishMeetupError.Malformed invalid ->
            Status(StatusCode.InvalidArgument, $"{invalid.Field} {invalid.Problem}")
        | PublishMeetupError.Forbidden CannotActOnMeetup ->
            Status(StatusCode.PermissionDenied, "the viewer may not act on this meetup")
        | PublishMeetupError.Domain MeetupNotFound
        | PublishMeetupError.Domain DraftBelongsToAnotherAuthor -> Status(StatusCode.NotFound, "meetup not found")
        // Единственный срез, который решает переход к публикации, поэтому единственный,
        // где этот инвариант достижим. FAILED_PRECONDITION, а не INVALID_ARGUMENT:
        // запрос собран верно, но домен не позволяет переход.
        | PublishMeetupError.Domain TitleRequiredForPublication ->
            Status(StatusCode.FailedPrecondition, "a title is required before publication")
        // Момент назначения публикация не решает: она его только забирает
        // применением события, а отказ по времени ей не принадлежит.
        | PublishMeetupError.Domain PublicationMomentInThePast ->
            invalidOp "publishing does not decide a publication moment"
        // Тот же класс отказа, что и отсутствующий заголовок, и потому тот же код:
        // запрос собран верно, но домен не позволяет переход. Различие с отказом по
        // праву несёт код, различие с отсутствующим заголовком — деталь статуса.
        | PublishMeetupError.Domain TransitionNotAllowed ->
            Status(StatusCode.FailedPrecondition, "a cancelled meetup cannot be published")
        // ABORTED — реализационный выбор, а не контрактное обещание: код и его место
        // среди описанных закрепляет PER-78 (integration.md).
        | PublishMeetupError.Conflict -> Status(StatusCode.Aborted, "the meetup changed concurrently")

    let private toCommand (request: Meetups.V1.PublishMeetupRequest) : Result<Command, Contract.InvalidRequest> =
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
                    Silent = request.Silent
                }
        | Error invalid, _, _
        | _, Error invalid, _
        | _, _, Error invalid -> Error invalid

    let handle (deps: Deps) (request: Meetups.V1.PublishMeetupRequest) : Task<Meetups.V1.MeetupSnapshot> =
        task {
            match toCommand request with
            | Error invalid -> return raise (RpcException(toStatus (PublishMeetupError.Malformed invalid)))
            | Ok command ->
                match! execute deps command with
                | Ok snapshot -> return Contract.Outbound.snapshot snapshot
                | Error error -> return raise (RpcException(toStatus error))
        }
