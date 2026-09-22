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

let unpublishDeps (source: NpgsqlDataSource) (eventId: Guid) : Meetups.Slices.UnpublishMeetup.Deps =
    {
        Load = MeetupStore.load source
        Commit = MeetupStore.commit source
        Now = fun () -> now
        NewEventId = fun () -> eventId
    }

let cancelDeps (source: NpgsqlDataSource) (eventId: Guid) : Meetups.Slices.CancelMeetup.Deps =
    {
        Load = MeetupStore.load source
        Commit = MeetupStore.commit source
        Now = fun () -> now
        NewEventId = fun () -> eventId
    }

let markHeldDeps (source: NpgsqlDataSource) (eventId: Guid) : Meetups.Slices.MarkMeetupHeld.Deps =
    {
        Load = MeetupStore.load source
        Commit = MeetupStore.commit source
        Now = fun () -> now
        NewEventId = fun () -> eventId
    }

/// Пояс сообщества — та же конфигурация, что подставляет AppHost: 19:00 в Москве
/// становится 16:00 UTC, и сценарий проверяет интерпретацию, а не константу.
let schedulePublicationDeps (source: NpgsqlDataSource) (eventId: Guid) : Meetups.Slices.ScheduleMeetupPublication.Deps =
    {
        Load = MeetupStore.load source
        Commit = MeetupStore.commit source
        Now = fun () -> now
        NewEventId = fun () -> eventId
        CommunityTimeZone = TimeZoneInfo.FindSystemTimeZoneById "Europe/Moscow"
    }

let cancelPublicationDeps (source: NpgsqlDataSource) (eventId: Guid) : Meetups.Slices.CancelMeetupPublication.Deps =
    {
        Load = MeetupStore.load source
        Commit = MeetupStore.commit source
        Now = fun () -> now
        NewEventId = fun () -> eventId
    }

/// Локальная пара для команды назначения: минута — предел точности, который несёт
/// значение, поэтому секунды тесту недоступны по построению.
let localMoment year month day hours minutes : LocalDateTime =
    {
        Date = DateOnly(year, month, day)
        Time =
            LocalTime.create (TimeOnly(hours, minutes))
            |> Result.defaultWith (fun _ -> failwith "the test time is more precise than a minute")
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

let unpublish (source: NpgsqlDataSource) (eventId: Guid) (id: MeetupId) =
    Meetups.Slices.UnpublishMeetup.execute
        (unpublishDeps source eventId)
        {
            Id = id
            Viewer = administrator
        }
    |> run

let cancel (source: NpgsqlDataSource) (eventId: Guid) (id: MeetupId) =
    Meetups.Slices.CancelMeetup.execute
        (cancelDeps source eventId)
        {
            Id = id
            Viewer = administrator
        }
    |> run

/// Материалы среза: идентификаторы задаются тестом, потому что их генерирует
/// вызывающая сторона, и идемпотентность повтора проверяется именно на них.
let materialId = MaterialId(Guid.Parse "0199c0de-0000-7000-8000-0000000000a1")
let otherMaterialId = MaterialId(Guid.Parse "0199c0de-0000-7000-8000-0000000000a2")

let attachDeps (source: NpgsqlDataSource) (eventId: Guid) : Meetups.Slices.AttachMaterial.Deps =
    {
        Load = MeetupStore.load source
        Commit = MeetupStore.commit source
        Now = fun () -> now
        NewEventId = fun () -> eventId
    }

let removeDeps (source: NpgsqlDataSource) (eventId: Guid) : Meetups.Slices.RemoveMaterial.Deps =
    {
        Load = MeetupStore.load source
        Commit = MeetupStore.commit source
        Now = fun () -> now
        NewEventId = fun () -> eventId
    }

let attach
    (source: NpgsqlDataSource)
    (eventId: Guid)
    (id: MeetupId)
    (material: MaterialId)
    (title: string)
    (materialSource: MaterialSource)
    =
    Meetups.Slices.AttachMaterial.execute
        (attachDeps source eventId)
        {
            Id = id
            MaterialId = material
            Title = title
            Source = materialSource
            Viewer = administrator
        }
    |> run

let remove (source: NpgsqlDataSource) (eventId: Guid) (id: MeetupId) (material: MaterialId) =
    Meetups.Slices.RemoveMaterial.execute
        (removeDeps source eventId)
        {
            Id = id
            MaterialId = material
            Viewer = administrator
        }
    |> run

let markHeld (source: NpgsqlDataSource) (eventId: Guid) (id: MeetupId) =
    Meetups.Slices.MarkMeetupHeld.execute
        (markHeldDeps source eventId)
        {
            Id = id
            Viewer = administrator
        }
    |> run

let schedulePublication (source: NpgsqlDataSource) (eventId: Guid) (id: MeetupId) (moment: LocalDateTime) =
    Meetups.Slices.ScheduleMeetupPublication.execute
        (schedulePublicationDeps source eventId)
        {
            Id = id
            Viewer = administrator
            Moment = moment
        }
    |> run

let cancelPublication (source: NpgsqlDataSource) (eventId: Guid) (id: MeetupId) =
    Meetups.Slices.CancelMeetupPublication.execute
        (cancelPublicationDeps source eventId)
        {
            Id = id
            Viewer = administrator
        }
    |> run

/// День сообщества: списки отделяют архив от актуального по нему, и сценарий,
/// записанный фиксированной датой, позеленел бы сегодня и покраснел после неё.
/// Пояс — тот же, что получает хост под тестом.
let communityToday () =
    TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, Meetups.Infrastructure.CommunityTime.zone "Europe/Moscow").DateTime
    |> DateOnly.FromDateTime

/// Системная колонка приводится к тексту в запросе: сравнивать нужно факт
/// совпадения транзакций, а не разбирать тип xid на стороне клиента.
let transactionOf (dsn: string) (table: string) (column: string) (id: Guid) =
    scalar<string> dsn $"SELECT xmin::text FROM {table} WHERE {column} = @id" [ "id", box id ]

/// Транзакция конкретной строки журнала: у сходки событий несколько, и «любое из
/// них» здесь не утверждение.
let eventTransactionOf (dsn: string) (eventId: Guid) =
    scalar<string> dsn "SELECT xmin::text FROM meetup_events WHERE event_id = @id" [ "id", box eventId ]

/// Транзакция последней записи журнала. Нужна командам, после которых у сходки
/// накопились события: сравнить с состоянием можно только ту строку, которую
/// записала та же команда.
let lastEventTransactionOf (dsn: string) (id: Guid) =
    scalar<string>
        dsn
        """
        SELECT xmin::text
        FROM meetup_events
        WHERE meetup_id = @id
        ORDER BY position DESC
        LIMIT 1
        """
        [ "id", box id ]

let countMeetups (dsn: string) (id: Guid) =
    scalar<int64> dsn "SELECT count(*) FROM meetups WHERE id = @id" [ "id", box id ]

let countEvents (dsn: string) (id: Guid) =
    scalar<int64> dsn "SELECT count(*) FROM meetup_events WHERE meetup_id = @id" [ "id", box id ]

let versionOf (dsn: string) (id: Guid) = scalar<int64> dsn "SELECT version FROM meetups WHERE id = @id" [ "id", box id ]

let visibilityOf (dsn: string) (id: Guid) =
    scalar<string> dsn "SELECT visibility FROM meetups WHERE id = @id" [ "id", box id ]

/// Заполнен ли момент отложенной публикации в самой строке состояния. Снимок
/// теперь несёт то же поле, но проверять его очистку уместно там, где живёт
/// ограничение схемы: у видимой и у отменённой строки момента быть не может.
let scheduledPublicationIsSet (dsn: string) (id: Guid) =
    scalar<bool> dsn "SELECT scheduled_publish_at IS NOT NULL FROM meetups WHERE id = @id" [ "id", box id ]

/// Момент отложенной публикации как его видит база. Npgsql отдаёт timestamptz
/// значением DateTime, поэтому вид UTC называется явно, а не угадывается.
let scheduledPublicationAt (dsn: string) (id: Guid) =
    let value =
        read dsn "SELECT scheduled_publish_at FROM meetups WHERE id = @id" [ "id", box id ]

    if isNull value then None else Some(DateTimeOffset(DateTime.SpecifyKind(unbox<DateTime> value, DateTimeKind.Utc)))

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

/// Поводы журнала в порядке записи. Имя повода принимает не код, а CHECK-ограничение
/// `meetup_events_type_check`: строка с незнакомым именем не запишется вовсе, и
/// подтвердить, что миграции 004 и 005 их добавили, может только настоящая база.
let eventTypes (dsn: string) (id: Guid) =
    use connection = new NpgsqlConnection(dsn)
    connection.Open()

    use command =
        new NpgsqlCommand("SELECT event_type FROM meetup_events WHERE meetup_id = @id ORDER BY position", connection)

    command.Parameters.AddWithValue("id", id)
    |> ignore

    use reader = command.ExecuteReader()

    [
        while reader.Read() do
            reader.GetString 0
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
