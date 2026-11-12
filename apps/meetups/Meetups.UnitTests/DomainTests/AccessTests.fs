module Meetups.DomainTests.AccessTests

open Meetups.Domain
open Meetups.TestData
open Swensen.Unquote
open Xunit

let private draft = Some(Meetup.toSnapshot Sample.draft)

[<Fact>]
let ``Command should be allowed for an administrator`` () =
    test <@ Access.actOnBehalf Sample.administrator draft = Ok() @>

/// Администратор ведёт и сходку, которой нет: «нет сходки» он узнаёт от домена.
[<Fact>]
let ``Command should be allowed for an administrator even without a meetup`` () =
    test <@ Access.actOnBehalf Sample.administrator None = Ok() @>

[<Fact>]
let ``Command should be refused for a viewer without rights`` () =
    test <@ Access.actOnBehalf Sample.ordinary draft = Error CannotActOnMeetup @>

/// ADR-031: автор не является отдельным правом. Автор в составе, но потерявший
/// `organize_meetups`, командовать не может, оставаясь в составе.
[<Fact>]
let ``Command should be refused for a roster member who lost the organize_meetups right`` () =
    let author = Sample.draft |> Meetup.toSnapshot |> _.Author

    test
        <@
            author = Sample.ordinary.IdentityId
            && List.contains author (Meetup.toSnapshot Sample.draft).Organizers
            && Access.actOnBehalf Sample.ordinary draft = Error CannotActOnMeetup
        @>

[<Fact>]
let ``Command should be allowed for a roster member who holds the organize_meetups right`` () =
    test <@ Access.actOnBehalf Sample.authorOrganizer draft = Ok() @>

[<Fact>]
let ``Command should be allowed for an appointed co-organizer`` () =
    test <@ Access.actOnBehalf Sample.coOrganizer (Some(Meetup.toSnapshot Sample.withCoOrganizer)) = Ok() @>

/// Право без записи в составе власти над чужой сходкой не даёт.
[<Fact>]
let ``Command should be refused for a right holder outside the roster`` () =
    test <@ Access.actOnBehalf Sample.stranger draft = Error CannotActOnMeetup @>

/// Чужая и отсутствующая сходка для не-администратора — один и тот же отказ.
[<Fact>]
let ``A foreign and a missing meetup should give the same refusal`` () =
    test <@ Access.actOnBehalf Sample.stranger draft = Access.actOnBehalf Sample.stranger None @>

[<Fact>]
let ``Manage meetups should be recognised among several rights`` () =
    let viewer =
        { Sample.ordinary with
            Rights =
                Set.ofList
                    [
                        AccessHub
                        PlaceBids
                        ManageMembers
                        AdmitBidders
                        ManageMeetups
                        GrantAdmins
                        RunAuctions
                    ]
        }

    test <@ Viewer.canManageMeetups viewer @>

/// Ни одно право, кроме `manage_meetups` и `organize_meetups`, сходку не ведёт, а
/// `organize_meetups` ведёт её только из состава (RFC-016, ADR-076).
[<Fact>]
let ``Command should be refused for a viewer holding only another right`` () =
    test
        <@
            [
                AccessHub
                PlaceBids
                ManageMembers
                AdmitBidders
                GrantAdmins
                RunAuctions
                OrganizeMeetups
            ]
            |> List.forall (fun right ->
                let viewer =
                    { Sample.ordinary with
                        Rights = Set.singleton right
                    }

                // Автор в составе, у него одно право: команды открывает только
                // `organize_meetups`.
                (Access.actOnBehalf viewer draft = Ok()) = (right = OrganizeMeetups)
            )
        @>

[<Fact>]
let ``Creating should be allowed for the organize_meetups and manage_meetups holders only`` () =
    test
        <@
            Access.mayCreate Sample.authorOrganizer
            && Access.mayCreate Sample.administrator
            && not (Access.mayCreate Sample.ordinary)
        @>

[<Fact>]
let ``Relations resting on a right map to that right and the organizer relation to none`` () =
    test
        <@
            Access.rightsFor (
                Set.ofList
                    [
                        CommunityAdministrator
                        AuctionRunner
                        Organizer
                    ]
            ) = Set.ofList [ ManageMeetups; RunAuctions ]
            && Access.rightsFor (Set.singleton Organizer) = Set.empty
        @>

[<Fact>]
let ``A published meetup should be visible to the community`` () =
    test <@ Access.canView Sample.ordinary (Meetup.toSnapshot Sample.published) @>

[<Fact>]
let ``A hidden meetup should be visible to its author`` () =
    test <@ Access.canView Sample.ordinary (Meetup.toSnapshot Sample.draft) @>

[<Fact>]
let ``A hidden meetup should be visible to any administrator`` () =
    let otherAdministrator =
        { Sample.administrator with
            IdentityId = Sample.otherAuthorId
        }

    test <@ Access.canView otherAdministrator (Meetup.toSnapshot Sample.draft) @>

[<Fact>]
let ``A hidden meetup should be visible to a person in its roster`` () =
    test <@ Access.canView Sample.coOrganizer (Meetup.toSnapshot Sample.withCoOrganizer) @>

/// Автор, вышедший из состава, читать свою сходку может (ADR-076, п. 9).
[<Fact>]
let ``A hidden meetup should stay visible to the author who left the roster`` () =
    let left =
        Meetup.apply (Existing Sample.withCoOrganizer) (MeetupOrganizerDismissed Sample.authorId)
        |> Meetup.toSnapshot

    test <@ Access.canView Sample.ordinary left @>

[<Fact>]
let ``A hidden meetup should not be visible to another ordinary viewer`` () =
    let stranger =
        { Sample.ordinary with
            IdentityId = Sample.otherAuthorId
        }

    test <@ not (Access.canView stranger (Meetup.toSnapshot Sample.draft)) @>

/// Выход опирается на запись в составе, а не на право.
[<Fact>]
let ``Leaving should be allowed for a roster member who lost the right`` () =
    test <@ Access.mayLeave Sample.ordinary draft = Ok() @>

[<Fact>]
let ``Leaving should be refused for a stranger who cannot read the meetup`` () =
    test <@ Access.mayLeave Sample.stranger draft = Error CannotActOnMeetup @>

[<Fact>]
let ``Leaving should be refused for a stranger when the meetup is missing`` () =
    test <@ Access.mayLeave Sample.stranger None = Error CannotActOnMeetup @>

[<Fact>]
let ``Leaving should be a no-op success for a stranger who reads a published meetup`` () =
    test <@ Access.mayLeave Sample.stranger (Some(Meetup.toSnapshot Sample.published)) = Ok() @>
