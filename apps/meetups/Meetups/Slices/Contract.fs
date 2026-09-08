/// Перевод между сгенерированным контрактом meetups.v1 и доменным словарём.
///
/// Общий модуль срезов, а не Infrastructure/: функция знает два контракта сразу и
/// переводит один в другой, а MeetupSnapshot — целевая модель отображения, а не
/// словарь значений. Оба проверочных вопроса норматива дают «нет», и файл
/// принадлежит срезам.
///
/// Здесь лежит только то, у чего сегодня несколько потребителей: смотрящий,
/// идентификатор и снимок нужны всем четырём командам. Разбор расписания и
/// атрибутов остаётся в своих срезах — там у них ровно один потребитель.
///
/// Контрактные типы пишутся квалифицированно: `open Meetups.V1` молча переопределил
/// бы MeetupSnapshot в сигнатурах, потому что доменный тип назван так же.
module Meetups.Slices.Contract

open System
open Meetups.Domain

/// Отказ разбора запроса. Общим типом ошибок приложения не является: он называет
/// неуспех одной функции перевода — так же, как MeetupStore.VersionConflict называет
/// неуспех записи. Ветвиться по нему негде, весь тип отображается ровно в
/// INVALID_ARGUMENT, поэтому проверку полноты он не убивает.
///
/// Значение поля сюда не попадает: там произвольный ввод вызывающей стороны, а текст
/// уходит и клиенту, и в запись границы (logging.md).
type InvalidRequest =
    {
        Field: string
        Problem: string
    }

module Inbound =

    /// Канонический вид строки и версию UUID проверяет граница сервиса, а не домен —
    /// обещание из Domain/Ids.fs, которое исполняется здесь.
    ///
    /// Сравнение с `Guid.ToString "D"` закрывает и регистр, и дефисы одним шагом:
    /// TryParseExact "D" принимает верхний регистр, а канонический вид нижний.
    let private uuidV7 (field: string) (value: string) : Result<Guid, InvalidRequest> =
        match Guid.TryParseExact(value, "D") with
        | true, parsed when value = parsed.ToString "D" ->
            if parsed.Version = 7 then
                Ok parsed
            else
                Error
                    {
                        Field = field
                        Problem = "must be a UUIDv7"
                    }
        | _ ->
            Error
                {
                    Field = field
                    Problem = "must be a canonical lowercase UUID with hyphens"
                }

    let meetupId (value: string) : Result<MeetupId, InvalidRequest> = uuidV7 "id" value |> Result.map MeetupId

    /// Неизвестная роль отбрасывается, а не отвергается. Схема сама объявляет
    /// GLOBAL_ROLE_UNSPECIFIED значением «роль неизвестна потребителю», и неизвестная
    /// роль ничего не разрешает — отбрасывание остаётся fail-closed. Отказ по ней
    /// превратил бы расширение словаря ролей в Identity в отказ обслуживания у
    /// Meetups до согласованного деплоя обоих сервисов.
    let private role (value: Identity.V1.GlobalRole) : GlobalRole option =
        match value with
        | Identity.V1.GlobalRole.Admin -> Some Administrator
        | _ -> None

    let viewer (value: Meetups.V1.Viewer) : Result<Viewer, InvalidRequest> =
        if isNull (box value) then
            Error
                {
                    Field = "viewer"
                    Problem = "is required"
                }
        else
            uuidV7 "viewer.identity_id" value.IdentityId
            |> Result.map (fun identity ->
                {
                    IdentityId = PersonId identity
                    Roles = value.GlobalRoles |> Seq.choose role |> Set.ofSeq
                }
            )

module Outbound =

    let private calendarDate (date: DateOnly) : Meetups.V1.CalendarDate =
        Meetups.V1.CalendarDate(Year = date.Year, Month = date.Month, Day = date.Day)

    let private localDateTime (value: LocalDateTime) : Meetups.V1.LocalDateTime =
        Meetups.V1.LocalDateTime(
            Date = calendarDate value.Date,
            // Секунд в контракте нет: минутную точность держит граница, потому что
            // TimeOnly умеет больше, чем схема.
            Time = Meetups.V1.LocalTime(Hours = value.Time.Hour, Minutes = value.Time.Minute)
        )

    let private dateValue (value: DateValue) : Meetups.V1.DateValue =
        match value with
        | Day date -> Meetups.V1.DateValue(Day = calendarDate date)
        | DayStart moment -> Meetups.V1.DateValue(DayStart = localDateTime moment)
        | Interval interval ->
            Meetups.V1.DateValue(
                Interval =
                    Meetups.V1.LocalInterval(
                        Start = localDateTime (LocalInterval.start interval),
                        End = localDateTime (LocalInterval.finish interval)
                    )
            )

    let schedule (value: Schedule) : Meetups.V1.Schedule =
        match value with
        | NoDate -> Meetups.V1.Schedule(NoDate = Meetups.V1.NoDate())
        | Tentative date -> Meetups.V1.Schedule(Tentative = dateValue date)
        | Fixed date -> Meetups.V1.Schedule(Fixed = dateValue date)

    let private lifecycle (value: MeetupLifecycle) : Meetups.V1.MeetupLifecycle =
        match value with
        | Planned -> Meetups.V1.MeetupLifecycle.Planned
        | Held -> Meetups.V1.MeetupLifecycle.Held
        | Cancelled -> Meetups.V1.MeetupLifecycle.Cancelled

    let private visibility (value: MeetupVisibility) : Meetups.V1.MeetupVisibility =
        match value with
        | Hidden -> Meetups.V1.MeetupVisibility.Hidden
        | Visible -> Meetups.V1.MeetupVisibility.Visible

    let snapshot (value: Meetups.Domain.MeetupSnapshot) : Meetups.V1.MeetupSnapshot =
        let (MeetupId id) = value.Id
        let (PersonId author) = value.Author

        let contract =
            Meetups.V1.MeetupSnapshot(
                // "D" даёт каноническую нижнюю регистровую форму с дефисами — ту же,
                // которую граница требует на входе.
                Id = id.ToString "D",
                Author = author.ToString "D",
                Title = value.Title,
                Description = value.Description,
                Venue = value.Venue,
                Kind = value.Kind,
                CalendarLink = value.CalendarLink,
                Schedule = schedule value.Schedule,
                Lifecycle = lifecycle value.Lifecycle,
                Visibility = visibility value.Visibility,
                Version = value.Version
            )

        // Единственное настоящее отсутствие в сообщении: unset означает «никогда не
        // публиковалась». UtcDateTime, а не сам DateTimeOffset: формат "o" у второго
        // печатает смещение +00:00, а контракт требует RFC 3339 UTC с Z.
        match value.FirstPublishedAt with
        | Some at -> contract.FirstPublishedAt <- at.ToUniversalTime().UtcDateTime.ToString "o"
        | None -> ()

        contract
