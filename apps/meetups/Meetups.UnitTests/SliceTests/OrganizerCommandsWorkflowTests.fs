/// Оболочки срезов состава организаторов и общее свойство решения о праве после
/// загрузки (ADR-076, п. 6 и 12): чужая и отсутствующая сходка дают один отказ и
/// одну последовательность запросов.
module Meetups.SliceTests.OrganizerCommandsWorkflowTests

open System
open System.Threading.Tasks
open Swensen.Unquote
open Xunit
open Meetups
open Meetups.Domain
open Meetups.Infrastructure
open Meetups.Slices
open Meetups.TestData

let private eventId = Guid.Parse "0199c0de-0000-7000-8000-00000000e003"

let private await (task: Task<'a>) = task |> Async.AwaitTask |> Async.RunSynchronously

/// Журнал обращений стенда: порядок запросов — наблюдаемое свойство.
type private Calls = ResizeArray<string>

let private commitRecording (calls: Calls) envelope _ state event =
    calls.Add "commit"
    ignore envelope

    Meetup.apply state event
    |> Meetup.toSnapshot
    |> Ok
    |> Task.FromResult

let private appointDeps
    (calls: Calls)
    (stored: MeetupSnapshot option)
    (right: bool option)
    : AppointMeetupOrganizer.Deps =
    {
        Load =
            fun _ ->
                calls.Add "load"
                Task.FromResult stored
        Commit = fun envelope version state event -> commitRecording calls envelope version state event
        AskRight =
            Some(fun _ _ ->
                calls.Add "ask"

                match right with
                | Some granted -> Task.FromResult(Ok granted)
                | None -> Task.FromResult(Error(CheckMeetupAuthority.IdentityFailure.Unavailable "down"))
            )
        Now = fun () -> Sample.later
        NewEventId = fun () -> eventId
        RequestId = None
    }

let private appoint (viewer: Viewer) (stored: MeetupSnapshot option) (deps: AppointMeetupOrganizer.Deps) =
    AppointMeetupOrganizer.execute
        deps
        {
            Id = Sample.meetupId
            Viewer = viewer
            Person = Sample.coOrganizerId
            ExpectedVersion =
                stored
                |> Option.map _.Version
                |> Option.defaultValue 1L
        }
    |> await

let private draft = Meetup.toSnapshot Sample.draft
let private withTwo = Meetup.toSnapshot Sample.withCoOrganizer

[<Fact>]
let ``Appointing writes one event after asking Identity for the right of the person`` () =
    let calls = Calls()

    let result =
        appoint Sample.authorOrganizer (Some draft) (appointDeps calls (Some draft) (Some true))

    test <@ calls |> List.ofSeq = [ "load"; "ask"; "commit" ] @>

    match result with
    | Ok snapshot ->
        test
            <@
                snapshot.Organizers = [
                    Sample.authorId
                    Sample.coOrganizerId
                ]
            @>
    | Error error -> failwith $"unexpected {error}"

[<Fact>]
let ``Appointing a person without the right is refused without writing`` () =
    let calls = Calls()

    let result =
        appoint Sample.authorOrganizer (Some draft) (appointDeps calls (Some draft) (Some false))

    test <@ result = Error AppointMeetupOrganizer.AppointMeetupOrganizerError.PersonNotEligible @>
    test <@ calls |> List.ofSeq = [ "load"; "ask" ] @>

[<Fact>]
let ``Appointing a member again succeeds without asking Identity or writing`` () =
    let calls = Calls()

    let result =
        appoint Sample.authorOrganizer (Some withTwo) (appointDeps calls (Some withTwo) (Some false))

    test <@ result = Ok withTwo @>
    test <@ calls |> List.ofSeq = [ "load" ] @>

[<Fact>]
let ``Appointing into a cancelled meetup is refused before Identity is asked`` () =
    let cancelled = Meetup.toSnapshot Sample.cancelled
    let calls = Calls()

    let result =
        appoint Sample.authorOrganizer (Some cancelled) (appointDeps calls (Some cancelled) (Some true))

    test
        <@ result = Error(AppointMeetupOrganizer.AppointMeetupOrganizerError.Roster RosterError.TransitionNotAllowed) @>

    test <@ calls |> List.ofSeq = [ "load" ] @>

[<Fact>]
let ``Appointing with a stale version conflicts before Identity is asked`` () =
    let calls = Calls()
    let deps = appointDeps calls (Some draft) (Some true)

    let result =
        AppointMeetupOrganizer.execute
            deps
            {
                Id = Sample.meetupId
                Viewer = Sample.authorOrganizer
                Person = Sample.coOrganizerId
                ExpectedVersion = draft.Version + 5L
            }
        |> await

    test <@ result = Error AppointMeetupOrganizer.AppointMeetupOrganizerError.Conflict @>
    test <@ calls |> List.ofSeq = [ "load" ] @>

[<Fact>]
let ``An unavailable Identity makes appointing unavailable and writes nothing`` () =
    let calls = Calls()

    let result =
        appoint Sample.authorOrganizer (Some draft) (appointDeps calls (Some draft) None)

    test <@ result = Error(AppointMeetupOrganizer.AppointMeetupOrganizerError.IdentityUnavailable "down") @>
    test <@ not (calls.Contains "commit") @>

/// Организатор, потерявший право, остаётся в составе, но командовать не может.
[<Fact>]
let ``An organizer who lost the right cannot appoint but stays in the roster`` () =
    let calls = Calls()

    let result =
        appoint Sample.ordinary (Some draft) (appointDeps calls (Some draft) (Some true))

    test <@ result = Error(AppointMeetupOrganizer.AppointMeetupOrganizerError.Forbidden CannotActOnMeetup) @>
    test <@ draft.Organizers = [ Sample.authorId ] @>

[<Fact>]
let ``A foreign and a missing meetup get the same refusal and the same requests`` () =
    let foreignCalls = Calls()
    let missingCalls = Calls()

    let foreign =
        appoint Sample.stranger (Some draft) (appointDeps foreignCalls (Some draft) (Some true))

    let missing =
        appoint Sample.stranger None (appointDeps missingCalls None (Some true))

    test <@ foreign = missing @>
    test <@ foreign = Error(AppointMeetupOrganizer.AppointMeetupOrganizerError.Forbidden CannotActOnMeetup) @>
    test <@ List.ofSeq foreignCalls = List.ofSeq missingCalls @>

[<Fact>]
let ``An administrator gets not found for a missing meetup`` () =
    let calls = Calls()
    let result = appoint Sample.administrator None (appointDeps calls None (Some true))

    test <@ result = Error(AppointMeetupOrganizer.AppointMeetupOrganizerError.Roster RosterError.MeetupNotFound) @>

// ---- Dismiss ----------------------------------------------------------------

let private dismissDeps (calls: Calls) (stored: MeetupSnapshot option) : DismissMeetupOrganizer.Deps =
    {
        Load =
            fun _ ->
                calls.Add "load"
                Task.FromResult stored
        Commit = fun envelope version state event -> commitRecording calls envelope version state event
        Now = fun () -> Sample.later
        NewEventId = fun () -> eventId
        RequestId = None
    }

let private dismiss (viewer: Viewer) (person: PersonId) (stored: MeetupSnapshot option) (calls: Calls) =
    DismissMeetupOrganizer.execute
        (dismissDeps calls stored)
        {
            Id = Sample.meetupId
            Viewer = viewer
            Person = person
            ExpectedVersion =
                stored
                |> Option.map _.Version
                |> Option.defaultValue 1L
        }
    |> await

[<Fact>]
let ``An organizer dismisses a co-organizer`` () =
    let calls = Calls()

    let result =
        dismiss Sample.authorOrganizer Sample.coOrganizerId (Some withTwo) calls

    test <@ calls |> List.ofSeq = [ "load"; "commit" ] @>

    match result with
    | Ok snapshot -> test <@ snapshot.Organizers = [ Sample.authorId ] @>
    | Error error -> failwith $"unexpected {error}"

[<Fact>]
let ``A co-organizer cannot dismiss the author`` () =
    let result = dismiss Sample.coOrganizer Sample.authorId (Some withTwo) (Calls())

    test <@ result = Error(DismissMeetupOrganizer.DismissMeetupOrganizerError.Roster RosterError.AuthorProtected) @>

[<Fact>]
let ``An administrator dismisses the author and the last person`` () =
    let calls = Calls()
    let result = dismiss Sample.administrator Sample.authorId (Some draft) calls

    test <@ Result.isOk result @>
    test <@ calls.Contains "commit" @>

[<Fact>]
let ``Nobody but an administrator dismisses the last person`` () =
    let onlyCo =
        Meetup.apply (Existing Sample.withCoOrganizer) (MeetupOrganizerDismissed Sample.authorId)
        |> Meetup.toSnapshot

    let result = dismiss Sample.coOrganizer Sample.coOrganizerId (Some onlyCo) (Calls())

    // Снять самого себя этой командой нельзя на границе, а здесь домен всё равно
    // защищает последнего: другой организатор в составе не нужен.
    test <@ result = Error(DismissMeetupOrganizer.DismissMeetupOrganizerError.Roster RosterError.LastOrganizer) @>

[<Fact>]
let ``Dismissing from a foreign or missing meetup gets the same refusal and requests`` () =
    let foreignCalls = Calls()
    let missingCalls = Calls()
    let foreign = dismiss Sample.stranger Sample.authorId (Some draft) foreignCalls
    let missing = dismiss Sample.stranger Sample.authorId None missingCalls

    test <@ foreign = missing @>
    test <@ foreign = Error(DismissMeetupOrganizer.DismissMeetupOrganizerError.Forbidden CannotActOnMeetup) @>
    test <@ List.ofSeq foreignCalls = List.ofSeq missingCalls @>

[<Fact>]
let ``A cancelled meetup still allows dismissing`` () =
    let cancelledTwo =
        Meetup.toSnapshot (Meetup.apply (Existing Sample.withCoOrganizer) MeetupCancelled)

    let result =
        dismiss Sample.authorOrganizer Sample.coOrganizerId (Some cancelledTwo) (Calls())

    test <@ Result.isOk result @>

// ---- Leave ------------------------------------------------------------------

let private leave (viewer: Viewer) (stored: MeetupSnapshot option) (calls: Calls) =
    LeaveMeetupOrganizers.execute
        (let deps = dismissDeps calls stored

         ({
             Load = deps.Load
             Commit = deps.Commit
             Now = deps.Now
             NewEventId = deps.NewEventId
             RequestId = deps.RequestId
         }
         : LeaveMeetupOrganizers.Deps))
        {
            Id = Sample.meetupId
            Viewer = viewer
            ExpectedVersion =
                stored
                |> Option.map _.Version
                |> Option.defaultValue 1L
        }
    |> await

[<Fact>]
let ``A person who lost the right can still leave the roster`` () =
    let calls = Calls()
    let result = leave Sample.ordinary (Some withTwo) calls

    test <@ calls |> List.ofSeq = [ "load"; "commit" ] @>

    match result with
    | Ok snapshot -> test <@ snapshot.Organizers = [ Sample.coOrganizerId ] @>
    | Error error -> failwith $"unexpected {error}"

[<Fact>]
let ``The last person in the roster cannot leave`` () =
    let result = leave Sample.authorOrganizer (Some draft) (Calls())

    test <@ result = Error(LeaveMeetupOrganizers.LeaveMeetupOrganizersError.Roster RosterError.LastOrganizer) @>

[<Fact>]
let ``Leaving a published meetup from outside the roster succeeds without writing`` () =
    let published = Meetup.toSnapshot Sample.published
    let calls = Calls()
    let result = leave Sample.stranger (Some published) calls

    test <@ result = Ok published @>
    test <@ calls |> List.ofSeq = [ "load" ] @>

[<Fact>]
let ``Leaving a hidden meetup from outside the roster is refused like a missing one`` () =
    let hidden = leave Sample.stranger (Some draft) (Calls())
    let missing = leave Sample.stranger None (Calls())

    test <@ hidden = missing @>
    test <@ hidden = Error(LeaveMeetupOrganizers.LeaveMeetupOrganizersError.Forbidden CannotActOnMeetup) @>

// ---- Общее свойство пишущих команд -------------------------------------------------

let private publishDeps (calls: Calls) (stored: MeetupSnapshot option) : PublishMeetup.Deps =
    {
        Load =
            fun _ ->
                calls.Add "load"
                Task.FromResult stored
        Commit = fun envelope version state event -> commitRecording calls envelope version state event
        Now = fun () -> Sample.later
        NewEventId = fun () -> eventId
        RequestId = None
    }

let private publish (viewer: Viewer) (stored: MeetupSnapshot option) (calls: Calls) =
    PublishMeetup.execute
        (publishDeps calls stored)
        {
            Id = Sample.meetupId
            Viewer = viewer
            ExpectedVersion = 2L
            Silent = false
        }
    |> await

[<Fact>]
let ``A write command gives a stranger the same refusal and requests for a foreign and a missing meetup`` () =
    let foreignCalls = Calls()
    let missingCalls = Calls()

    let foreign =
        publish Sample.stranger (Some(Meetup.toSnapshot Sample.titled)) foreignCalls

    let missing = publish Sample.stranger None missingCalls

    test <@ foreign = missing @>
    test <@ foreign = Error(PublishMeetup.PublishMeetupError.Forbidden CannotActOnMeetup) @>
    test <@ List.ofSeq foreignCalls = [ "load" ] @>
    test <@ List.ofSeq foreignCalls = List.ofSeq missingCalls @>

[<Fact>]
let ``A participant publishes their own meetup`` () =
    let titled = Meetup.toSnapshot Sample.titled
    let calls = Calls()

    let result =
        PublishMeetup.execute
            (publishDeps calls (Some titled))
            {
                Id = Sample.meetupId
                Viewer = Sample.authorOrganizer
                ExpectedVersion = titled.Version
                Silent = false
            }
        |> await

    test <@ Result.isOk result @>
    test <@ List.ofSeq calls = [ "load"; "commit" ] @>

[<Fact>]
let ``An organizer who lost the right is refused while staying in the roster`` () =
    let titled = Meetup.toSnapshot Sample.titled
    let result = publish Sample.ordinary (Some titled) (Calls())

    test <@ result = Error(PublishMeetup.PublishMeetupError.Forbidden CannotActOnMeetup) @>
    test <@ List.contains Sample.ordinary.IdentityId titled.Organizers @>
