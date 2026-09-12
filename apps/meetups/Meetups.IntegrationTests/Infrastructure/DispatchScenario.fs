namespace Meetups.IntegrationTests.Infrastructure

open System
open Npgsql

module private DispatchSql =
    let actor = Guid.Parse("0199c0de-0000-7000-8000-00000000000a")
    let occurredAt = DateTimeOffset.Parse("2026-09-07T12:00:00Z")
    let dispatchedAt = DateTimeOffset.Parse("2026-09-07T12:01:00Z")

    let command
        (connection: NpgsqlConnection)
        (transaction: NpgsqlTransaction option)
        (sql: string)
        (parameters: (string * obj) list)
        =
        let command =
            match transaction with
            | Some value -> new NpgsqlCommand(sql, connection, value)
            | None -> new NpgsqlCommand(sql, connection)

        for name, value in parameters do
            command.Parameters.AddWithValue(name, value)
            |> ignore

        command

    let queryIds (dsn: string) (sql: string) (parameters: (string * obj) list) =
        use connection = new NpgsqlConnection(dsn)
        connection.Open()
        use command = command connection None sql parameters
        use reader = command.ExecuteReader()

        [
            while reader.Read() do
                reader.GetGuid(0)
        ]

    /// Возвращает SQLSTATE, а не факт отказа: `MT001`, `MT002` и `23514` нужно
    /// различать, иначе проверка неизменяемости проходила бы на любой другой
    /// ошибке схемы — ровно то, чем плох общий код отказа.
    let failureCode (dsn: string) (sql: string) (parameters: (string * obj) list) =
        use connection = new NpgsqlConnection(dsn)
        connection.Open()
        use command = command connection None sql parameters

        try
            command.ExecuteNonQuery() |> ignore
            None
        with :? PostgresException as ex ->
            Some ex.SqlState

/// Командная транзакция среза: состояние и событие пишутся вместе, поэтому
/// откат и конкурентный коммит нельзя собрать из отдельных вставок.
type CommandTransaction(dsn: string) =
    let connection = new NpgsqlConnection(dsn)

    do connection.Open()

    let transaction = connection.BeginTransaction()

    member _.Insert(meetupId: Guid, eventId: Guid) =
        use state =
            DispatchSql.command
                connection
                (Some transaction)
                """
                INSERT INTO meetups (
                    id, author, lifecycle, visibility, version,
                    schedule_form, schedule_precision
                ) VALUES (
                    @meetup_id, @actor, 'planned', 'hidden', 1,
                    'no_date', NULL
                )
                """
                [
                    "meetup_id", box meetupId
                    "actor", box DispatchSql.actor
                ]

        state.ExecuteNonQuery() |> ignore

        use journal =
            DispatchSql.command
                connection
                (Some transaction)
                """
                INSERT INTO meetup_events (
                    event_id, meetup_id, version, event_type, payload, performed_by, occurred_at
                ) VALUES (
                    @event_id, @meetup_id, 1, 'meetup_created', '{}'::jsonb, @actor, @occurred_at
                )
                RETURNING position
                """
                [
                    "event_id", box eventId
                    "meetup_id", box meetupId
                    "actor", box DispatchSql.actor
                    "occurred_at", box DispatchSql.occurredAt
                ]

        journal.ExecuteScalar() :?> int64

    member _.Commit() = transaction.Commit()

    interface IDisposable with
        member _.Dispose() =
            transaction.Dispose()
            connection.Dispose()

module DispatchScenario =
    let dispatchedAt = DispatchSql.dispatchedAt

    let markPendingDispatched (dsn: string) =
        DispatchSql.queryIds
            dsn
            """
            UPDATE meetup_events
            SET dispatched_at = @dispatched_at
            WHERE dispatched_at IS NULL
            RETURNING event_id
            """
            [
                "dispatched_at", box DispatchSql.dispatchedAt
            ]

    /// Что увидел бы читатель с high-water mark по `position`: всё, что старше
    /// прочитанной позиции, для него больше не существует.
    let eventsAfter (dsn: string) (position: int64) =
        DispatchSql.queryIds
            dsn
            "SELECT event_id FROM meetup_events WHERE position > @position ORDER BY position"
            [ "position", box position ]

    let pendingEvents (dsn: string) =
        DispatchSql.queryIds dsn "SELECT event_id FROM meetup_events WHERE dispatched_at IS NULL ORDER BY position" []

    let recordUpdateCode (dsn: string) (eventId: Guid) =
        DispatchSql.failureCode
            dsn
            "UPDATE meetup_events SET payload = '{\"changed\":true}'::jsonb WHERE event_id = @event_id"
            [ "event_id", box eventId ]

    let rowDeleteCode (dsn: string) (eventId: Guid) =
        DispatchSql.failureCode dsn "DELETE FROM meetup_events WHERE event_id = @event_id" [ "event_id", box eventId ]

    /// TRUNCATE не проходит через строчный триггер, поэтому запрет на него
    /// держит отдельный statement-триггер, и проверять его надо отдельно.
    let tableTruncateCode (dsn: string) = DispatchSql.failureCode dsn "TRUNCATE meetup_events" []

    /// Настоящее нарушение CHECK рядом с отказами триггера: без него «историю
    /// переписать нельзя» и «строка не прошла ограничение» выглядели бы для
    /// адаптера команд одним и тем же кодом.
    let checkViolationCode (dsn: string) (meetupId: Guid) (eventId: Guid) =
        DispatchSql.failureCode
            dsn
            """
            INSERT INTO meetup_events (
                event_id, meetup_id, version, event_type, payload, performed_by, occurred_at
            ) VALUES (
                @event_id, @meetup_id, 2, 'meetup_changed', '[1]'::jsonb, @actor, @occurred_at
            )
            """
            [
                "event_id", box eventId
                "meetup_id", box meetupId
                "actor", box DispatchSql.actor
                "occurred_at", box DispatchSql.occurredAt
            ]

    let readRecord (dsn: string) (eventId: Guid) =
        use connection = new NpgsqlConnection(dsn)
        connection.Open()

        use command =
            DispatchSql.command
                connection
                None
                """
                SELECT meetup_id, version, event_type, payload::text, performed_by, occurred_at
                FROM meetup_events
                WHERE event_id = @event_id
                """
                [ "event_id", box eventId ]

        use reader = command.ExecuteReader()
        reader.Read() |> ignore

        (reader.GetGuid(0),
         reader.GetInt32(1),
         reader.GetString(2),
         reader.GetString(3),
         reader.GetGuid(4),
         reader.GetFieldValue<DateTimeOffset>(5))

    let readDispatchMark (dsn: string) (eventId: Guid) =
        use connection = new NpgsqlConnection(dsn)
        connection.Open()

        use command =
            DispatchSql.command
                connection
                None
                "SELECT dispatched_at FROM meetup_events WHERE event_id = @event_id"
                [ "event_id", box eventId ]

        use reader = command.ExecuteReader()
        reader.Read() |> ignore

        if reader.IsDBNull(0) then None else Some(reader.GetFieldValue<DateTimeOffset>(0))

    let recordCounts (dsn: string) (meetupId: Guid) (eventId: Guid) =
        use connection = new NpgsqlConnection(dsn)
        connection.Open()

        use command =
            DispatchSql.command
                connection
                None
                """
                SELECT
                    (SELECT COUNT(*) FROM meetups WHERE id = @meetup_id),
                    (SELECT COUNT(*) FROM meetup_events WHERE event_id = @event_id)
                """
                [
                    "meetup_id", box meetupId
                    "event_id", box eventId
                ]

        use reader = command.ExecuteReader()
        reader.Read() |> ignore
        (reader.GetInt64(0), reader.GetInt64(1))
