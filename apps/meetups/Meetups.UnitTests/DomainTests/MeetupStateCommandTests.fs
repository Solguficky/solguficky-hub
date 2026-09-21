module Meetups.DomainTests.MeetupStateCommandTests

open Meetups.Domain
open Meetups.TestData
open Swensen.Unquote
open Xunit

[<Fact>]
let ``Unpublishing a visible meetup emits its own event and hides it`` () =
    test <@ Meetup.decideUnpublish (Existing published) = Ok(Some MeetupUnpublished) @>

    let snapshot = Meetup.apply (Existing published) MeetupUnpublished |> Meetup.toSnapshot

    test <@ snapshot.Visibility = Hidden && snapshot.FirstPublishedAt = Some fixedNow @>

[<Fact>]
let ``Unpublishing a hidden meetup is idempotent`` () =
    test <@ Meetup.decideUnpublish (Existing titled) = Ok None @>

[<Fact>]
let ``Returning an unpublished meetup emits a republished event`` () =
    let hidden = Meetup.apply (Existing published) MeetupUnpublished

    test <@ Meetup.decidePublish later (Existing hidden) = Ok(Some MeetupRepublished) @>

    let snapshot = Meetup.apply (Existing hidden) MeetupRepublished |> Meetup.toSnapshot

    test <@ snapshot.Visibility = Visible && snapshot.FirstPublishedAt = Some fixedNow @>

[<Fact>]
let ``Cancelling a planned meetup emits its own event and is idempotent`` () =
    test <@ Meetup.decideCancel (Existing published) = Ok(Some MeetupCancelled) @>

    let cancelled = Meetup.apply (Existing published) MeetupCancelled
    let snapshot = Meetup.toSnapshot cancelled

    test <@ snapshot.Lifecycle = Cancelled && snapshot.Visibility = Visible @>
    test <@ Meetup.decideCancel (Existing cancelled) = Ok None @>

[<Fact>]
let ``A cancelled meetup cannot be edited, republished, or restored`` () =
    let hidden = Meetup.apply (Existing published) MeetupUnpublished
    let cancelled = Meetup.apply (Existing hidden) MeetupCancelled

    test <@ Meetup.decideChangeAttributes attributes (Existing cancelled) = Error TransitionNotAllowed @>
    test <@ Meetup.decideSetSchedule NoDate (Existing cancelled) = Error TransitionNotAllowed @>
    test <@ Meetup.decidePublish later (Existing cancelled) = Error TransitionNotAllowed @>
    test <@ Meetup.decideCancel (Existing cancelled) = Ok None @>
