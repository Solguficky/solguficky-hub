namespace Meetups.IntegrationTests.Scenarios

open System
open Grpc.Core
open Meetups.IntegrationTests.Infrastructure
open Meetups.V1
open Npgsql
open Swensen.Unquote
open Xunit

/// Состав организаторов сходки через настоящие gRPC, срез и PostgreSQL (ADR-076):
/// участник ведёт свою сходку, чужая и отсутствующая неразличимы, состав меняется
/// командами, поводы уходят в журнал, а миграция вписывает автора в старые сходки.
type OrganizerRosterTests() =

    let authorId = "0199c0de-0000-7000-8000-0000000000a1"
    let coId = "0199c0de-0000-7000-8000-0000000000a2"
    let strangerId = "0199c0de-0000-7000-8000-0000000000a3"
    let adminId = "0199c0de-0000-7000-8000-0000000000a4"
    let noRightId = "0199c0de-0000-7000-8000-0000000000a5"

    let viewer (id: string) (rights: Identity.V1.AccessRight list) =
        let value = Viewer(IdentityId = id)

        for right in rights do
            value.Rights.Add right

        value

    let participant id =
        viewer
            id
            [
                Identity.V1.AccessRight.OrganizeMeetups
            ]

    let administrator () =
        viewer
            adminId
            [
                Identity.V1.AccessRight.ManageMeetups
            ]

    /// Порт Identity: право `organize_meetups` у людей из набора. Решение о праве
    /// смотрящего Meetups берёт из его запроса, а право назначаемого и организатора в
    /// `CheckMeetupAuthority` спрашивает здесь, как спросил бы настоящий Identity.
    let identityPort (holders: Set<string>) =
        let ask: Meetups.Slices.CheckMeetupAuthority.AskRight =
            fun (Meetups.Domain.PersonId person) right ->
                Threading.Tasks.Task.FromResult(
                    Ok(
                        right = Meetups.Domain.OrganizeMeetups
                        && holders.Contains(person.ToString "D")
                    )
                )

        fun (services: Microsoft.Extensions.DependencyInjection.IServiceCollection) ->
            Microsoft.Extensions.DependencyInjection.ServiceCollectionServiceExtensions.AddSingleton<
                Meetups.Slices.CheckMeetupAuthority.Port
             >(
                services,
                Meetups.Slices.CheckMeetupAuthority.Port.Connected(fun _ -> ask)
            )
            |> ignore

    let status (action: unit -> unit) =
        try
            action ()
            None
        with :? RpcException as refused ->
            Some refused.Status

    let titled (client: MeetupsService.MeetupsServiceClient) (who: Viewer) =
        let key = (Guid.CreateVersion7()).ToString "D"

        let draft =
            client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = who, Id = key))

        let changed =
            client.ChangeMeetupAttributes(
                ChangeMeetupAttributesRequest(
                    Viewer = who,
                    Id = key,
                    ExpectedVersion = draft.Version,
                    Title = "Сходка участника"
                )
            )

        key, changed

    let eventTypes (dsn: string) (meetupId: string) =
        use connection = new NpgsqlConnection(dsn)
        connection.Open()

        use command =
            new NpgsqlCommand(
                "SELECT event_type, person_id::text, performed_by::text FROM meetup_events WHERE meetup_id = @id ORDER BY position",
                connection
            )

        command.Parameters.AddWithValue("id", Guid.Parse meetupId)
        |> ignore

        use reader = command.ExecuteReader()

        [
            while reader.Read() do
                reader.GetString 0, (if reader.IsDBNull 1 then None else Some(reader.GetString 1)), reader.GetString 2
        ]

    [<Fact>]
    member _.``A participant creates edits and publishes their own meetup and becomes its first organizer``() =
        use live = new LiveMeetupsHost(identityPort (set [ authorId ]))
        let client = AuthenticatedClient.bot live.Channel
        let me = participant authorId
        let key, changed = titled client me

        let published =
            client.PublishMeetup(PublishMeetupRequest(Viewer = me, Id = key, ExpectedVersion = changed.Version))

        test <@ published.Visibility = MeetupVisibility.Visible @>

        test
            <@
                List.ofSeq published.Organizers = [ authorId ]
                && published.Author = authorId
            @>

    /// Критерий задачи: чужая сходка и отсутствующая дают один и тот же отказ.
    [<Fact>]
    member _.``A foreign meetup and a missing one refuse a participant the same way``() =
        use live = new LiveMeetupsHost(identityPort (set [ authorId; strangerId ]))
        let client = AuthenticatedClient.bot live.Channel
        let key, changed = titled client (participant authorId)
        let missing = (Guid.CreateVersion7()).ToString "D"
        let stranger = participant strangerId

        let attempt (id: string) =
            status (fun () ->
                client.ChangeMeetupAttributes(
                    ChangeMeetupAttributesRequest(
                        Viewer = stranger,
                        Id = id,
                        ExpectedVersion = changed.Version,
                        Title = "Чужое"
                    )
                )
                |> ignore
            )

        test <@ attempt key = attempt missing @>
        test <@ (attempt key).Value.StatusCode = StatusCode.PermissionDenied @>

    [<Fact>]
    member _.``A stranger gets not found for a hidden meetup and for a missing one``() =
        use live = new LiveMeetupsHost(identityPort (set [ authorId; strangerId ]))
        let client = AuthenticatedClient.bot live.Channel
        let key, _ = titled client (participant authorId)
        let missing = (Guid.CreateVersion7()).ToString "D"
        let stranger = participant strangerId

        let read (id: string) =
            status (fun () ->
                client.GetMeetup(GetMeetupRequest(Viewer = stranger, Id = id))
                |> ignore
            )

        test <@ read key = read missing @>
        test <@ (read key).Value.StatusCode = StatusCode.NotFound @>

    [<Fact>]
    member _.``An appointed co-organizer reads and edits the meetup and a dismissal takes it back``() =
        use live = new LiveMeetupsHost(identityPort (set [ authorId; coId ]))
        let client = AuthenticatedClient.bot live.Channel
        let me = participant authorId
        let co = participant coId
        let key, changed = titled client me

        let appointed =
            client.AppointMeetupOrganizer(
                AppointMeetupOrganizerRequest(
                    Viewer = me,
                    Id = key,
                    IdentityId = coId,
                    ExpectedVersion = changed.Version
                )
            )

        let read = client.GetMeetup(GetMeetupRequest(Viewer = co, Id = key))

        let edited =
            client.ChangeMeetupAttributes(
                ChangeMeetupAttributesRequest(
                    Viewer = co,
                    Id = key,
                    ExpectedVersion = appointed.Version,
                    Title = "Правка соорганизатора"
                )
            )

        let dismissed =
            client.DismissMeetupOrganizer(
                DismissMeetupOrganizerRequest(
                    Viewer = me,
                    Id = key,
                    IdentityId = coId,
                    ExpectedVersion = edited.Version
                )
            )

        let readAfter =
            status (fun () ->
                client.GetMeetup(GetMeetupRequest(Viewer = co, Id = key))
                |> ignore
            )

        test
            <@
                List.ofSeq appointed.Organizers = [ authorId; coId ]
                && read.Version = appointed.Version
            @>

        test <@ edited.Title = "Правка соорганизатора" @>
        test <@ List.ofSeq dismissed.Organizers = [ authorId ] @>
        test <@ (readAfter |> Option.map _.StatusCode) = Some StatusCode.NotFound @>

        // Назначение и снятие — два повода журнала с затронутым человеком.
        let journal = eventTypes live.ConnectionString key

        let organizerEvents =
            journal
            |> List.filter (fun (kind, _, _) -> kind.StartsWith "meetup_organizer_")

        test
            <@
                organizerEvents = [
                    "meetup_organizer_appointed", Some coId, authorId
                    "meetup_organizer_dismissed", Some coId, authorId
                ]
            @>

    [<Fact>]
    member _.``A co-organizer cannot dismiss the author and nobody but an administrator dismisses the last one``() =
        use live = new LiveMeetupsHost(identityPort (set [ authorId; coId ]))
        let client = AuthenticatedClient.bot live.Channel
        let me = participant authorId
        let co = participant coId
        let key, changed = titled client me

        let appointed =
            client.AppointMeetupOrganizer(
                AppointMeetupOrganizerRequest(
                    Viewer = me,
                    Id = key,
                    IdentityId = coId,
                    ExpectedVersion = changed.Version
                )
            )

        let authorDismissed =
            status (fun () ->
                client.DismissMeetupOrganizer(
                    DismissMeetupOrganizerRequest(
                        Viewer = co,
                        Id = key,
                        IdentityId = authorId,
                        ExpectedVersion = appointed.Version
                    )
                )
                |> ignore
            )

        // Автор выходит сам: остаётся соорганизатор, которого теперь не снять и не выпустить.
        let left =
            client.LeaveMeetupOrganizers(
                LeaveMeetupOrganizersRequest(Viewer = me, Id = key, ExpectedVersion = appointed.Version)
            )

        let lastLeaves =
            status (fun () ->
                client.LeaveMeetupOrganizers(
                    LeaveMeetupOrganizersRequest(Viewer = co, Id = key, ExpectedVersion = left.Version)
                )
                |> ignore
            )

        let byAdministrator =
            client.DismissMeetupOrganizer(
                DismissMeetupOrganizerRequest(
                    Viewer = administrator (),
                    Id = key,
                    IdentityId = coId,
                    ExpectedVersion = left.Version
                )
            )

        test <@ (authorDismissed |> Option.map _.StatusCode) = Some StatusCode.PermissionDenied @>
        test <@ List.ofSeq left.Organizers = [ coId ] @>
        test <@ (lastLeaves |> Option.map _.StatusCode) = Some StatusCode.FailedPrecondition @>
        test <@ byAdministrator.Organizers.Count = 0 @>

    /// Организатор, потерявший право, получает отказ на команде, оставаясь в составе.
    [<Fact>]
    member _.``An organizer who lost the right is refused while staying in the roster``() =
        use live = new LiveMeetupsHost(identityPort (set [ authorId ]))
        let client = AuthenticatedClient.bot live.Channel
        let key, changed = titled client (participant authorId)
        let withoutRight = viewer authorId []

        let refused =
            status (fun () ->
                client.PublishMeetup(
                    PublishMeetupRequest(Viewer = withoutRight, Id = key, ExpectedVersion = changed.Version)
                )
                |> ignore
            )

        // Выход опирается на запись в составе, а не на право.
        let roster =
            client.GetMeetup(GetMeetupRequest(Viewer = withoutRight, Id = key)).Organizers

        test <@ (refused |> Option.map _.StatusCode) = Some StatusCode.PermissionDenied @>
        test <@ List.ofSeq roster = [ authorId ] @>

    [<Fact>]
    member _.``Appointing a person without the right is refused with FAILED_PRECONDITION``() =
        use live = new LiveMeetupsHost(identityPort (set [ authorId ]))
        let client = AuthenticatedClient.bot live.Channel
        let me = participant authorId
        let key, changed = titled client me

        let refused =
            status (fun () ->
                client.AppointMeetupOrganizer(
                    AppointMeetupOrganizerRequest(
                        Viewer = me,
                        Id = key,
                        IdentityId = noRightId,
                        ExpectedVersion = changed.Version
                    )
                )
                |> ignore
            )

        test <@ (refused |> Option.map _.StatusCode) = Some StatusCode.FailedPrecondition @>

    [<Fact>]
    member _.``The authority check accepts an organizer from the roster and refuses a right holder outside it``() =
        use live = new LiveMeetupsHost(identityPort (set [ authorId; strangerId ]))
        let client = AuthenticatedClient.bot live.Channel
        let authority = AuthenticatedClient.notifications live.Channel
        let key, _ = titled client (participant authorId)

        let check (person: string) (id: string) =
            let request = CheckMeetupAuthorityRequest(IdentityId = person, Id = id)
            request.AcceptedRelations.Add MeetupRelation.Organizer
            status (fun () -> authority.CheckMeetupAuthority request |> ignore)

        let missing = (Guid.CreateVersion7()).ToString "D"

        test <@ check authorId key = None @>
        test <@ check strangerId key = check strangerId missing @>
        test <@ (check strangerId key |> Option.map _.StatusCode) = Some StatusCode.PermissionDenied @>

    /// Миграция вписывает автора в состав сходки, заведённой до появления состава, и
    /// повторный прогон не возвращает автора в состав, который опустошили.
    [<Fact>]
    member _.``The migration puts the author into the roster of an old meetup and stays idempotent``() =
        use db = new IsolatedDatabase()
        let dsn = db.ConnectionString
        let author = Guid.Parse authorId
        let meetup = Guid.CreateVersion7()

        let exec (sql: string) =
            use connection = new NpgsqlConnection(dsn)
            connection.Open()
            use command = new NpgsqlCommand(sql, connection)

            command.Parameters.AddWithValue("id", meetup)
            |> ignore

            command.Parameters.AddWithValue("author", author)
            |> ignore

            command.ExecuteNonQuery() |> ignore

        let rosterOf () =
            use connection = new NpgsqlConnection(dsn)
            connection.Open()

            use command =
                new NpgsqlCommand("SELECT organizers FROM meetups WHERE id = @id", connection)

            command.Parameters.AddWithValue("id", meetup)
            |> ignore

            command.ExecuteScalar() :?> Guid[] |> List.ofArray

        let applyUpTo (limit: int) =
            for migration in Meetups.Migrations.list () do
                if migration.Version <= limit then
                    use connection = new NpgsqlConnection(dsn)
                    connection.Open()
                    use command = new NpgsqlCommand(migration.Sql, connection)
                    command.ExecuteNonQuery() |> ignore

        applyUpTo 10

        exec
            "INSERT INTO meetups (id, author, lifecycle, visibility, version, schedule_form, schedule_precision) VALUES (@id, @author, 'planned', 'hidden', 1, 'no_date', NULL)"

        applyUpTo 11
        let migrated = rosterOf ()

        // Администратор опустошил состав; повторный прогон 011 его не трогает.
        exec "UPDATE meetups SET organizers = ARRAY[]::uuid[] WHERE id = @id"
        applyUpTo 11
        let emptied = rosterOf ()

        test <@ migrated = [ author ] @>
        test <@ emptied = [] @>
