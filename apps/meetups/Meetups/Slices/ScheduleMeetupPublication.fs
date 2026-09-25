/// Срез «назначить момент публикации». Момент приходит локальной парой «дата и
/// время» и интерпретируется в часовом поясе сообщества из конфигурации; в
/// состоянии и на проводе он живёт мгновением. Локальное значение без пояса —
/// выбор человека, мгновение — факт, с которым работают воркер и потребители
/// (ADR-031).
///
/// Состояния «запланирована публикация» не существует: признак выводится из
/// непустого поля (ADR-022), и команда меняет ровно это поле.
module Meetups.Slices.ScheduleMeetupPublication

open System
open System.Threading.Tasks
open Meetups.Domain
open Meetups.Infrastructure

type Command =
    {
        Id: MeetupId
        Viewer: Viewer
        Moment: LocalDateTime
        /// Версия показанного снимка, из которого принято решение (PER-78).
        ExpectedVersion: int64
    }

[<RequireQualifiedAccess; NoComparison>]
type ScheduleMeetupPublicationError =
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
        CommunityTimeZone: TimeZoneInfo
    }

/// Локальная пара становится мгновением: пояс применяется при интерпретации, а не
/// при записи (ADR-031). Функция чистая при данном поясе, поэтому живёт в срезе у
/// единственной команды, которой пояс нужен, а не в общем модуле.
///
/// Несуществующее местное время (переход на летнее время) отвергается отказом
/// сборки значения: сдвинуть его в соседнее время значило бы назначить публикацию
/// на момент, которого человек не называл. Неоднозначное время (обратный переход)
/// платформа разрешает стандартным смещением пояса — это поведение закреплено
/// тестом, а не оставлено на догадку читателя.
let private interpret (zone: TimeZoneInfo) (moment: LocalDateTime) : Result<DateTimeOffset, Contract.InvalidRequest> =
    let time = LocalTime.value moment.Time

    let local =
        DateTime(
            moment.Date.Year,
            moment.Date.Month,
            moment.Date.Day,
            time.Hour,
            time.Minute,
            0,
            DateTimeKind.Unspecified
        )

    try
        Ok(DateTimeOffset(TimeZoneInfo.ConvertTimeToUtc(local, zone), TimeSpan.Zero))
    with :? ArgumentException ->
        Error(Contract.invalid "moment" "does not exist in the community timezone")

let execute (deps: Deps) (command: Command) : Task<Result<MeetupSnapshot, ScheduleMeetupPublicationError>> =
    task {
        // Право спрашивается до загрузки: состояние в этом решении не участвует, а
        // проверка после чтения сделала бы отказ обычному смотрящему зависимым от
        // того, существует ли сходка.
        match Access.actOnBehalf command.Viewer with
        | Error denied -> return Error(ScheduleMeetupPublicationError.Forbidden denied)
        | Ok() ->
            // Значение разбирается до обращения к базе: пояс и календарь не знают о
            // сходке, а негодная пара не заслуживает ни строчки чтения.
            match interpret deps.CommunityTimeZone command.Moment with
            | Error invalid -> return Error(ScheduleMeetupPublicationError.Malformed invalid)
            | Ok at ->
                let! existing = deps.Load command.Id
                let state = Meetup.restore existing

                // Часы читаются один раз на команду: этот же момент решает, не
                // прошёл ли назначенный, и становится `occurred_at` конверта.
                let now = deps.Now()

                match Meetup.decideSchedulePublication now at state with
                | Error error -> return Error(ScheduleMeetupPublicationError.Domain error)
                | Ok None ->
                    match existing with
                    | Some snapshot -> return Ok snapshot
                    | None -> return invalidOp "the domain reported a scheduled publication without loading one"
                | Ok(Some event) ->
                    let envelope: MeetupStore.EventEnvelope =
                        {
                            EventId = deps.NewEventId()
                            PerformedBy = command.Viewer.IdentityId
                            OccurredAt = now
                        }

                    match! deps.Commit envelope (Some command.ExpectedVersion) state event with
                    | Ok snapshot -> return Ok snapshot
                    // Расхождение версий ещё не конфликт: PER-78 велит перечитать
                    // состояние и различить безопасный повтор от настоящего конфликта.
                    | Error MeetupStore.VersionConflict ->
                        match! SafeRetry.discriminate deps.Load event command.Id with
                        | Some snapshot -> return Ok snapshot
                        | None -> return Error ScheduleMeetupPublicationError.Conflict
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
            CommunityTimeZone = services.GetRequiredService<TimeZoneInfo>()
        }

/// Транспортная граница среза: разбор запроса и отображение отказов в коды.
/// Отображение объявляет срез, а не диспетчер — общий mapError на сервис заставил бы
/// каждую операцию разбирать чужие отказы и убил бы проверку полноты.
module Api =

    open Grpc.Core

    let private toStatus (error: ScheduleMeetupPublicationError) : Status =
        match error with
        | ScheduleMeetupPublicationError.Malformed invalid ->
            Status(StatusCode.InvalidArgument, $"{invalid.Field} {invalid.Problem}")
        | ScheduleMeetupPublicationError.Forbidden NotAnAdministrator ->
            Status(StatusCode.PermissionDenied, "an administrator role is required")
        | ScheduleMeetupPublicationError.Domain MeetupNotFound
        | ScheduleMeetupPublicationError.Domain DraftBelongsToAnotherAuthor ->
            Status(StatusCode.NotFound, "meetup not found")
        // Видимая сходка закрывает назначение: у неё момента быть не может
        // (`meetups_scheduled_publish_only_when_hidden`), а отменённая закрывает эту
        // команду так же, как закрывает редактирование (PER-197).
        | ScheduleMeetupPublicationError.Domain TransitionNotAllowed ->
            Status(StatusCode.FailedPrecondition, "a published or cancelled meetup cannot have a scheduled publication")
        // Прошедший момент — недопустимое значение запроса, а не запрет состояния:
        // отличие INVALID_ARGUMENT от FAILED_PRECONDITION в том, что чинится не
        // сходка, а выбранное время (integration.md). Другой инвариант этого среза
        // решает публикация, поэтому пара здесь невозможна.
        | ScheduleMeetupPublicationError.Domain TitleRequiredForPublication ->
            invalidOp "scheduling a publication does not decide publication"
        | ScheduleMeetupPublicationError.Domain PublicationMomentInThePast ->
            Status(StatusCode.InvalidArgument, "the publication moment must be in the future")
        // ABORTED — реализационный выбор, а не контрактное обещание: код и его место
        // среди описанных закрепляет PER-78 (integration.md).
        | ScheduleMeetupPublicationError.Conflict -> Status(StatusCode.Aborted, "the meetup changed concurrently")

    let private toCommand
        (request: Meetups.V1.ScheduleMeetupPublicationRequest)
        : Result<Command, Contract.InvalidRequest> =
        match
            Contract.Inbound.viewer request.Viewer,
            Contract.Inbound.meetupId request.Id,
            Contract.Inbound.localDateTime "moment" request.Moment,
            Contract.Inbound.expectedVersion request.ExpectedVersion
        with
        | Ok viewer, Ok id, Ok moment, Ok expectedVersion ->
            Ok
                {
                    Id = id
                    Viewer = viewer
                    Moment = moment
                    ExpectedVersion = expectedVersion
                }
        | Error invalid, _, _, _
        | _, Error invalid, _, _
        | _, _, Error invalid, _
        | _, _, _, Error invalid -> Error invalid

    let handle (deps: Deps) (request: Meetups.V1.ScheduleMeetupPublicationRequest) : Task<Meetups.V1.MeetupSnapshot> =
        task {
            match toCommand request with
            | Error invalid -> return raise (RpcException(toStatus (ScheduleMeetupPublicationError.Malformed invalid)))
            | Ok command ->
                match! execute deps command with
                | Ok snapshot -> return Contract.Outbound.snapshot snapshot
                | Error error -> return raise (RpcException(toStatus error))
        }
