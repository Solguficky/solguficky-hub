/// Вызов команд записи против настоящей базы и чтение того, что от них осталось.
/// Живёт в Infrastructure, а не рядом со сценариями: норматив требует, чтобы тело
/// теста читалось как бизнес-сценарий, а SQL и сборка зависимостей были спрятаны.
module Meetups.IntegrationTests.Infrastructure.MeetupCommands

open System
open System.Threading.Tasks
open Meetups.Domain
open Meetups.Infrastructure
open Npgsql

let author = PersonId(Guid.Parse "0199c0de-0000-7000-8000-00000000000a")
let otherAuthor = PersonId(Guid.Parse "0199c0de-0000-7000-8000-00000000000b")
let now = DateTimeOffset(2026, 9, 7, 12, 0, 0, TimeSpan.Zero)

/// Пишущие команды доступны администратору (ADR-031), поэтому вызов идёт от
/// смотрящего с ролью, а не от голой личности: без роли срез откажет раньше, чем
/// дойдёт до базы, и сценарий записи проверять станет нечего.
let administrator =
    {
        IdentityId = author
        Roles = Set.singleton Administrator
    }

let otherAdministrator =
    {
        IdentityId = otherAuthor
        Roles = Set.singleton Administrator
    }

let attributes =
    {
        Title = "F# after hours"
        Description = "Вертикальные срезы на живом коде"
        Venue = "Тбилиси, Fabrika"
        Kind = "Митап"
        CalendarLink = "https://calendar.example/fs"
    }

let source (dsn: string) = NpgsqlDataSource.Create dsn

let run (work: Task<'a>) = work |> Async.AwaitTask |> Async.RunSynchronously

let private read (dsn: string) (sql: string) (parameters: (string * obj) list) =
    use connection = new NpgsqlConnection(dsn)
    connection.Open()
    use command = new NpgsqlCommand(sql, connection)

    for name, value in parameters do
        command.Parameters.AddWithValue(name, value)
        |> ignore

    command.ExecuteScalar()

let private scalar<'T> (dsn: string) (sql: string) (parameters: (string * obj) list) = read dsn sql parameters :?> 'T

/// Зависимости собираются с фиксированными часами и идентификатором события: иначе
/// стабильность `event_id` было бы не с чем сравнивать, а конверт нельзя было бы
/// отличить от сгенерированного внутри SQL.
let createDeps (source: NpgsqlDataSource) (eventId: Guid) : Meetups.Slices.CreateMeetupDraft.Deps =
    {
        Load = MeetupStore.load source
        Commit = MeetupStore.commit source
        Now = fun () -> now
        NewEventId = fun () -> eventId
    }

let changeDeps (source: NpgsqlDataSource) (eventId: Guid) : Meetups.Slices.ChangeMeetupAttributes.Deps =
    {
        Load = MeetupStore.load source
        Commit = MeetupStore.commit source
        Now = fun () -> now
        NewEventId = fun () -> eventId
    }

let scheduleDeps (source: NpgsqlDataSource) (eventId: Guid) : Meetups.Slices.SetMeetupSchedule.Deps =
    {
        Load = MeetupStore.load source
        Commit = MeetupStore.commit source
        Now = fun () -> now
        NewEventId = fun () -> eventId
    }

let publishDeps (source: NpgsqlDataSource) (eventId: Guid) : Meetups.Slices.PublishMeetup.Deps =
    {
        Load = MeetupStore.load source
        Commit = MeetupStore.commit source
        Now = fun () -> now
        NewEventId = fun () -> eventId
    }

let create (source: NpgsqlDataSource) (eventId: Guid) (id: MeetupId) (performedBy: Viewer) =
    Meetups.Slices.CreateMeetupDraft.execute
        (createDeps source eventId)
        {
            Id = id
            Viewer = performedBy
        }
    |> run

let change (source: NpgsqlDataSource) (eventId: Guid) (id: MeetupId) =
    Meetups.Slices.ChangeMeetupAttributes.execute
        (changeDeps source eventId)
        {
            Id = id
            Viewer = administrator
            Attributes = attributes
        }
    |> run

let setSchedule (source: NpgsqlDataSource) (eventId: Guid) (id: MeetupId) (schedule: Schedule) =
    Meetups.Slices.SetMeetupSchedule.execute
        (scheduleDeps source eventId)
        {
            Id = id
            Viewer = administrator
            Schedule = schedule
        }
    |> run

let publish (source: NpgsqlDataSource) (eventId: Guid) (id: MeetupId) =
    Meetups.Slices.PublishMeetup.execute
        (publishDeps source eventId)
        {
            Id = id
            Viewer = administrator
        }
    |> run

/// Системная колонка приводится к тексту в запросе: сравнивать нужно факт
/// совпадения транзакций, а не разбирать тип xid на стороне клиента.
let transactionOf (dsn: string) (table: string) (column: string) (id: Guid) =
    scalar<string> dsn $"SELECT xmin::text FROM {table} WHERE {column} = @id" [ "id", box id ]

let countMeetups (dsn: string) (id: Guid) =
    scalar<int64> dsn "SELECT count(*) FROM meetups WHERE id = @id" [ "id", box id ]

let countEvents (dsn: string) (id: Guid) =
    scalar<int64> dsn "SELECT count(*) FROM meetup_events WHERE meetup_id = @id" [ "id", box id ]

let versionOf (dsn: string) (id: Guid) = scalar<int64> dsn "SELECT version FROM meetups WHERE id = @id" [ "id", box id ]

/// Число событий, чья версия обогнала версию состояния. Ноль означает, что обе
/// стороны транзакции говорят об одном и том же шаге агрегата.
let eventsAheadOfState (dsn: string) (id: Guid) =
    scalar<int64>
        dsn
        """
        SELECT count(*)
        FROM meetup_events e
        JOIN meetups m ON m.id = e.meetup_id
        WHERE e.meetup_id = @id AND e.version > m.version
        """
        [ "id", box id ]

/// Шесть колонок расписания как их видит база: тест сравнивает записанное с тем,
/// что домен считает тем же расписанием.
let scheduleOf (dsn: string) (id: Guid) =
    use connection = new NpgsqlConnection(dsn)
    connection.Open()

    use command =
        new NpgsqlCommand(
            """
            SELECT schedule_form, schedule_precision,
                   schedule_start_date, schedule_start_time,
                   schedule_end_date, schedule_end_time
            FROM meetups
            WHERE id = @id
            """,
            connection
        )

    command.Parameters.AddWithValue("id", id)
    |> ignore

    use reader = command.ExecuteReader()
    reader.Read() |> ignore

    let optional (index: int) (get: int -> 'T) : 'T option = if reader.IsDBNull index then None else Some(get index)

    reader.GetString 0,
    optional 1 reader.GetString,
    optional 2 reader.GetFieldValue<DateOnly>,
    optional 3 reader.GetFieldValue<TimeOnly>,
    optional 4 reader.GetFieldValue<DateOnly>,
    optional 5 reader.GetFieldValue<TimeOnly>

let journalIds (dsn: string) (id: Guid) =
    use connection = new NpgsqlConnection(dsn)
    connection.Open()

    use command =
        new NpgsqlCommand("SELECT event_id FROM meetup_events WHERE meetup_id = @id ORDER BY position", connection)

    command.Parameters.AddWithValue("id", id)
    |> ignore

    use reader = command.ExecuteReader()

    [
        while reader.Read() do
            reader.GetGuid 0
    ]

/// Async.RunSynchronously заворачивает отказ в AggregateException, поэтому предикат
/// SQLSTATE применяется к развёрнутой причине, а не к обёртке: иначе тест зеленел бы
/// на любом исключении одинаково.
let rec isUniqueViolation (ex: exn) =
    match ex with
    | :? AggregateException as aggregate ->
        aggregate.InnerExceptions
        |> Seq.exists isUniqueViolation
    | :? PostgresException as pg -> pg.SqlState = "23505"
    | _ ->
        not (isNull ex.InnerException)
        && isUniqueViolation ex.InnerException

let attempt (action: unit -> unit) =
    try
        action ()
        None
    with ex ->
        Some ex

let versionIn (result: Result<MeetupSnapshot, 'e>) =
    match result with
    | Ok snapshot -> Some snapshot.Version
    | Error _ -> None
