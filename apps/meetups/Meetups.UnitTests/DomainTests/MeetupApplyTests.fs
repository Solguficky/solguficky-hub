module Meetups.DomainTests.MeetupApplyTests

open System
open Meetups.Domain
open Meetups.TestData
open Swensen.Unquote
open Xunit

let private identity meetup =
    let snapshot = Meetup.toSnapshot meetup
    snapshot.Id, snapshot.Author

let private version meetup = (Meetup.toSnapshot meetup).Version

[<Fact>]
let ``Apply should raise the version by exactly one for a change`` () =
    test <@ version Sample.titled = version Sample.draft + 1L @>

[<Fact>]
let ``Apply should raise the version by exactly one for a publication`` () =
    test <@ version Sample.published = version Sample.titled + 1L @>

[<Fact>]
let ``Apply should keep the identifier and the author for every event`` () =
    let hidden = Meetup.apply (Existing Sample.published) MeetupUnpublished
    let returned = Meetup.apply (Existing hidden) MeetupRepublished
    let cancelled = Meetup.apply (Existing Sample.published) MeetupCancelled

    let identities =
        [
            identity Sample.draft
            identity Sample.titled
            identity Sample.published
            identity hidden
            identity returned
            identity cancelled
        ]
        |> List.distinct

    test <@ identities = [ Sample.meetupId, Sample.authorId ] @>

[<Fact>]
let ``Apply should raise the version by exactly one for a visibility change`` () =
    let hidden = Meetup.apply (Existing Sample.published) MeetupUnpublished
    let returned = Meetup.apply (Existing hidden) MeetupRepublished

    test <@ version hidden = version Sample.published + 1L @>
    test <@ version returned = version hidden + 1L @>

[<Fact>]
let ``Apply should raise the version by exactly one for a cancellation`` () =
    let cancelled = Meetup.apply (Existing Sample.published) MeetupCancelled

    test <@ version cancelled = version Sample.published + 1L @>

[<Fact>]
let ``Apply should raise the version by exactly one for a held transition`` () =
    let held = Meetup.apply (Existing Sample.titled) MeetupHeld

    test <@ version held = version Sample.titled + 1L @>
    test <@ (Meetup.toSnapshot held).Lifecycle = Held @>

[<Fact>]
let ``Apply should leave the lifecycle planned`` () =
    // Оси независимы: публикация двигает видимость и жизненного цикла не касается.
    // Переходы обеих конечных стадий дают свои команды, и их собственный эффект
    // проверяют CancelMeetupTests и MarkMeetupHeldTests.
    test <@ (Meetup.toSnapshot Sample.published).Lifecycle = Planned @>

[<Fact>]
let ``Apply should reject an event decided from another state`` () =
    // Такую пару не возвращает ни одно решение: она означает дефект оболочки, а не
    // отклонённый переход домена, поэтому исключение, а не DomainError.
    let change = MeetupChanged(AttributesChanged Sample.attributes)
    let creation = MeetupCreated(Sample.meetupId, Sample.authorId)

    raises<InvalidOperationException> <@ Meetup.apply Initial change @>
    raises<InvalidOperationException> <@ Meetup.apply Initial MeetupUnpublished @>
    raises<InvalidOperationException> <@ Meetup.apply Initial MeetupRepublished @>
    raises<InvalidOperationException> <@ Meetup.apply Initial MeetupCancelled @>
    raises<InvalidOperationException> <@ Meetup.apply Initial MeetupHeld @>
    raises<InvalidOperationException> <@ Meetup.apply (Existing Sample.draft) creation @>
