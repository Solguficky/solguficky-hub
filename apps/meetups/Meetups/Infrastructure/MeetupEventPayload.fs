/// Тело строки журнала: снимок состояния после события (ADR-031). Пишется явным
/// писателем, а не сериализатором по умолчанию: Schedule, оси состояния и option —
/// это F#-суммы, разумного представления по умолчанию у них нет, и полагаться на
/// него значило бы закрепить случайную форму молча.
///
/// Форма внутренняя. Это хранение, а не шина: конверт публикуемого наружу события,
/// subject и wire-формат остаются открытой контрактной задачей, и совпадение имён
/// с `meetups.v1` здесь — удобство чтения, а не обещание совместимости. Читателя у
/// payload не будет до появления релея, поэтому пишется только писатель.
module Meetups.Infrastructure.MeetupEventPayload

open System
open System.Text.Json.Nodes
open Meetups.Domain

/// Повод события именем, которое принимает `meetup_events_type_check`.
let eventType (event: MeetupEvent) : string =
    match event with
    | MeetupCreated _ -> "meetup_created"
    | MeetupChanged _ -> "meetup_changed"
    | MeetupPublished _ -> "meetup_published"

let private dateText (date: DateOnly) : string = date.ToString "yyyy-MM-dd"

/// Минутная точность держится схемой (`meetups_schedule_minute_precision`), и форма
/// записи повторяет её же: секунд в LocalTime контракта нет.
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

    node["version"] <- JsonValue.Create row.Version

    node.ToJsonString()
