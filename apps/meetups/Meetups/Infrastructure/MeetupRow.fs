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
open System.Text.Json
open System.Text.Json.Nodes
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
        Materials: string
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

let private localOf (id: Guid) (date: DateOnly) (time: TimeOnly) : LocalDateTime =
    let localTime =
        LocalTime.create time
        |> Result.defaultWith (fun _ -> malformed id $"schedule time {time} is more precise than a minute")

    {
        Date = date
        Time = localTime
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
    | "day_start" -> DayStart(localOf row.Id (startDate ()) (startTime ()))
    | "interval" ->
        let finish =
            if
                row.ScheduleEndDate.HasValue
                && row.ScheduleEndTime.HasValue
            then
                localOf row.Id row.ScheduleEndDate.Value row.ScheduleEndTime.Value
            else
                malformed row.Id "schedule interval end is missing"

        match LocalInterval.create (localOf row.Id (startDate ()) (startTime ())) finish with
        | Ok interval -> Interval interval
        | Error IntervalEndsBeforeItStarts -> malformed row.Id "schedule interval ends before it starts"
    | other -> malformed row.Id $"unknown schedule precision {other}"

let private scheduleOf (row: MeetupRow) : Schedule =
    match row.ScheduleForm with
    | "no_date" -> NoDate
    | "tentative" -> Tentative(dateValueOf row)
    | "fixed" -> Fixed(dateValueOf row)
    | other -> malformed row.Id $"unknown schedule form {other}"

/// Источник материала одной формой на двух потребителей: колонку состояния и тело
/// события. Форма внутренняя, поэтому совпадение имён с `meetups.v1` — удобство
/// чтения, а не обещание совместимости; расходиться двум потребителям нельзя по
/// той же причине, что и колонкам расписания.
let private sourceNode (source: MaterialSource) : JsonNode =
    let node = JsonObject()

    match source with
    | MessageLink link ->
        node["kind"] <- JsonValue.Create "message_link"
        node["value"] <- JsonValue.Create link
    | FileId fileId ->
        node["kind"] <- JsonValue.Create "file_id"
        node["value"] <- JsonValue.Create fileId

    node

let private materialNode (material: MeetupMaterial) : JsonNode =
    let (MaterialId id) = material.Id
    let (PersonId boundBy) = material.BoundBy
    let node = JsonObject()

    node["id"] <- JsonValue.Create(id.ToString "D")
    node["position"] <- JsonValue.Create material.Position
    node["title"] <- JsonValue.Create material.Title
    node["source"] <- sourceNode material.Source
    node["bound_by"] <- JsonValue.Create(boundBy.ToString "D")

    node

/// Порядок массива и есть порядок коллекции: позиция лежит рядом явно, потому что
/// она часть данных материала (PER-200), а не только порядок обхода.
let materialsNode (materials: MeetupMaterial list) : JsonArray =
    let array = JsonArray()

    for material in materials do
        array.Add(materialNode material)

    array

let materialsJson (materials: MeetupMaterial list) : string = (materialsNode materials).ToJsonString()

let private jsonText (meetupId: Guid) (what: string) (node: JsonNode) : string =
    match node with
    | :? JsonValue as value ->
        match value.TryGetValue<string>() with
        | true, text -> text
        | _ -> malformed meetupId $"{what} is not text"
    | _ -> malformed meetupId $"{what} is not text"

let private jsonInt (meetupId: Guid) (what: string) (node: JsonNode) : int =
    match node with
    | :? JsonValue as value ->
        match value.TryGetValue<int>() with
        | true, number -> number
        | _ -> malformed meetupId $"{what} is not an integer"
    | _ -> malformed meetupId $"{what} is not an integer"

/// Разбор идентификатора идёт через тот же `malformed`, а не через `Guid.Parse`:
/// исключение без идентификатора сходки не отличить от сбоя вне разбора строки, и
/// порча элемента перестала бы читаться как порча строки.
let private jsonUuid (meetupId: Guid) (what: string) (node: JsonNode) : Guid =
    match Guid.TryParseExact(jsonText meetupId what node, "D") with
    | true, value -> value
    | _ -> malformed meetupId $"{what} is not a UUID"

let private sourceOfNode (meetupId: Guid) (node: JsonNode) : MaterialSource =
    match node with
    | :? JsonObject as entry ->
        let kind = jsonText meetupId "material source kind" entry["kind"]
        let value = jsonText meetupId "material source value" entry["value"]

        match kind with
        | "message_link" -> MessageLink value
        | "file_id" -> FileId value
        | other -> malformed meetupId $"unknown material source kind {other}"
    | _ -> malformed meetupId "material source is not an object"

let private materialOfNode (meetupId: Guid) (node: JsonNode) : MeetupMaterial =
    match node with
    | :? JsonObject as entry ->
        {
            Id = MaterialId(jsonUuid meetupId "material id" entry["id"])
            Position = jsonInt meetupId "material position" entry["position"]
            Title = jsonText meetupId "material title" entry["title"]
            Source = sourceOfNode meetupId entry["source"]
            BoundBy = PersonId(jsonUuid meetupId "material bound_by" entry["bound_by"])
        }
    | _ -> malformed meetupId "material entry is not an object"

/// Строка, которую схема одобрила, но домен прочитать не может, падает так же,
/// как неизвестная ось: с идентификатором сходки и без молчаливой подстановки.
let private materialsOfJson (meetupId: Guid) (json: string) : MeetupMaterial list =
    let parsed =
        try
            JsonNode.Parse json
        with :? JsonException ->
            malformed meetupId "materials is not JSON"

    match parsed with
    | :? JsonArray as array ->
        array
        |> Seq.map (materialOfNode meetupId)
        |> List.ofSeq
    | _ -> malformed meetupId "materials is not an array"

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
        Materials = materialsOfJson row.Id row.Materials
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
            StartTime = Nullable(LocalTime.value local.Time)
        }
    | Interval interval ->
        let start = LocalInterval.start interval
        let finish = LocalInterval.finish interval

        { emptySchedule with
            Precision = "interval"
            StartDate = Nullable start.Date
            StartTime = Nullable(LocalTime.value start.Time)
            EndDate = Nullable finish.Date
            EndTime = Nullable(LocalTime.value finish.Time)
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
        Materials = materialsJson snapshot.Materials
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
