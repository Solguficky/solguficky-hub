/// Единственный путь записи сходки: состояние и доменное событие ложатся одной
/// транзакцией (ADR-024). Граница транзакции видна в сигнатуре `commit`, а не
/// собирается вызывающим из нескольких шагов — иначе журнал перестаёт быть
/// согласованным с состоянием по построению и перестаёт быть outbox.
module Meetups.Infrastructure.MeetupStore

open System
open System.Threading.Tasks
open Dapper
open Npgsql
open Meetups.Domain

/// Единственный ожидаемый отказ записи: версия строки разошлась с той, из которой
/// принято решение. Всё остальное — соединение, битая строка, неизменяемость
/// журнала — нарушение внутреннего контракта и приходит исключением.
///
/// Тип объявлен здесь, а не в срезах, но общим типом ошибок приложения не является:
/// он называет неуспех одной функции, а не классифицирует отказы сервиса. Решение
/// «что показать человеку» принимает срез своим error DU.
type VersionConflict = VersionConflict

// Типы дат Dapper узнаёт до первого запроса. Регистрация стоит здесь, а не в
// composition root, потому что путь записи один, а собирающих зависимости —
// несколько: пропустить её в одном из них значило бы отказ в рантайме.
do Db.ensureTypeHandlers ()

/// Конверт строки журнала (ADR-031). Домену он не нужен ни для одного инварианта,
/// поэтому заполняется оболочкой: `event_id` рождается до транзакции и дальше
/// неизменяем, `occurred_at` — тот же момент, из которого принято решение.
[<NoComparison>]
type EventEnvelope =
    {
        EventId: Guid
        PerformedBy: PersonId
        OccurredAt: DateTimeOffset
    }

/// Алиасы приводят снейк-кейс колонок к именам полей записи. Явно, а не глобальным
/// `DefaultTypeMap.MatchNamesWithUnderscores`: статическая настройка Dapper — скрытое
/// состояние процесса, а здесь отображение читается прямо в запросе.
[<Literal>]
let private SelectSql =
    """
    SELECT
        id AS Id,
        author AS Author,
        title AS Title,
        description AS Description,
        venue AS Venue,
        kind AS Kind,
        calendar_link AS CalendarLink,
        materials AS Materials,
        lifecycle AS Lifecycle,
        visibility AS Visibility,
        first_published_at AS FirstPublishedAt,
        scheduled_publish_at AS ScheduledPublishAt,
        version AS Version,
        schedule_form AS ScheduleForm,
        schedule_precision AS SchedulePrecision,
        schedule_start_date AS ScheduleStartDate,
        schedule_start_time AS ScheduleStartTime,
        schedule_end_date AS ScheduleEndDate,
        schedule_end_time AS ScheduleEndTime
    FROM meetups
    WHERE id = @id
    """

[<Literal>]
let private InsertMeetupSql =
    """
    INSERT INTO meetups (
        id, author, title, description, venue, kind, calendar_link, materials,
        lifecycle, visibility, first_published_at, scheduled_publish_at, version,
        schedule_form, schedule_precision,
        schedule_start_date, schedule_start_time, schedule_end_date, schedule_end_time
    ) VALUES (
        @id, @author, @title, @description, @venue, @kind, @calendar_link, CAST(@materials AS jsonb),
        @lifecycle, @visibility, @first_published_at, @scheduled_publish_at, @version,
        @schedule_form, @schedule_precision,
        @schedule_start_date, @schedule_start_time, @schedule_end_date, @schedule_end_time
    )
    ON CONFLICT (id) DO NOTHING
    """

/// Проверка версии живёт в предикате, а не в прочитанном заранее значении: между
/// чтением и записью строку мог изменить другой писатель, и только сама база может
/// ответить, осталась ли версия той же. Ноль задетых строк и есть конфликт.
///
/// `scheduled_publish_at` пишется обычной колонкой из снимка: момент — часть
/// состояния, и когда его обнулять, решает домен (`MeetupPublished` и
/// `MeetupCancelled` очищают поле применением события). Раньше обнуление стояло
/// здесь условным выражением по видимости — это было верно, пока момента в снимке
/// не было вовсе; с полем в состоянии такой CASE скрыл бы расхождение домена со
/// схемой вместо того, чтобы дать `meetups_scheduled_publish_only_when_hidden`
/// отвергнуть строку.
[<Literal>]
let private UpdateMeetupSql =
    """
    UPDATE meetups
    SET author = @author,
        title = @title,
        description = @description,
        venue = @venue,
        kind = @kind,
        calendar_link = @calendar_link,
        materials = CAST(@materials AS jsonb),
        lifecycle = @lifecycle,
        visibility = @visibility,
        scheduled_publish_at = @scheduled_publish_at,
        first_published_at = @first_published_at,
        version = @version,
        schedule_form = @schedule_form,
        schedule_precision = @schedule_precision,
        schedule_start_date = @schedule_start_date,
        schedule_start_time = @schedule_start_time,
        schedule_end_date = @schedule_end_date,
        schedule_end_time = @schedule_end_time
    WHERE id = @id
      AND version = @expected_version
    """

[<Literal>]
let private InsertEventSql =
    """
    INSERT INTO meetup_events (
        event_id, meetup_id, version, event_type, payload, performed_by, occurred_at
    ) VALUES (
        @event_id, @meetup_id, @version, @event_type, CAST(@payload AS jsonb), @performed_by, @occurred_at
    )
    """

let private stateParameters (row: MeetupRow.MeetupRow) =
    {|
        id = row.Id
        author = row.Author
        title = row.Title
        description = row.Description
        venue = row.Venue
        kind = row.Kind
        calendar_link = row.CalendarLink
        materials = row.Materials
        lifecycle = row.Lifecycle
        visibility = row.Visibility
        first_published_at = row.FirstPublishedAt
        scheduled_publish_at = row.ScheduledPublishAt
        version = row.Version
        schedule_form = row.ScheduleForm
        schedule_precision = row.SchedulePrecision
        schedule_start_date = row.ScheduleStartDate
        schedule_start_time = row.ScheduleStartTime
        schedule_end_date = row.ScheduleEndDate
        schedule_end_time = row.ScheduleEndTime
    |}

let load (source: NpgsqlDataSource) (MeetupId id) : Task<MeetupSnapshot option> =
    task {
        use! connection = source.OpenConnectionAsync()

        let! row =
            connection.QuerySingleOrDefaultAsync<MeetupRow.MeetupRow>(
                SelectSql,
                {|
                    id = id
                |}
            )

        return if isNull (box row) then None else Some(MeetupRow.toSnapshot row)
    }

/// Применение события и запись его результата — один неделимый шаг. Событие приходит
/// значением, а не option: команда, решившая «события нет», до записи не доходит
/// вовсе, и по типу видно, что успешный возврат означает записанную пару строк.
///
/// `expectedVersion` — версия, из которой принято решение, и приходит она с провода
/// (PER-78): её сравнивает предикат, потому что только сама база отвечает, осталась
/// ли строка той же. `None` бывает только у создания: там ключ идемпотентности —
/// идентификатор, а показанного снимка, из которого принимают решение, ещё нет.
let commit
    (source: NpgsqlDataSource)
    (envelope: EventEnvelope)
    (expectedVersion: int64 option)
    (state: MeetupState)
    (event: MeetupEvent)
    : Task<Result<MeetupSnapshot, VersionConflict>> =
    task {
        let snapshot = Meetup.apply state event |> Meetup.toSnapshot

        let row = MeetupRow.ofSnapshot snapshot
        let (PersonId performedBy) = envelope.PerformedBy

        use! connection = source.OpenConnectionAsync()
        use! transaction = connection.BeginTransactionAsync()

        let! affected =
            match state, expectedVersion with
            | Initial, None -> connection.ExecuteAsync(InsertMeetupSql, stateParameters row, transaction)
            | Existing _, Some version ->
                connection.ExecuteAsync(
                    UpdateMeetupSql,
                    {| stateParameters row with
                        expected_version = version
                    |},
                    transaction
                )
            // Версия предиката и состояние, из которого принято решение, — две
            // стороны одного факта. Разойтись они могут только дефектом оболочки,
            // поэтому исключение, а не отказ, который клиент должен читать.
            | Initial, Some _
            | Existing _, None -> invalidOp "the expected version does not match the state the event was decided from"

        if affected = 0 then
            // Строка не та, из которой принято решение: её либо уже изменил другой
            // писатель, либо она появилась между чтением и вставкой. Откат явный,
            // потому что успешную часть работы транзакция уже держит.
            do! transaction.RollbackAsync()
            return Error VersionConflict
        else
            let! _ =
                connection.ExecuteAsync(
                    InsertEventSql,
                    {|
                        event_id = envelope.EventId
                        meetup_id = row.Id
                        version = row.Version
                        event_type = MeetupEventPayload.eventType event
                        payload = MeetupEventPayload.ofSnapshot snapshot
                        performed_by = performedBy
                        occurred_at = envelope.OccurredAt
                    |},
                    transaction
                )

            do! transaction.CommitAsync()
            return Ok snapshot
    }
