/// Отображение строки таблицы `meetups` в снимок состояния и обратно. Чистое: ни
/// одного обращения к базе, поэтому раскладка расписания по шести колонкам
/// проверяется unit-тестами без PostgreSQL — это самая ошибкоёмкая часть записи.
///
/// Отображение живёт в Infrastructure, а не внутри среза: снимок задан ADR-031 как
/// каноническая форма чтения домена и не принадлежит ни одному сценарию, а
/// потребителей у раскладки четыре — по числу команд. Копия этих правил в каждом
/// срезе означала бы четыре места, где `meetups_schedule_shape_check` ловит промах
/// уже в рантайме.
module Meetups.Infrastructure.MeetupRow

open System
open Meetups.Domain

/// Строка таблицы в терминах .NET: nullable вместо option, строки вместо DU.
/// CLIMutable нужен Dapper для материализации; дальше этого типа nullable не
/// проходит — этого требует языковой стандарт.
[<CLIMutable>]
type MeetupRow =
    {
        Id: Guid
        Author: Guid
        Title: string
        Description: string
        Venue: string
        Kind: string
        CalendarLink: string
        Lifecycle: string
        Visibility: string
        FirstPublishedAt: Nullable<DateTimeOffset>
        Version: int64
        ScheduleForm: string
        SchedulePrecision: string
        ScheduleStartDate: Nullable<DateOnly>
        ScheduleStartTime: Nullable<TimeOnly>
        ScheduleEndDate: Nullable<DateOnly>
        ScheduleEndTime: Nullable<TimeOnly>
    }

/// Строка, которую схема одобрила, но домен прочитать не может, — это нарушение
/// внутреннего контракта, а не ожидаемый отказ. Поэтому исключение, а не вариант
/// error DU: вызывающей стороне тут нечего решать.
let private malformed (id: Guid) (what: string) : 'a = failwith $"malformed meetup row {id}: {what}"

let private lifecycleOf (id: Guid) (value: string) : MeetupLifecycle =
    match value with
    | "planned" -> Planned
    | "held" -> Held
    | "cancelled" -> Cancelled
    | other -> malformed id $"unknown lifecycle {other}"

let private visibilityOf (id: Guid) (value: string) : MeetupVisibility =
    match value with
    | "hidden" -> Hidden
    | "visible" -> Visible
    | other -> malformed id $"unknown visibility {other}"

let private localOf (date: DateOnly) (time: TimeOnly) : LocalDateTime =
    {
        Date = date
        Time = time
    }

/// Пара «форма и точность» разворачивается в DateValue. Схема допускает ровно семь
/// сочетаний, и каждое недопустимое здесь падает: молчаливая подстановка значения
/// по умолчанию превратила бы битую строку в правдоподобную сходку.
let private dateValueOf (row: MeetupRow) : DateValue =
    let startDate () =
        if row.ScheduleStartDate.HasValue then
            row.ScheduleStartDate.Value
        else
            malformed row.Id "schedule start date is missing"

    let startTime () =
        if row.ScheduleStartTime.HasValue then
            row.ScheduleStartTime.Value
        else
            malformed row.Id "schedule start time is missing"

    match row.SchedulePrecision with
    | "day" -> Day(startDate ())
    | "day_start" -> DayStart(localOf (startDate ()) (startTime ()))
    | "interval" ->
        let finish =
            if
                row.ScheduleEndDate.HasValue
                && row.ScheduleEndTime.HasValue
            then
                localOf row.ScheduleEndDate.Value row.ScheduleEndTime.Value
            else
                malformed row.Id "schedule interval end is missing"

        match LocalInterval.create (localOf (startDate ()) (startTime ())) finish with
        | Ok interval -> Interval interval
        | Error IntervalEndsBeforeItStarts -> malformed row.Id "schedule interval ends before it starts"
    | other -> malformed row.Id $"unknown schedule precision {other}"

let private scheduleOf (row: MeetupRow) : Schedule =
    match row.ScheduleForm with
    | "no_date" -> NoDate
    | "tentative" -> Tentative(dateValueOf row)
    | "fixed" -> Fixed(dateValueOf row)
    | other -> malformed row.Id $"unknown schedule form {other}"

let toSnapshot (row: MeetupRow) : MeetupSnapshot =
    {
        Id = MeetupId row.Id
        Author = PersonId row.Author
        Title = row.Title
        Description = row.Description
        Venue = row.Venue
        Kind = row.Kind
        CalendarLink = row.CalendarLink
        Schedule = scheduleOf row
        Lifecycle = lifecycleOf row.Id row.Lifecycle
        Visibility = visibilityOf row.Id row.Visibility
        FirstPublishedAt = if row.FirstPublishedAt.HasValue then Some row.FirstPublishedAt.Value else None
        Version = row.Version
    }

let private lifecycleText (lifecycle: MeetupLifecycle) : string =
    match lifecycle with
    | Planned -> "planned"
    | Held -> "held"
    | Cancelled -> "cancelled"

let private visibilityText (visibility: MeetupVisibility) : string =
    match visibility with
    | Hidden -> "hidden"
    | Visible -> "visible"

/// Шесть колонок расписания одним значением: форма, точность и четыре границы.
/// Собираются вместе потому, что схема проверяет их совместно, и разнести их
/// значило бы дать собрать сочетание, которое CHECK отвергнет уже в базе.
type ScheduleColumns =
    {
        Form: string
        Precision: string
        StartDate: Nullable<DateOnly>
        StartTime: Nullable<TimeOnly>
        EndDate: Nullable<DateOnly>
        EndTime: Nullable<TimeOnly>
    }

let private emptySchedule =
    {
        Form = "no_date"
        Precision = null
        StartDate = Nullable()
        StartTime = Nullable()
        EndDate = Nullable()
        EndTime = Nullable()
    }

let private dateValueColumns (value: DateValue) : ScheduleColumns =
    match value with
    | Day date ->
        { emptySchedule with
            Precision = "day"
            StartDate = Nullable date
        }
    | DayStart local ->
        { emptySchedule with
            Precision = "day_start"
            StartDate = Nullable local.Date
            StartTime = Nullable local.Time
        }
    | Interval interval ->
        let start = LocalInterval.start interval
        let finish = LocalInterval.finish interval

        { emptySchedule with
            Precision = "interval"
            StartDate = Nullable start.Date
            StartTime = Nullable start.Time
            EndDate = Nullable finish.Date
            EndTime = Nullable finish.Time
        }

let scheduleColumns (schedule: Schedule) : ScheduleColumns =
    match schedule with
    | NoDate -> emptySchedule
    | Tentative value ->
        { dateValueColumns value with
            Form = "tentative"
        }
    | Fixed value ->
        { dateValueColumns value with
            Form = "fixed"
        }

/// Момент приводится к точности хранения до записи. `TIMESTAMPTZ` держит
/// микросекунды, а `DateTimeOffset` — сотни наносекунд, и хвост отбрасывается уже
/// внутри драйвера. Отбросить его здесь — значит сделать усечение одним и тем же
/// для обоих потребителей строки: колонка и payload события пишут один и тот же
/// момент, а не два снимка, разошедшихся на невидимый остаток. Смещение
/// приводится к нулю тем же шагом: `TIMESTAMPTZ` другого не принимает.
let private storedMoment (moment: DateTimeOffset) : DateTimeOffset =
    let utc = moment.ToUniversalTime()
    let tail = utc.Ticks % TimeSpan.TicksPerMicrosecond
    DateTimeOffset(utc.Ticks - tail, TimeSpan.Zero)

/// Обратное отображение целиком: снимок в строку. Возвращает ту же запись, что
/// читается из базы, поэтому round trip проверяется одним тестом на форму.
let ofSnapshot (snapshot: MeetupSnapshot) : MeetupRow =
    let (MeetupId id) = snapshot.Id
    let (PersonId author) = snapshot.Author
    let schedule = scheduleColumns snapshot.Schedule

    {
        Id = id
        Author = author
        Title = snapshot.Title
        Description = snapshot.Description
        Venue = snapshot.Venue
        Kind = snapshot.Kind
        CalendarLink = snapshot.CalendarLink
        Lifecycle = lifecycleText snapshot.Lifecycle
        Visibility = visibilityText snapshot.Visibility
        FirstPublishedAt =
            match snapshot.FirstPublishedAt with
            | Some at -> Nullable(storedMoment at)
            | None -> Nullable()
        Version = snapshot.Version
        ScheduleForm = schedule.Form
        SchedulePrecision = schedule.Precision
        ScheduleStartDate = schedule.StartDate
        ScheduleStartTime = schedule.StartTime
        ScheduleEndDate = schedule.EndDate
        ScheduleEndTime = schedule.EndTime
    }
