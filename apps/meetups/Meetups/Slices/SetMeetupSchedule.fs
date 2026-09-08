/// Срез «задать расписание». Расписание приходит одним собранным значением: его
/// структурные инварианты закрыты типом (перевёрнутый интервал невыразим), поэтому
/// отказа сборки значения здесь уже быть не может — он остаётся на границе сервиса.
module Meetups.Slices.SetMeetupSchedule

open System
open System.Threading.Tasks
open Meetups.Domain
open Meetups.Infrastructure

type Command =
    {
        Id: MeetupId
        Viewer: Viewer
        Schedule: Schedule
    }

[<RequireQualifiedAccess; NoComparison>]
type SetMeetupScheduleError =
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

let execute (deps: Deps) (command: Command) : Task<Result<MeetupSnapshot, SetMeetupScheduleError>> =
    task {
        // Право спрашивается до загрузки: состояние в этом решении не участвует, а
        // проверка после чтения сделала бы отказ обычному смотрящему зависимым от
        // того, существует ли сходка.
        match Access.toCommand command.Viewer with
        | Error denied -> return Error(SetMeetupScheduleError.Forbidden denied)
        | Ok() ->
            let! existing = deps.Load command.Id
            let state = Meetup.restore existing

            match Meetup.decideSetSchedule command.Schedule state with
            | Error error -> return Error(SetMeetupScheduleError.Domain error)
            | Ok event ->
                let envelope: MeetupStore.EventEnvelope =
                    {
                        EventId = deps.NewEventId()
                        PerformedBy = command.Viewer.IdentityId
                        OccurredAt = deps.Now()
                    }

                match! deps.Commit envelope state event with
                | Ok snapshot -> return Ok snapshot
                | Error MeetupStore.VersionConflict -> return Error SetMeetupScheduleError.Conflict
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

    let private toStatus (error: SetMeetupScheduleError) : Status =
        match error with
        | SetMeetupScheduleError.Malformed invalid ->
            Status(StatusCode.InvalidArgument, $"{invalid.Field} {invalid.Problem}")
        | SetMeetupScheduleError.Forbidden NotAnAdministrator ->
            Status(StatusCode.PermissionDenied, "an administrator role is required")
        | SetMeetupScheduleError.Domain MeetupNotFound
        | SetMeetupScheduleError.Domain DraftBelongsToAnotherAuthor -> Status(StatusCode.NotFound, "meetup not found")
        // Инвариант публикации решает другой срез: пара невозможна, поэтому нарушение
        // внутреннего контракта, а не код отказа.
        | SetMeetupScheduleError.Domain TitleRequiredForPublication ->
            invalidOp "setting the schedule does not decide publication"
        // ABORTED — реализационный выбор, а не контрактное обещание: код и его место
        // среди описанных закрепляет PER-78 (integration.md).
        | SetMeetupScheduleError.Conflict -> Status(StatusCode.Aborted, "the meetup changed concurrently")

    /// Разбор расписания живёт в срезе, а не в Contract: потребитель у него ровно
    /// один. Отказ сборки значения — INVALID_ARGUMENT, потому что несобранное
    /// расписание до агрегата не доходит и отклонённым переходом состояния не является.
    module private Inbound =

        let private calendarDate
            (field: string)
            (value: Meetups.V1.CalendarDate)
            : Result<DateOnly, Contract.InvalidRequest> =
            if isNull (box value) then
                Error(Contract.invalid field "is required")
            else
                try
                    Ok(DateOnly(value.Year, value.Month, value.Day))
                with :? ArgumentOutOfRangeException ->
                    Error(Contract.invalid field "is not a calendar date")

        /// Минутную точность держит граница: TimeOnly умеет секунды, которых в схеме
        /// нет, поэтому диапазон проверяется здесь, а не подразумевается.
        let private localTime
            (field: string)
            (value: Meetups.V1.LocalTime)
            : Result<TimeOnly, Contract.InvalidRequest> =
            if isNull (box value) then
                Error(Contract.invalid field "is required")
            elif
                value.Hours < 0
                || value.Hours > 23
                || value.Minutes < 0
                || value.Minutes > 59
            then
                Error(Contract.invalid field "must be a time of day at minute precision")
            else
                Ok(TimeOnly(value.Hours, value.Minutes))

        let private localDateTime
            (field: string)
            (value: Meetups.V1.LocalDateTime)
            : Result<LocalDateTime, Contract.InvalidRequest> =
            if isNull (box value) then
                Error(Contract.invalid field "is required")
            else
                match calendarDate $"{field}.date" value.Date, localTime $"{field}.time" value.Time with
                | Ok date, Ok time ->
                    Ok
                        {
                            Date = date
                            Time = time
                        }
                | Error invalid, _
                | _, Error invalid -> Error invalid

        let private dateValue
            (field: string)
            (value: Meetups.V1.DateValue)
            : Result<DateValue, Contract.InvalidRequest> =
            match value.PrecisionCase with
            | Meetups.V1.DateValue.PrecisionOneofCase.Day ->
                calendarDate $"{field}.day" value.Day
                |> Result.map Day
            | Meetups.V1.DateValue.PrecisionOneofCase.DayStart ->
                localDateTime $"{field}.day_start" value.DayStart
                |> Result.map DayStart
            | Meetups.V1.DateValue.PrecisionOneofCase.Interval ->
                match
                    localDateTime $"{field}.interval.start" value.Interval.Start,
                    localDateTime $"{field}.interval.end" value.Interval.End
                with
                | Ok start, Ok finish ->
                    // Перевёрнутый интервал в домене невыразим: смарт-конструктор
                    // отказывает, и его отказ остаётся отказом сборки значения.
                    LocalInterval.create start finish
                    |> Result.map Interval
                    |> Result.mapError (fun IntervalEndsBeforeItStarts ->
                        Contract.invalid $"{field}.interval" "must not end before it starts"
                    )
                | Error invalid, _
                | _, Error invalid -> Error invalid
            | _ -> Error(Contract.invalid field "must set exactly one precision")

        let schedule (value: Meetups.V1.Schedule) : Result<Schedule, Contract.InvalidRequest> =
            if isNull (box value) then
                Error(Contract.invalid "schedule" "is required")
            else
                match value.FormCase with
                | Meetups.V1.Schedule.FormOneofCase.NoDate -> Ok NoDate
                | Meetups.V1.Schedule.FormOneofCase.Tentative ->
                    dateValue "schedule.tentative" value.Tentative
                    |> Result.map Tentative
                | Meetups.V1.Schedule.FormOneofCase.Fixed ->
                    dateValue "schedule.fixed" value.Fixed
                    |> Result.map Fixed
                // Пустой oneof не является вторым написанием «даты нет»: это форма
                // no_date. Дочитать запрос значением по умолчанию значило бы превратить
                // ошибку сборки у клиента в тихо неверные данные.
                | _ -> Error(Contract.invalid "schedule" "must set exactly one form; absence is the no_date form")

    let private toCommand (request: Meetups.V1.SetMeetupScheduleRequest) : Result<Command, Contract.InvalidRequest> =
        match
            Contract.Inbound.viewer request.Viewer,
            Contract.Inbound.meetupId request.Id,
            Inbound.schedule request.Schedule
        with
        | Ok viewer, Ok id, Ok schedule ->
            Ok
                {
                    Id = id
                    Viewer = viewer
                    Schedule = schedule
                }
        | Error invalid, _, _
        | _, Error invalid, _
        | _, _, Error invalid -> Error invalid

    let handle (deps: Deps) (request: Meetups.V1.SetMeetupScheduleRequest) : Task<Meetups.V1.MeetupSnapshot> =
        task {
            match toCommand request with
            | Error invalid -> return raise (RpcException(toStatus (SetMeetupScheduleError.Malformed invalid)))
            | Ok command ->
                match! execute deps command with
                | Ok snapshot -> return Contract.Outbound.snapshot snapshot
                | Error error -> return raise (RpcException(toStatus error))
        }
