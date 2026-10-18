/// Колонка `material_id` журнала: заполнение старых строк миграцией, правило «id
/// есть ровно у поводов материала» и запись колонки командами. Всё это решает
/// PostgreSQL — SQL миграции, CHECK и триггер, — поэтому уровень интеграционный.
namespace Meetups.IntegrationTests.Scenarios

open System
open Meetups.Domain
open Meetups.IntegrationTests.Infrastructure
open Npgsql
open Swensen.Unquote
open Xunit

module private MaterialIdSql =
    let exec (dsn: string) (sql: string) (parameters: (string * obj) list) =
        use connection = new NpgsqlConnection(dsn)
        connection.Open()
        use command = new NpgsqlCommand(sql, connection)

        for name, value in parameters do
            command.Parameters.AddWithValue(name, value)
            |> ignore

        command.ExecuteNonQuery() |> ignore

    let failureCode (dsn: string) (sql: string) (parameters: (string * obj) list) =
        try
            exec dsn sql parameters
            None
        with :? PostgresException as ex ->
            Some ex.SqlState

    let materialIdOf (dsn: string) (eventId: Guid) : Guid option =
        use connection = new NpgsqlConnection(dsn)
        connection.Open()

        use command =
            new NpgsqlCommand("SELECT material_id FROM meetup_events WHERE event_id = @id", connection)

        command.Parameters.AddWithValue("id", eventId)
        |> ignore

        match command.ExecuteScalar() with
        | :? Guid as id -> Some id
        | _ -> None

    let actor = Guid.Parse "0199c0de-0000-7000-8000-00000000000a"
    let meetupId = Guid.Parse "0199c0de-0000-7000-8001-000000000001"
    let first = Guid.Parse "0199c0de-0000-7000-8002-000000000001"
    let second = Guid.Parse "0199c0de-0000-7000-8002-000000000002"
    let eventId (n: int) = Guid.Parse("0199c0de-0000-7000-8000-" + n.ToString "D12")

    /// Схема такой, какой её застаёт миграция 009 на существующем томе: все скрипты
    /// до неё уже применены. Скрипты идут напрямую, а не через `Migrations.apply`:
    /// без журнала DbUp тот прогнал бы и ранние скрипты повторно, а их перечисления
    /// поводов уже не знают строк, записанных позже, — на живом томе журнал есть, и
    /// выполняется одна 009.
    let private migrations (select: int -> bool) (dsn: string) =
        for migration in Meetups.Migrations.list () do
            if select migration.Version then
                exec dsn migration.Sql []

    let applyBefore009 = migrations (fun version -> version < 9)

    let apply009 = migrations (fun version -> version = 9)

    /// Строка журнала старой формы: без колонки `material_id`. Payload несёт только
    /// коллекцию — ровно то, по чему миграция восстанавливает повод.
    let insertOldEvent (dsn: string) (n: int) (version: int64) (eventType: string) (materials: Guid list) =
        let materialsJson =
            materials
            |> List.map (fun id -> $"{{\"id\":\"{id}\"}}")
            |> String.concat ","

        exec
            dsn
            $"""
            INSERT INTO meetup_events (
                event_id, meetup_id, version, event_type, payload, performed_by, occurred_at
            ) VALUES (
                @event_id, @meetup_id, @version, @event_type,
                '{{"materials":[{materialsJson}]}}'::jsonb, @actor, now()
            )
            """
            [
                "event_id", box (eventId n)
                "meetup_id", box meetupId
                "version", box version
                "event_type", box eventType
                "actor", box actor
            ]

type JournalMaterialIdTests() =

    /// Миграция не угадывает: каждое значение выведено из пары соседних снимков одной
    /// сходки, и удаление находит материал, которого в собственном снимке уже нет.
    [<Fact>]
    member _.``Rows written before the column get the material from their own history``() =
        use db = new IsolatedDatabase()
        let dsn = db.ConnectionString

        MaterialIdSql.applyBefore009 dsn

        MaterialIdSql.exec
            dsn
            """
            INSERT INTO meetups (id, author, lifecycle, visibility, version, schedule_form, schedule_precision)
            VALUES (@id, @actor, 'planned', 'hidden', 4, 'no_date', NULL)
            """
            [
                "id", box MaterialIdSql.meetupId
                "actor", box MaterialIdSql.actor
            ]

        MaterialIdSql.insertOldEvent dsn 1 1L "meetup_created" []
        MaterialIdSql.insertOldEvent dsn 2 2L "meetup_material_attached" [ MaterialIdSql.first ]

        MaterialIdSql.insertOldEvent
            dsn
            3
            3L
            "meetup_material_attached"
            [
                MaterialIdSql.first
                MaterialIdSql.second
            ]

        MaterialIdSql.insertOldEvent dsn 4 4L "meetup_material_removed" [ MaterialIdSql.second ]

        MaterialIdSql.apply009 dsn

        test
            <@
                [ 1; 2; 3; 4 ]
                |> List.map (
                    MaterialIdSql.eventId
                    >> MaterialIdSql.materialIdOf dsn
                ) = [
                    None
                    Some MaterialIdSql.first
                    Some MaterialIdSql.second
                    Some MaterialIdSql.first
                ]
            @>

    [<Fact>]
    member _.``A material occasion cannot be journaled without its material``() =
        use db = SchemaSql.applyIsolated ()

        let code =
            MaterialIdSql.failureCode
                db.ConnectionString
                """
                INSERT INTO meetups (id, author, lifecycle, visibility, version, schedule_form, schedule_precision)
                VALUES (@id, @actor, 'planned', 'hidden', 2, 'no_date', NULL);
                INSERT INTO meetup_events (event_id, meetup_id, version, event_type, payload, performed_by, occurred_at)
                VALUES (@event_id, @id, 2, 'meetup_material_removed', '{}'::jsonb, @actor, now());
                """
                [
                    "id", box MaterialIdSql.meetupId
                    "actor", box MaterialIdSql.actor
                    "event_id", box (MaterialIdSql.eventId 5)
                ]

        test <@ code = Some PostgresErrorCodes.CheckViolation @>

    [<Fact>]
    member _.``Any other occasion cannot carry a material``() =
        use db = SchemaSql.applyIsolated ()

        let code =
            MaterialIdSql.failureCode
                db.ConnectionString
                """
                INSERT INTO meetups (id, author, lifecycle, visibility, version, schedule_form, schedule_precision)
                VALUES (@id, @actor, 'planned', 'hidden', 1, 'no_date', NULL);
                INSERT INTO meetup_events (
                    event_id, meetup_id, version, event_type, payload, performed_by, occurred_at, material_id
                ) VALUES (@event_id, @id, 1, 'meetup_created', '{}'::jsonb, @actor, now(), @material);
                """
                [
                    "id", box MaterialIdSql.meetupId
                    "actor", box MaterialIdSql.actor
                    "event_id", box (MaterialIdSql.eventId 6)
                    "material", box MaterialIdSql.first
                ]

        test <@ code = Some PostgresErrorCodes.CheckViolation @>

    /// Колонка — часть записи события, а не подвижная отметка: триггер обязан её
    /// перечислять, иначе повод можно было бы переписать задним числом.
    [<Fact>]
    member _.``The material of a journaled event cannot be rewritten``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn
        let id = MeetupId MaterialIdSql.meetupId

        MeetupCommands.create source (MaterialIdSql.eventId 7) id MeetupCommands.administrator
        |> ignore

        MeetupCommands.attach
            source
            (MaterialIdSql.eventId 8)
            id
            (MaterialId MaterialIdSql.first)
            "Слайды"
            (MessageLink "https://t.me/solguficky/42")
        |> ignore

        let code =
            MaterialIdSql.failureCode
                dsn
                "UPDATE meetup_events SET material_id = @other WHERE event_id = @id"
                [
                    "other", box MaterialIdSql.second
                    "id", box (MaterialIdSql.eventId 8)
                ]

        test <@ code = Some "MT001" @>

    [<Fact>]
    member _.``Attaching and removing a material journal the material with the event``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn
        let id = MeetupId MaterialIdSql.meetupId

        MeetupCommands.create source (MaterialIdSql.eventId 9) id MeetupCommands.administrator
        |> ignore

        MeetupCommands.attach
            source
            (MaterialIdSql.eventId 10)
            id
            (MaterialId MaterialIdSql.first)
            "Слайды"
            (MessageLink "https://t.me/solguficky/42")
        |> ignore

        MeetupCommands.remove source (MaterialIdSql.eventId 11) id (MaterialId MaterialIdSql.first)
        |> ignore

        test
            <@
                [ 9; 10; 11 ]
                |> List.map (
                    MaterialIdSql.eventId
                    >> MaterialIdSql.materialIdOf dsn
                ) = [
                    None
                    Some MaterialIdSql.first
                    Some MaterialIdSql.first
                ]
            @>
