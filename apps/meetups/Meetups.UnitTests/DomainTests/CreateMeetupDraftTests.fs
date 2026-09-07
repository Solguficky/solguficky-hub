module Meetups.DomainTests.CreateMeetupDraftTests

open Meetups.Domain
open Meetups.TestData
open Swensen.Unquote
open Xunit

[<Fact>]
let ``When no meetup exists expect a MeetupCreated event naming the caller as author`` () =
    let decision = Meetup.decideCreateDraft Sample.authorId Sample.meetupId None

    test <@ decision = Ok(Some(MeetupCreated(Sample.meetupId, Sample.authorId))) @>

[<Fact>]
let ``When the draft is created expect an empty hidden meetup at version one`` () =
    let expected =
        {
            Id = Sample.meetupId
            Author = Sample.authorId
            Title = ""
            Description = ""
            Venue = ""
            Kind = ""
            CalendarLink = ""
            Schedule = NoDate
            Lifecycle = Planned
            Visibility = Hidden
            FirstPublishedAt = None
            Version = 1L
        }

    test <@ Meetup.toSnapshot Sample.draft = expected @>

[<Fact>]
let ``When the same author repeats creation expect no event`` () =
    let decision =
        Meetup.decideCreateDraft Sample.authorId Sample.meetupId (Some Sample.draft)

    test <@ decision = Ok None @>

[<Fact>]
let ``When another author reuses the identifier expect the draft is refused`` () =
    let decision =
        Meetup.decideCreateDraft Sample.otherAuthorId Sample.meetupId (Some Sample.draft)

    test <@ decision = Error DraftBelongsToAnotherAuthor @>
