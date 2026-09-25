/// Тело строки журнала: снимок состояния после события (ADR-031). Пишется явным
/// писателем, а не сериализатором по умолчанию: Schedule, оси состояния и option —
/// это F#-суммы, разумного представления по умолчанию у них нет, и полагаться на
/// него значило бы закрепить случайную форму молча.
///
/// Форма внутренняя. Это хранение, а не шина: наружу то же событие уходит
/// сообщением `meetups.v1.MeetupEvent` (PER-206), и совпадение имён с ним здесь —
/// удобство чтения, а не обещание совместимости. Перевод одной формы в другую
/// принадлежит адаптеру публикации (PER-209): он читает payload обратно в снимок
/// через `toSnapshot`, и писатель с читателем лежат рядом, чтобы форма менялась
/// одним изменением.
module Meetups.Infrastructure.MeetupEventPayload

open System
open System.Globalization
open System.Text.Json
open System.Text.Json.Nodes
open Meetups.Domain

/// Повод события именем, которое принимает `meetup_events_type_check`.
let eventType (event: MeetupEvent) : string =
    match event with
    | MeetupCreated _ -> "meetup_created"
    | MeetupChanged _ -> "meetup_changed"
    | MeetupPublished _ -> "meetup_published"
    | MeetupUnpublished -> "meetup_unpublished"
    | MeetupRepublished -> "meetup_republished"
    | MeetupPublicationScheduled _ -> "meetup_publication_scheduled"
    | MeetupPublicationCancelled -> "meetup_publication_cancelled"
    | MeetupCancelled -> "meetup_cancelled"
    | MeetupMaterialAttached _ -> "meetup_material_attached"
    | MeetupMaterialRemoved _ -> "meetup_material_removed"
    | MeetupHeld -> "meetup_held"

/// Данные повода, которых снимок выразить не может: удалённого материала в нём уже
/// нет. Колонка `material_id`, а не ключ payload, — её правило держит CHECK
/// `meetup_events_material_id_occasion`, и заполнена она ровно у двух поводов.
let materialId (event: MeetupEvent) : Nullable<Guid> =
    match event with
    | MeetupMaterialAttached material ->
        let (MaterialId id) = material.Id
        Nullable id
    | MeetupMaterialRemoved(MaterialId id) -> Nullable id
    | MeetupCreated _
    | MeetupChanged _
    | MeetupPublished _
    | MeetupUnpublished
    | MeetupRepublished
    | MeetupPublicationScheduled _
    | MeetupPublicationCancelled
    | MeetupCancelled
    | MeetupHeld -> Nullable()

let private dateText (date: DateOnly) : string = date.ToString "yyyy-MM-dd"

/// Доменное время уже имеет минутную точность; payload записывает его без потерь.
let private timeText (time: TimeOnly) : string = time.ToString "HH\:mm"

/// Расписание пишется той же раскладкой, что уходит в колонки. Одно определение
/// формы на два потребителя: колонки и payload не могут разойтись между собой.
let private scheduleNode (schedule: Schedule) : JsonNode =
    let columns = MeetupRow.scheduleColumns schedule
    let node = JsonObject()

    node["form"] <- JsonValue.Create columns.Form

    if not (isNull columns.Precision) then
        node["precision"] <- JsonValue.Create columns.Precision

    if columns.StartDate.HasValue then
        node["start_date"] <- JsonValue.Create(dateText columns.StartDate.Value)

    if columns.StartTime.HasValue then
        node["start_time"] <- JsonValue.Create(timeText columns.StartTime.Value)

    if columns.EndDate.HasValue then
        node["end_date"] <- JsonValue.Create(dateText columns.EndDate.Value)

    if columns.EndTime.HasValue then
        node["end_time"] <- JsonValue.Create(timeText columns.EndTime.Value)

    node

/// Снимок целиком. Объект, а не массив и не скаляр: этого требует
/// `meetup_events_payload_object`.
let ofSnapshot (snapshot: MeetupSnapshot) : string =
    let row = MeetupRow.ofSnapshot snapshot
    let node = JsonObject()

    node["id"] <- JsonValue.Create(row.Id.ToString())
    node["author"] <- JsonValue.Create(row.Author.ToString())
    node["title"] <- JsonValue.Create row.Title
    node["description"] <- JsonValue.Create row.Description
    node["venue"] <- JsonValue.Create row.Venue
    node["kind"] <- JsonValue.Create row.Kind
    node["calendar_link"] <- JsonValue.Create row.CalendarLink
    node["schedule"] <- scheduleNode snapshot.Schedule
    // Материалы входят в снимок наравне с расписанием: тело события — что теперь
    // правда, а коллекция материалов — часть этой правды. Потребитель выводит
    // «материал добавлен» сравнением с собственной репликой (ADR-031).
    node["materials"] <- MeetupRow.materialsNode snapshot.Materials
    node["lifecycle"] <- JsonValue.Create row.Lifecycle
    node["visibility"] <- JsonValue.Create row.Visibility

    // Отсутствие первой публикации выражается отсутствием поля, а не пустой
    // строкой: у `first_published_at` presence настоящая, и unset означает
    // «никогда не публиковалась».
    //
    // Момент берётся из строки, уже приведённой к точности хранения, и пишется
    // микросекундами целиком — той же точностью, что уходит в колонку. Секунды
    // отбросили бы хвост только в payload, и неизменяемая запись журнала стала бы
    // грубее состояния, из которого сделана: релею было бы неоткуда восстановить
    // отброшенное.
    if row.FirstPublishedAt.HasValue then
        node["first_published_at"] <-
            JsonValue.Create(row.FirstPublishedAt.Value.ToString "yyyy-MM-ddTHH\:mm\:ss.ffffffZ")

    // Момент отложенной публикации — такое же настоящее отсутствие: unset означает
    // «публикация не назначена». Снимок журнала обязан нести его наравне с
    // состоянием, иначе релей (PER-206) не восстановит по событию назначение, а
    // форма записи разойдётся с первой публикацией.
    if row.ScheduledPublishAt.HasValue then
        node["scheduled_publish_at"] <-
            JsonValue.Create(row.ScheduledPublishAt.Value.ToString "yyyy-MM-ddTHH\:mm\:ss.ffffffZ")

    node["version"] <- JsonValue.Create row.Version

    node.ToJsonString()

/// Payload, который схема приняла, но читатель разобрать не может, — нарушение
/// внутреннего контракта писателя и читателя, а не ожидаемый отказ. Исключение с
/// идентификатором события, по той же причине, что `malformed` у MeetupRow.
let private malformed (eventId: Guid) (what: string) : 'a = failwith $"malformed meetup event payload {eventId}: {what}"

let private required (eventId: Guid) (node: JsonObject) (name: string) : JsonNode =
    match node[name] with
    | null -> malformed eventId $"{name} is missing"
    | value -> value

let private text (eventId: Guid) (node: JsonObject) (name: string) : string =
    match required eventId node name with
    | :? JsonValue as value ->
        match value.TryGetValue<string>() with
        | true, result -> result
        | _ -> malformed eventId $"{name} is not text"
    | _ -> malformed eventId $"{name} is not text"

let private optionalText (eventId: Guid) (node: JsonObject) (name: string) : string option =
    match node[name] with
    | null -> None
    | _ -> Some(text eventId node name)

let private uuid (eventId: Guid) (node: JsonObject) (name: string) : Guid =
    match Guid.TryParseExact(text eventId node name, "D") with
    | true, value -> value
    | _ -> malformed eventId $"{name} is not a UUID"

let private int64Of (eventId: Guid) (node: JsonObject) (name: string) : int64 =
    match required eventId node name with
    | :? JsonValue as value ->
        match value.TryGetValue<int64>() with
        | true, result -> result
        | _ -> malformed eventId $"{name} is not an integer"
    | _ -> malformed eventId $"{name} is not an integer"

let private parseExact
    (eventId: Guid)
    (name: string)
    (format: string)
    (parse: string -> string -> 'a option)
    (value: string)
    =
    match parse value format with
    | Some result -> result
    | None -> malformed eventId $"{name} is not in the form {format}"

let private dateOf (eventId: Guid) (node: JsonObject) (name: string) : Nullable<DateOnly> =
    optionalText eventId node name
    |> Option.map (
        parseExact
            eventId
            name
            "yyyy-MM-dd"
            (fun value format ->
                match DateOnly.TryParseExact(value, format, CultureInfo.InvariantCulture, DateTimeStyles.None) with
                | true, date -> Some date
                | _ -> None
            )
    )
    |> Option.toNullable

let private timeOf (eventId: Guid) (node: JsonObject) (name: string) : Nullable<TimeOnly> =
    optionalText eventId node name
    |> Option.map (
        parseExact
            eventId
            name
            "HH:mm"
            (fun value format ->
                match TimeOnly.TryParseExact(value, format, CultureInfo.InvariantCulture, DateTimeStyles.None) with
                | true, time -> Some time
                | _ -> None
            )
    )
    |> Option.toNullable

let private momentOf (eventId: Guid) (node: JsonObject) (name: string) : Nullable<DateTimeOffset> =
    optionalText eventId node name
    |> Option.map (
        parseExact
            eventId
            name
            "yyyy-MM-ddTHH:mm:ss.ffffffZ"
            (fun value format ->
                match
                    DateTimeOffset.TryParseExact(
                        value,
                        format,
                        CultureInfo.InvariantCulture,
                        DateTimeStyles.AssumeUniversal
                        ||| DateTimeStyles.AdjustToUniversal
                    )
                with
                | true, moment -> Some moment
                | _ -> None
            )
    )
    |> Option.toNullable

/// Обратное `ofSnapshot`: payload в снимок. Читает в ту же строку `MeetupRow`, что
/// приходит из таблицы, и отдаёт её `MeetupRow.toSnapshot`, поэтому правила оси,
/// расписания и материалов разбираются одним кодом на оба источника, а не копией.
let toSnapshot (eventId: Guid) (payload: string) : MeetupSnapshot =
    let root =
        try
            JsonNode.Parse payload
        with :? JsonException ->
            malformed eventId "payload is not JSON"

    match root with
    | :? JsonObject as node ->
        let schedule =
            match required eventId node "schedule" with
            | :? JsonObject as value -> value
            | _ -> malformed eventId "schedule is not an object"

        // Отсутствие ключа — не порча, а возраст строки: писатель стал класть
        // коллекцию в payload с PER-201, а до него материалов у сходки не было вовсе,
        // и пустая коллекция — ровно то, что было правдой. Журнал неизменяем, и
        // другого способа прочитать такие строки у адаптера нет. Ключ, который есть,
        // но не массив, по-прежнему дефект.
        let materials =
            match node["materials"] with
            | null -> "[]"
            | :? JsonArray as value -> value.ToJsonString()
            | _ -> malformed eventId "materials is not an array"

        MeetupRow.toSnapshot
            {
                Id = uuid eventId node "id"
                Author = uuid eventId node "author"
                Title = text eventId node "title"
                Description = text eventId node "description"
                Venue = text eventId node "venue"
                Kind = text eventId node "kind"
                CalendarLink = text eventId node "calendar_link"
                Materials = materials
                Lifecycle = text eventId node "lifecycle"
                Visibility = text eventId node "visibility"
                FirstPublishedAt = momentOf eventId node "first_published_at"
                ScheduledPublishAt = momentOf eventId node "scheduled_publish_at"
                Version = int64Of eventId node "version"
                ScheduleForm = text eventId schedule "form"
                SchedulePrecision =
                    optionalText eventId schedule "precision"
                    |> Option.toObj
                ScheduleStartDate = dateOf eventId schedule "start_date"
                ScheduleStartTime = timeOf eventId schedule "start_time"
                ScheduleEndDate = dateOf eventId schedule "end_date"
                ScheduleEndTime = timeOf eventId schedule "end_time"
            }
    | _ -> malformed eventId "payload is not an object"
