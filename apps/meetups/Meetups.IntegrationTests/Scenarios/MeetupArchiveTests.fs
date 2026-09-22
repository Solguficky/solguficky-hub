namespace Meetups.IntegrationTests.Scenarios

open System
open Meetups.Domain
open Meetups.IntegrationTests.Infrastructure
open Meetups.V1
open Swensen.Unquote
open Xunit

/// Разделение выдачи на актуальные и архив через настоящий Kestrel и PostgreSQL.
/// Даты считаются от дня сообщества: сценарий, записанный фиксированной датой,
/// позеленел бы сегодня и покраснел после неё.
type MeetupArchiveTests() =

    let administrator () =
        let viewer = Viewer(IdentityId = "0199c0de-0000-7000-8000-00000000000a")
        viewer.GlobalRoles.Add Identity.V1.GlobalRole.Admin
        viewer

    let ordinary () = Viewer(IdentityId = "0199c0de-0000-7000-8000-00000000000c")

    let newId () = Guid.CreateVersion7()
    let keyOf (id: Guid) = id.ToString "D"

    let createPublished
        (client: MeetupsService.MeetupsServiceClient)
        (admin: Viewer)
        (id: Guid)
        (title: string)
        schedule
        =
        let key = keyOf id

        let draft =
            client.CreateMeetupDraft(CreateMeetupDraftRequest(Viewer = admin, Id = key))

        let titled =
            client.ChangeMeetupAttributes(
                ChangeMeetupAttributesRequest(Viewer = admin, Id = key, Title = title, ExpectedVersion = draft.Version)
            )

        let scheduled =
            match schedule with
            | Some value ->
                client.SetMeetupSchedule(
                    SetMeetupScheduleRequest(
                        Viewer = admin,
                        Id = key,
                        Schedule = value,
                        ExpectedVersion = titled.Version
                    )
                )
            | None -> titled

        client.PublishMeetup(PublishMeetupRequest(Viewer = admin, Id = key, ExpectedVersion = scheduled.Version))

    let fixedDay (date: DateOnly) =
        Schedule(Fixed = DateValue(Day = CalendarDate(Year = date.Year, Month = date.Month, Day = date.Day)))

    let actualIds (client: MeetupsService.MeetupsServiceClient) viewer =
        client.ListVisibleMeetups(ListVisibleMeetupsRequest(Viewer = viewer)).Meetups
        |> Seq.map _.Id
        |> Set.ofSeq

    let archived (client: MeetupsService.MeetupsServiceClient) viewer =
        client.ListArchivedMeetups(ListArchivedMeetupsRequest(Viewer = viewer)).Meetups
        |> List.ofSeq

    let today = MeetupCommands.communityToday ()

    [<Fact>]
    member _.``A held meetup leaves the actual list and enters the archive``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let admin = administrator ()
        let id = newId ()

        let published =
            createPublished client admin id "Held" (Some(fixedDay (today.AddDays 30)))

        client.MarkMeetupHeld(MarkMeetupHeldRequest(Viewer = admin, Id = keyOf id, ExpectedVersion = published.Version))
        |> ignore

        let key = keyOf id

        test <@ not ((actualIds client (ordinary ())).Contains key) @>

        test
            <@
                archived client (ordinary ())
                |> List.exists (fun meetup ->
                    meetup.Id = key
                    && meetup.Lifecycle = MeetupLifecycle.Held
                )
            @>

    [<Fact>]
    member _.``A cancelled meetup leaves the actual list and enters the archive``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let admin = administrator ()
        let id = newId ()

        let published =
            createPublished client admin id "Cancelled" (Some(fixedDay (today.AddDays 30)))

        client.CancelMeetup(CancelMeetupRequest(Viewer = admin, Id = keyOf id, ExpectedVersion = published.Version))
        |> ignore

        let key = keyOf id

        test <@ not ((actualIds client (ordinary ())).Contains key) @>

        test
            <@
                archived client (ordinary ())
                |> List.exists (fun meetup ->
                    meetup.Id = key
                    && meetup.Lifecycle = MeetupLifecycle.Cancelled
                )
            @>

    /// Прошедшая входит в архив без команды: её строка остаётся Planned, а разделение
    /// делает правило чтения. Чтение ничего не пишет — журнал до и после совпадает.
    [<Fact>]
    member _.``A past scheduled meetup enters the archive without a command or a journal row``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let admin = administrator ()
        let id = newId ()

        createPublished client admin id "Past" (Some(fixedDay (today.AddDays -1)))
        |> ignore

        let eventsBefore = MeetupCommands.countEvents live.ConnectionString id
        let key = keyOf id

        test <@ not ((actualIds client (ordinary ())).Contains key) @>

        test
            <@
                archived client (ordinary ())
                |> List.exists (fun meetup ->
                    meetup.Id = key
                    && meetup.Lifecycle = MeetupLifecycle.Planned
                )
            @>

        let stored = client.GetMeetup(GetMeetupRequest(Viewer = ordinary (), Id = key))

        test <@ stored.Lifecycle = MeetupLifecycle.Planned @>
        test <@ MeetupCommands.countEvents live.ConnectionString id = eventsBefore @>

    [<Fact>]
    member _.``The archive lists dates newest first and keeps undated meetups last``() =
        use live = new LiveMeetupsHost()
        let client = MeetupsService.MeetupsServiceClient(live.Channel)
        let admin = administrator ()

        let newest = newId ()

        let publishedNewest =
            createPublished client admin newest "Newest" (Some(fixedDay (today.AddDays 20)))

        client.MarkMeetupHeld(
            MarkMeetupHeldRequest(Viewer = admin, Id = keyOf newest, ExpectedVersion = publishedNewest.Version)
        )
        |> ignore

        let middle = newId ()

        let publishedMiddle =
            createPublished client admin middle "Middle" (Some(fixedDay (today.AddDays 10)))

        client.CancelMeetup(
            CancelMeetupRequest(Viewer = admin, Id = keyOf middle, ExpectedVersion = publishedMiddle.Version)
        )
        |> ignore

        let oldest = newId ()

        createPublished client admin oldest "Oldest" (Some(fixedDay (today.AddDays -1)))
        |> ignore

        let undated = newId ()
        let publishedUndated = createPublished client admin undated "Undated" None

        client.MarkMeetupHeld(
            MarkMeetupHeldRequest(Viewer = admin, Id = keyOf undated, ExpectedVersion = publishedUndated.Version)
        )
        |> ignore

        let titles = archived client (ordinary ()) |> List.map _.Title

        test
            <@
                titles = [
                    "Newest"
                    "Middle"
                    "Oldest"
                    "Undated"
                ]
            @>

    /// Отметка «состоялась» пишет состояние и событие той же транзакцией: это
    /// свойство `MeetupStore.commit`, и проверяется оно на настоящей базе — мок его
    /// не воспроизводит.
    [<Fact>]
    member _.``Marking as held writes the state and the journal row together``() =
        use db = SchemaSql.applyIsolated ()
        let dsn = db.ConnectionString
        use source = MeetupCommands.source dsn
        let rawId = Guid.Parse "0199c0de-0000-7000-8000-0000000000c1"
        let id = MeetupId rawId

        MeetupCommands.create source (Guid.Parse "0199c0de-0000-7000-8000-0000000000e1") id MeetupCommands.administrator
        |> ignore

        MeetupCommands.change source (Guid.Parse "0199c0de-0000-7000-8000-0000000000e2") id
        |> ignore

        MeetupCommands.publish source (Guid.Parse "0199c0de-0000-7000-8000-0000000000e3") id
        |> ignore

        let held =
            MeetupCommands.markHeld source (Guid.Parse "0199c0de-0000-7000-8000-0000000000e4") id

        test <@ MeetupCommands.versionIn held = Some 4L @>
        test <@ List.last (MeetupCommands.eventTypes dsn rawId) = "meetup_held" @>
        test <@ MeetupCommands.eventsAheadOfState dsn rawId = 0L @>
