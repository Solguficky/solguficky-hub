module Meetups.DomainTests.AccessTests

open Meetups.Domain
open Meetups.TestData
open Swensen.Unquote
open Xunit

[<Fact>]
let ``Command should be allowed for an administrator`` () = test <@ Access.forCommand Sample.administrator = Ok() @>

[<Fact>]
let ``Command should be refused for a viewer without roles`` () =
    test <@ Access.forCommand Sample.ordinary = Error NotAnAdministrator @>

/// ADR-031: автор не является отдельным правом — в срезе он всегда администратор.
/// Без этой проверки правило легко испортить обратно, сверив личность со сходкой.
[<Fact>]
let ``Command should be refused for the author who lost the administrator role`` () =
    let author = Sample.draft |> Meetup.toSnapshot |> _.Author

    test
        <@
            author = Sample.ordinary.IdentityId
            && Access.forCommand Sample.ordinary = Error NotAnAdministrator
        @>

[<Fact>]
let ``Administrator should be recognised among several roles`` () =
    let viewer =
        { Sample.ordinary with
            Roles = Set.singleton Administrator
        }

    test <@ Viewer.isAdministrator viewer @>

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
