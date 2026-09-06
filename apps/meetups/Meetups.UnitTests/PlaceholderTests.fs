module Meetups.PlaceholderTests

open Meetups.Transport
open Meetups.V1
open Swensen.Unquote
open Xunit

let private id = "0199c0de-0000-7000-8000-000000000001"

[<Fact>]
let ``Placeholder echoes the requested id, so a green test means the request was parsed`` () =
    test <@ (Placeholder.snapshot id).Id = id @>

[<Fact>]
let ``Placeholder claims no domain state it cannot know`` () =
    let snapshot = Placeholder.snapshot id

    let actual =
        snapshot.Lifecycle, snapshot.Visibility, snapshot.Version, snapshot.HasFirstPublishedAt

    // PLANNED и version=1 читались бы как поведение сервиса, которого нет.
    test <@ actual = (MeetupLifecycle.Unspecified, MeetupVisibility.Unspecified, 0L, false) @>

[<Fact>]
let ``Placeholder spells absence of a date as the no_date form`` () =
    test <@ (Placeholder.snapshot id).Schedule.FormCase = Schedule.FormOneofCase.NoDate @>

[<Fact>]
let ``Visible meetups placeholder is empty rather than fabricated`` () =
    test <@ (Placeholder.visibleMeetups ()).Meetups.Count = 0 @>
