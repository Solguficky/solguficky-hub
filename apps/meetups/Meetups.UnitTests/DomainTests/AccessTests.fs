module Meetups.DomainTests.AccessTests

open Meetups.Domain
open Meetups.TestData
open Swensen.Unquote
open Xunit

[<Fact>]
let ``Command should be allowed for an administrator`` () = test <@ Access.actOnBehalf Sample.administrator = Ok() @>

[<Fact>]
let ``Command should be refused for a viewer without rights`` () =
    test <@ Access.actOnBehalf Sample.ordinary = Error CannotManageMeetups @>

/// ADR-031: автор не является отдельным правом — права ведения сходок ему не заменяет.
/// Без этой проверки правило легко испортить обратно, сверив личность со сходкой.
[<Fact>]
let ``Command should be refused for the author who lost the manage_meetups right`` () =
    let author = Sample.draft |> Meetup.toSnapshot |> _.Author

    test
        <@
            author = Sample.ordinary.IdentityId
            && Access.actOnBehalf Sample.ordinary = Error CannotManageMeetups
        @>

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
                    ]
        }

    test <@ Viewer.canManageMeetups viewer @>

/// Сходки ведёт только `manage_meetups`: ни право хаба, ни управление составом,
/// ни право назначать администраторов его не подразумевают (RFC-016).
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
            ]
            |> List.forall (fun right ->
                let viewer =
                    { Sample.ordinary with
                        Rights = Set.singleton right
                    }

                Access.actOnBehalf viewer = Error CannotManageMeetups
            )
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
let ``A hidden meetup should not be visible to another ordinary viewer`` () =
    let stranger =
        { Sample.ordinary with
            IdentityId = Sample.otherAuthorId
        }

    test <@ not (Access.canView stranger (Meetup.toSnapshot Sample.draft)) @>
