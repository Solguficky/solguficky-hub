namespace Meetups.IntegrationTests.Scenarios

open System
open Meetups.IntegrationTests.Infrastructure
open Npgsql
open Swensen.Unquote
open Xunit

module SchemaSql =
    let absent: obj = DBNull.Value

    let applyIsolated () =
        let db = new IsolatedDatabase()

        try
            Meetups.Migrations.apply db.ConnectionString
            db
        with _ ->
            (db :> IDisposable).Dispose()
            reraise ()

    let exec (dsn: string) (sql: string) (parameters: (string * obj) list) =
        use conn = new NpgsqlConnection(dsn)
        conn.Open()
        use command = new NpgsqlCommand(sql, conn)

        for name, value in parameters do
            command.Parameters.AddWithValue(name, value)
            |> ignore

        command.ExecuteNonQuery() |> ignore

    let scalar<'T> (dsn: string) (sql: string) (parameters: (string * obj) list) =
        use conn = new NpgsqlConnection(dsn)
        conn.Open()
        use command = new NpgsqlCommand(sql, conn)

        for name, value in parameters do
            command.Parameters.AddWithValue(name, value)
            |> ignore

        command.ExecuteScalar() :?> 'T

    let queryIds (dsn: string) (sql: string) (parameters: (string * obj) list) =
        use conn = new NpgsqlConnection(dsn)
        conn.Open()
        use command = new NpgsqlCommand(sql, conn)

        for name, value in parameters do
            command.Parameters.AddWithValue(name, value)
            |> ignore

        use reader = command.ExecuteReader()

        [
            while reader.Read() do
                reader.GetGuid(0)
        ]

    let isCheckViolation (ex: exn) =
        match ex with
        | :? PostgresException as pg -> pg.SqlState = "23514"
        | _ -> false

    let isUniqueViolation (ex: exn) =
        match ex with
        | :? PostgresException as pg -> pg.SqlState = "23505"
        | _ -> false

    let insertMeetup
        (dsn: string)
        (id: Guid)
        (visibility: string)
        (firstPublishedAt: obj)
        (scheduledPublishAt: obj)
        (form: string)
        (precision: obj)
        (startDate: obj)
        (startTime: obj)
        (endDate: obj)
        (endTime: obj)
        =
        exec
            dsn
            """
            INSERT INTO meetups (
                id, author, lifecycle, visibility, version,
                first_published_at, scheduled_publish_at,
                schedule_form, schedule_precision,
                schedule_start_date, schedule_start_time,
                schedule_end_date, schedule_end_time
            ) VALUES (
                @id, @author, 'planned', @visibility, 1,
                @first_published_at, @scheduled_publish_at,
                @form, @precision,
                @start_date, @start_time,
                @end_date, @end_time
            )
            """
            [
                "id", box id
                "author", box (Guid.Parse("0199c0de-0000-7000-8000-00000000000a"))
                "visibility", box visibility
                "first_published_at", firstPublishedAt
                "scheduled_publish_at", scheduledPublishAt
                "form", box form
                "precision", precision
                "start_date", startDate
                "start_time", startTime
                "end_date", endDate
                "end_time", endTime
            ]

    let insertNoDate (dsn: string) (id: Guid) (visibility: string) (firstPublishedAt: obj) (scheduledPublishAt: obj) =
        insertMeetup dsn id visibility firstPublishedAt scheduledPublishAt "no_date" absent absent absent absent absent

    let insertEvent (dsn: string) (eventId: Guid) (meetupId: Guid) (version: int) (eventType: string) =
        exec
            dsn
            """
            INSERT INTO meetup_events (
                event_id, meetup_id, version, event_type, payload, performed_by, occurred_at
            ) VALUES (
                @event_id, @meetup_id, @version, @event_type, '{}'::jsonb, @performed_by, @occurred_at
            )
            """
            [
                "event_id", box eventId
                "meetup_id", box meetupId
                "version", box version
                "event_type", box eventType
                "performed_by", box (Guid.Parse("0199c0de-0000-7000-8000-00000000000a"))
                "occurred_at", box (DateTimeOffset.Parse("2026-09-06T12:00:00Z"))
            ]

type SchemaTests() =
    [<Fact>]
    member _.``Apply succeeds twice on a clean database``() =
        use db = SchemaSql.applyIsolated ()
        Meetups.Migrations.apply db.ConnectionString

        let count =
            SchemaSql.scalar<int64> db.ConnectionString "SELECT COUNT(*) FROM meetups_schema_versions" []

        test <@ count = 1L @>

    [<Fact>]
    member _.``Schema SQL is idempotent without the journal``() =
        use db = SchemaSql.applyIsolated ()
        SchemaSql.exec db.ConnectionString "DELETE FROM meetups_schema_versions" []
        Meetups.Migrations.apply db.ConnectionString

        let tables =
            SchemaSql.scalar<int64>
                db.ConnectionString
                """
                SELECT COUNT(*) FROM information_schema.tables
                WHERE table_schema = 'public'
                  AND table_name IN ('meetups', 'meetup_events')
                """
                []

        let journal =
            SchemaSql.scalar<int64> db.ConnectionString "SELECT COUNT(*) FROM meetups_schema_versions" []

        test <@ tables = 2L && journal = 1L @>

    [<Fact>]
    member _.``Concurrent apply finishes without error``() =
        use db = new IsolatedDatabase()

        [|
            async { Meetups.Migrations.apply db.ConnectionString }
            async { Meetups.Migrations.apply db.ConnectionString }
        |]
        |> Async.Parallel
        |> Async.RunSynchronously
        |> ignore

        let count =
            SchemaSql.scalar<int64> db.ConnectionString "SELECT COUNT(*) FROM meetups_schema_versions" []

        test <@ count = 1L @>

    [<Fact>]
    member _.``A day schedule cannot carry a start time``() =
        use db = SchemaSql.applyIsolated ()

        let thrown =
            try
                SchemaSql.insertMeetup
                    db.ConnectionString
                    (Guid.Parse("0199c0de-0000-7000-8000-000000000001"))
                    "hidden"
                    SchemaSql.absent
                    SchemaSql.absent
                    "fixed"
                    "day"
                    (DateOnly.Parse("2026-09-06"))
                    (TimeOnly.Parse("18:00"))
                    SchemaSql.absent
                    SchemaSql.absent

                None
            with ex ->
                Some ex

        test <@ thrown |> Option.exists SchemaSql.isCheckViolation @>

    [<Fact>]
    member _.``An interval cannot end before it starts``() =
        use db = SchemaSql.applyIsolated ()

        let thrown =
            try
                SchemaSql.insertMeetup
                    db.ConnectionString
                    (Guid.Parse("0199c0de-0000-7000-8000-000000000002"))
                    "hidden"
                    SchemaSql.absent
                    SchemaSql.absent
                    "fixed"
                    "interval"
                    (DateOnly.Parse("2026-09-06"))
                    (TimeOnly.Parse("20:00"))
                    (DateOnly.Parse("2026-09-06"))
                    (TimeOnly.Parse("18:00"))

                None
            with ex ->
                Some ex

        test <@ thrown |> Option.exists SchemaSql.isCheckViolation @>

    [<Fact>]
    member _.``An interval cannot drop the end time``() =
        use db = SchemaSql.applyIsolated ()

        let thrown =
            try
                SchemaSql.insertMeetup
                    db.ConnectionString
                    (Guid.Parse("0199c0de-0000-7000-8000-000000000003"))
                    "hidden"
                    SchemaSql.absent
                    SchemaSql.absent
                    "tentative"
                    "interval"
                    (DateOnly.Parse("2026-09-06"))
                    (TimeOnly.Parse("18:00"))
                    (DateOnly.Parse("2026-09-06"))
                    SchemaSql.absent

                None
            with ex ->
                Some ex

        test <@ thrown |> Option.exists SchemaSql.isCheckViolation @>

    [<Fact>]
    member _.``A no-date schedule cannot carry a calendar date``() =
        use db = SchemaSql.applyIsolated ()

        let thrown =
            try
                SchemaSql.insertMeetup
                    db.ConnectionString
                    (Guid.Parse("0199c0de-0000-7000-8000-000000000004"))
                    "hidden"
                    SchemaSql.absent
                    SchemaSql.absent
                    "no_date"
                    SchemaSql.absent
                    (DateOnly.Parse("2026-09-06"))
                    SchemaSql.absent
                    SchemaSql.absent
                    SchemaSql.absent

                None
            with ex ->
                Some ex

        test <@ thrown |> Option.exists SchemaSql.isCheckViolation @>

    [<Fact>]
    member _.``Every accepted schedule form can be stored``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString

        SchemaSql.insertNoDate
            dsn
            (Guid.Parse("0199c0de-0000-7000-8000-000000000010"))
            "hidden"
            SchemaSql.absent
            SchemaSql.absent

        SchemaSql.insertMeetup
            dsn
            (Guid.Parse("0199c0de-0000-7000-8000-000000000011"))
            "hidden"
            SchemaSql.absent
            SchemaSql.absent
            "tentative"
            "day"
            (DateOnly.Parse("2026-09-07"))
            SchemaSql.absent
            SchemaSql.absent
            SchemaSql.absent

        SchemaSql.insertMeetup
            dsn
            (Guid.Parse("0199c0de-0000-7000-8000-000000000012"))
            "hidden"
            SchemaSql.absent
            SchemaSql.absent
            "fixed"
            "day_start"
            (DateOnly.Parse("2026-09-08"))
            (TimeOnly.Parse("19:30"))
            SchemaSql.absent
            SchemaSql.absent

        SchemaSql.insertMeetup
            dsn
            (Guid.Parse("0199c0de-0000-7000-8000-000000000013"))
            "visible"
            (DateTimeOffset.Parse("2026-09-01T10:00:00Z"))
            SchemaSql.absent
            "fixed"
            "interval"
            (DateOnly.Parse("2026-09-09"))
            (TimeOnly.Parse("18:00"))
            (DateOnly.Parse("2026-09-09"))
            (TimeOnly.Parse("22:00"))

        let count = SchemaSql.scalar<int64> dsn "SELECT COUNT(*) FROM meetups" []
        test <@ count = 4L @>

    [<Fact>]
    member _.``Hidden drafts and unpublished meetups are distinct in a query``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        let draft = Guid.Parse("0199c0de-0000-7000-8000-000000000021")
        let unpublished = Guid.Parse("0199c0de-0000-7000-8000-000000000022")

        SchemaSql.insertNoDate dsn draft "hidden" SchemaSql.absent SchemaSql.absent

        SchemaSql.insertNoDate dsn unpublished "hidden" (DateTimeOffset.Parse("2026-09-01T10:00:00Z")) SchemaSql.absent

        let drafts =
            SchemaSql.queryIds
                dsn
                "SELECT id FROM meetups WHERE visibility = 'hidden' AND first_published_at IS NULL"
                []

        let unpublishedRows =
            SchemaSql.queryIds
                dsn
                "SELECT id FROM meetups WHERE visibility = 'hidden' AND first_published_at IS NOT NULL"
                []

        test <@ drafts = [ draft ] @>
        test <@ unpublishedRows = [ unpublished ] @>

    [<Fact>]
    member _.``A visible meetup cannot omit the first publication mark``() =
        use db = SchemaSql.applyIsolated ()

        let thrown =
            try
                SchemaSql.insertNoDate
                    db.ConnectionString
                    (Guid.Parse("0199c0de-0000-7000-8000-000000000024"))
                    "visible"
                    SchemaSql.absent
                    SchemaSql.absent

                None
            with ex ->
                Some ex

        test <@ thrown |> Option.exists SchemaSql.isCheckViolation @>

    [<Fact>]
    member _.``A visible meetup cannot keep a scheduled publication moment``() =
        use db = SchemaSql.applyIsolated ()

        let thrown =
            try
                SchemaSql.insertNoDate
                    db.ConnectionString
                    (Guid.Parse("0199c0de-0000-7000-8000-000000000023"))
                    "visible"
                    (DateTimeOffset.Parse("2026-09-01T10:00:00Z"))
                    (DateTimeOffset.Parse("2026-09-10T10:00:00Z"))

                None
            with ex ->
                Some ex

        test <@ thrown |> Option.exists SchemaSql.isCheckViolation @>

    [<Fact>]
    member _.``Due publication moments are selected without visible rows``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        let due = Guid.Parse("0199c0de-0000-7000-8000-000000000031")
        let later = Guid.Parse("0199c0de-0000-7000-8000-000000000032")
        let visible = Guid.Parse("0199c0de-0000-7000-8000-000000000033")

        SchemaSql.insertNoDate dsn due "hidden" SchemaSql.absent (DateTimeOffset.Parse("2026-09-06T11:00:00Z"))

        SchemaSql.insertNoDate dsn later "hidden" SchemaSql.absent (DateTimeOffset.Parse("2026-09-06T13:00:00Z"))

        SchemaSql.insertNoDate dsn visible "visible" (DateTimeOffset.Parse("2026-09-01T10:00:00Z")) SchemaSql.absent

        let found =
            SchemaSql.queryIds
                dsn
                """
                SELECT id FROM meetups
                WHERE visibility = 'hidden'
                  AND scheduled_publish_at IS NOT NULL
                  AND scheduled_publish_at <= @now
                ORDER BY scheduled_publish_at
                """
                [
                    "now", box (DateTimeOffset.Parse("2026-09-06T12:00:00Z"))
                ]

        test <@ found = [ due ] @>

    [<Fact>]
    member _.``Visible meetups are listed without hidden rows``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        let hidden = Guid.Parse("0199c0de-0000-7000-8000-000000000041")
        let first = Guid.Parse("0199c0de-0000-7000-8000-000000000042")
        let second = Guid.Parse("0199c0de-0000-7000-8000-000000000043")

        SchemaSql.insertNoDate dsn hidden "hidden" SchemaSql.absent SchemaSql.absent

        SchemaSql.insertMeetup
            dsn
            first
            "visible"
            (DateTimeOffset.Parse("2026-09-01T10:00:00Z"))
            SchemaSql.absent
            "fixed"
            "day"
            (DateOnly.Parse("2026-09-08"))
            SchemaSql.absent
            SchemaSql.absent
            SchemaSql.absent

        SchemaSql.insertMeetup
            dsn
            second
            "visible"
            (DateTimeOffset.Parse("2026-09-01T10:00:00Z"))
            SchemaSql.absent
            "fixed"
            "day"
            (DateOnly.Parse("2026-09-10"))
            SchemaSql.absent
            SchemaSql.absent
            SchemaSql.absent

        let found =
            SchemaSql.queryIds
                dsn
                """
                SELECT id FROM meetups
                WHERE visibility = 'visible'
                ORDER BY schedule_start_date ASC NULLS LAST, schedule_start_time ASC NULLS LAST
                """
                []

        test <@ found = [ first; second ] @>

    [<Fact>]
    member _.``Journal events are addressed by event_id and ordered by position``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        let meetupId = Guid.Parse("0199c0de-0000-7000-8000-000000000051")
        let firstEvent = Guid.Parse("0199c0de-0000-7000-8000-000000000061")
        let secondEvent = Guid.Parse("0199c0de-0000-7000-8000-000000000062")

        SchemaSql.insertNoDate dsn meetupId "hidden" SchemaSql.absent SchemaSql.absent
        SchemaSql.insertEvent dsn firstEvent meetupId 1 "meetup_created"
        SchemaSql.insertEvent dsn secondEvent meetupId 2 "meetup_changed"

        let ordered =
            SchemaSql.queryIds dsn "SELECT event_id FROM meetup_events ORDER BY position" []

        test <@ ordered = [ firstEvent; secondEvent ] @>

        let duplicateId =
            try
                SchemaSql.insertEvent dsn firstEvent meetupId 3 "meetup_published"
                None
            with ex ->
                Some ex

        test
            <@
                duplicateId
                |> Option.exists SchemaSql.isUniqueViolation
            @>

        let duplicateVersion =
            try
                SchemaSql.insertEvent
                    dsn
                    (Guid.Parse("0199c0de-0000-7000-8000-000000000063"))
                    meetupId
                    2
                    "meetup_published"

                None
            with ex ->
                Some ex

        test
            <@
                duplicateVersion
                |> Option.exists SchemaSql.isUniqueViolation
            @>
