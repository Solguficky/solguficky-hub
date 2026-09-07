namespace Meetups.IntegrationTests.Infrastructure

open System
open Npgsql

module private OutboxSql =
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

type OutboxTransaction(dsn: string) =
    let connection = new NpgsqlConnection(dsn)

    do connection.Open()

    let transaction = connection.BeginTransaction()

    member _.Insert(meetupId: Guid, eventId: Guid) =
        use state =
            OutboxSql.command
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
                    "actor", box OutboxSql.actor
                ]

        state.ExecuteNonQuery() |> ignore

        use journal =
            OutboxSql.command
                connection
                (Some transaction)
                """
                INSERT INTO meetup_events (
                    event_id, meetup_id, version, event_type, payload, performed_by, occurred_at
                ) VALUES (
                    @event_id, @meetup_id, 1, 'meetup_created', '{}'::jsonb, @actor, @occurred_at
                )
                """
                [
                    "event_id", box eventId
                    "meetup_id", box meetupId
                    "actor", box OutboxSql.actor
                    "occurred_at", box OutboxSql.occurredAt
                ]

        journal.ExecuteNonQuery() |> ignore

        use outbox =
            OutboxSql.command
                connection
                (Some transaction)
                "INSERT INTO meetup_outbox (event_id) VALUES (@event_id) RETURNING position"
                [ "event_id", box eventId ]

        outbox.ExecuteScalar() :?> int64

    member _.Commit() = transaction.Commit()

    interface IDisposable with
        member _.Dispose() =
            transaction.Dispose()
            connection.Dispose()

module OutboxScenario =
    let dispatchVisiblePending (dsn: string) =
        OutboxSql.queryIds
            dsn
            """
            UPDATE meetup_outbox
            SET dispatched_at = @dispatched_at
            WHERE dispatched_at IS NULL
            RETURNING event_id
            """
            [
                "dispatched_at", box OutboxSql.dispatchedAt
            ]

    let eventsAfter (dsn: string) (position: int64) =
        OutboxSql.queryIds
            dsn
            "SELECT event_id FROM meetup_outbox WHERE position > @position ORDER BY position"
            [ "position", box position ]

    let pendingEvents (dsn: string) =
        OutboxSql.queryIds dsn "SELECT event_id FROM meetup_outbox WHERE dispatched_at IS NULL ORDER BY position" []

    let insertMismatchedRecord (dsn: string) (eventId: Guid) (attemptedMeetupId: Guid) =
        use connection = new NpgsqlConnection(dsn)
        connection.Open()

        use insert =
            OutboxSql.command
                connection
                None
                """
                INSERT INTO meetup_outbox (
                    event_id, meetup_id, version, event_type, payload, performed_by, occurred_at
                ) VALUES (
                    @event_id, @meetup_id, 99, 'meetup_changed', '{"mismatch":true}'::jsonb,
                    @performed_by, @occurred_at
                )
                """
                [
                    "event_id", box eventId
                    "meetup_id", box attemptedMeetupId
                    "performed_by", box (Guid.Parse("0199c0de-0000-7000-8000-00000000000b"))
                    "occurred_at", box (DateTimeOffset.Parse("2026-09-08T12:00:00Z"))
                ]

        insert.ExecuteNonQuery() |> ignore

        use read =
            new NpgsqlCommand(
                """
                SELECT meetup_id, version, event_type, payload::text, performed_by, occurred_at
                FROM meetup_outbox
                WHERE event_id = @event_id
                """,
                connection
            )

        read.Parameters.AddWithValue("event_id", eventId)
        |> ignore

        use reader = read.ExecuteReader()
        reader.Read() |> ignore

        (reader.GetGuid(0),
         reader.GetInt32(1),
         reader.GetString(2),
         reader.GetString(3),
         reader.GetGuid(4),
         reader.GetFieldValue<DateTimeOffset>(5))

    let journalRecordIsImmutable (dsn: string) (eventId: Guid) =
        use connection = new NpgsqlConnection(dsn)
        connection.Open()

        use command =
            OutboxSql.command
                connection
                None
                "UPDATE meetup_events SET payload = '{\"changed\":true}'::jsonb WHERE event_id = @event_id"
                [ "event_id", box eventId ]

        try
            command.ExecuteNonQuery() |> ignore
            false
        with :? PostgresException as ex when ex.SqlState = "23514" ->
            true

    let recordCounts (dsn: string) (meetupId: Guid) (eventId: Guid) =
        use connection = new NpgsqlConnection(dsn)
        connection.Open()

        use command =
            OutboxSql.command
                connection
                None
                """
                SELECT
                    (SELECT COUNT(*) FROM meetups WHERE id = @meetup_id),
                    (SELECT COUNT(*) FROM meetup_events WHERE event_id = @event_id),
                    (SELECT COUNT(*) FROM meetup_outbox WHERE event_id = @event_id)
                """
                [
                    "meetup_id", box meetupId
                    "event_id", box eventId
                ]

        use reader = command.ExecuteReader()
        reader.Read() |> ignore
        (reader.GetInt64(0), reader.GetInt64(1), reader.GetInt64(2))
