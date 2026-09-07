module Meetups.DomainTests.PublishMeetupTests

open Meetups.Domain
open Meetups.TestData
open Swensen.Unquote
open Xunit

[<Fact>]
let ``When the title is empty expect the publication is refused`` () =
    test <@ Meetup.decidePublish Sample.fixedNow Sample.draft = Error TitleRequiredForPublication @>

[<Fact>]
let ``When the title is only blanks expect the publication is refused`` () =
    let blankTitle =
        { Sample.attributes with
            Title = "   "
        }

    let blank = Meetup.applyChanged Sample.draft (AttributesChanged blankTitle)

    test <@ Meetup.decidePublish Sample.fixedNow blank = Error TitleRequiredForPublication @>

[<Fact>]
let ``When the title is set expect a MeetupPublished event carrying the supplied instant`` () =
    let decision = Meetup.decidePublish Sample.fixedNow Sample.titled

    test <@ decision = Ok(Some(MeetupPublished Sample.fixedNow)) @>

[<Fact>]
let ``When the publication is applied expect the meetup becomes visible and stamped`` () =
    let snapshot = Meetup.toSnapshot Sample.published

    test <@ (snapshot.Visibility, snapshot.FirstPublishedAt) = (Visible, Some Sample.fixedNow) @>

[<Fact>]
let ``When an already visible meetup is published again expect no event`` () =
    // Команда сформулирована как целевое состояние: повтор успешен и события не даёт.
    test <@ Meetup.decidePublish Sample.later Sample.published = Ok None @>

[<Fact>]
let ``When the publication is applied twice expect the first publication mark to survive`` () =
    let republished =
        Meetup.applyPublished Sample.published Sample.later
        |> Meetup.toSnapshot

    test <@ republished.FirstPublishedAt = Some Sample.fixedNow @>
