/// Состав организаторов (ADR-076): создание кладёт автора, назначение, снятие и
/// выход — целевые состояния с инвариантами п. 6.
module Meetups.DomainTests.MeetupOrganizersTests

open Meetups.Domain
open Meetups.TestData
open Swensen.Unquote
open Xunit

let private roster state =
    match state with
    | Existing meetup -> (Meetup.toSnapshot meetup).Organizers
    | Initial -> []

let private withoutAuthor =
    Meetup.apply (Existing Sample.withCoOrganizer) (MeetupOrganizerDismissed Sample.authorId)

[<Fact>]
let ``A new meetup has its author as the only organizer`` () =
    test <@ roster (Existing Sample.draft) = [ Sample.authorId ] @>

[<Fact>]
let ``Appointing adds the person at the end of the roster`` () =
    test
        <@
            roster (Existing Sample.withCoOrganizer) = [
                Sample.authorId
                Sample.coOrganizerId
            ]
        @>

[<Fact>]
let ``Appointing a person who is already in the roster gives no event`` () =
    test <@ Meetup.decideAppointOrganizer Sample.authorId (Existing Sample.draft) = Ok None @>

[<Fact>]
let ``Appointing into a missing meetup is not found`` () =
    test <@ Meetup.decideAppointOrganizer Sample.coOrganizerId Initial = Error RosterError.MeetupNotFound @>

[<Fact>]
let ``Appointing into a cancelled meetup is refused`` () =
    test
        <@
            Meetup.decideAppointOrganizer Sample.coOrganizerId (Existing Sample.cancelled) = Error
                RosterError.TransitionNotAllowed
        @>

/// Повтор целевого состояния идёт раньше отмены: человек уже в составе отменённой.
[<Fact>]
let ``Appointing a member of a cancelled meetup is still a repeat`` () =
    test <@ Meetup.decideAppointOrganizer Sample.authorId (Existing Sample.cancelled) = Ok None @>

[<Fact>]
let ``A new person is appointed with one event`` () =
    test
        <@
            Meetup.decideAppointOrganizer Sample.coOrganizerId (Existing Sample.draft) = Ok(
                Some(MeetupOrganizerAppointed Sample.coOrganizerId)
            )
        @>

[<Fact>]
let ``Dismissing a person who is not in the roster gives no event`` () =
    test <@ Meetup.decideDismissOrganizer Sample.coOrganizerId (Existing Sample.draft) = Ok None @>

[<Fact>]
let ``A co-organizer is dismissed with one event`` () =
    test
        <@
            Meetup.decideDismissOrganizer Sample.coOrganizerId (Existing Sample.withCoOrganizer) = Ok(
                Some(MeetupOrganizerDismissed Sample.coOrganizerId)
            )
        @>

/// Снимает только администратор (ADR-076, дополнение 2026-11-13 к п. 6), поэтому
/// защиты автора у снятия нет: право решает срез до загрузки.
[<Fact>]
let ``The author is dismissed like anyone else`` () =
    test
        <@
            Meetup.decideDismissOrganizer Sample.authorId (Existing Sample.withCoOrganizer) = Ok(
                Some(MeetupOrganizerDismissed Sample.authorId)
            )
        @>

[<Fact>]
let ``Dismissing an author who already left is a repeat`` () =
    test <@ Meetup.decideDismissOrganizer Sample.authorId (Existing withoutAuthor) = Ok None @>

/// Инвариант последнего в составе держит только выход: снимающий — администратор.
[<Fact>]
let ``The last person in the roster is dismissed`` () =
    test
        <@
            Meetup.decideDismissOrganizer Sample.coOrganizerId (Existing withoutAuthor) = Ok(
                Some(MeetupOrganizerDismissed Sample.coOrganizerId)
            )
        @>

[<Fact>]
let ``Dismissing from a missing meetup is not found`` () =
    test <@ Meetup.decideDismissOrganizer Sample.coOrganizerId Initial = Error RosterError.MeetupNotFound @>

[<Fact>]
let ``An author can leave while a co-organizer stays`` () =
    test
        <@
            Meetup.decideLeaveOrganizers false Sample.authorId (Existing Sample.withCoOrganizer) = Ok(
                Some(MeetupOrganizerDismissed Sample.authorId)
            )
        @>

[<Fact>]
let ``The last person in the roster cannot leave but an administrator can`` () =
    test
        <@
            Meetup.decideLeaveOrganizers false Sample.authorId (Existing Sample.draft) = Error RosterError.LastOrganizer
            && Meetup.decideLeaveOrganizers true Sample.authorId (Existing Sample.draft) = Ok(
                Some(MeetupOrganizerDismissed Sample.authorId)
            )
        @>

[<Fact>]
let ``Leaving when not in the roster gives no event`` () =
    test <@ Meetup.decideLeaveOrganizers false Sample.coOrganizerId (Existing Sample.draft) = Ok None @>

/// Выход остаётся открытым в отменённой сходке: закрыто только назначение.
[<Fact>]
let ``Leaving a cancelled meetup is allowed`` () =
    let cancelledWithTwo =
        Meetup.apply (Existing Sample.withCoOrganizer) MeetupCancelled

    test
        <@
            Meetup.decideLeaveOrganizers false Sample.authorId (Existing cancelledWithTwo) = Ok(
                Some(MeetupOrganizerDismissed Sample.authorId)
            )
        @>

[<Fact>]
let ``Roster events raise the version by one`` () =
    test <@ (Meetup.toSnapshot Sample.withCoOrganizer).Version = (Meetup.toSnapshot Sample.draft).Version + 1L @>

[<Fact>]
let ``Target reached follows the roster`` () =
    test
        <@
            Meetup.targetReached (MeetupOrganizerAppointed Sample.coOrganizerId) (Existing Sample.withCoOrganizer)
            && not (Meetup.targetReached (MeetupOrganizerAppointed Sample.coOrganizerId) (Existing Sample.draft))
            && Meetup.targetReached (MeetupOrganizerDismissed Sample.coOrganizerId) (Existing Sample.draft)
            && not (Meetup.targetReached (MeetupOrganizerDismissed Sample.authorId) (Existing Sample.draft))
        @>
