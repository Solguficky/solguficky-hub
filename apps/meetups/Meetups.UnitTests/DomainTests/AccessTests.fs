module Meetups.DomainTests.AccessTests

open Meetups.Domain
open Meetups.TestData
open Swensen.Unquote
open Xunit

[<Fact>]
let ``Command should be allowed for an administrator`` () = test <@ Access.toCommand Sample.administrator = Ok() @>

[<Fact>]
let ``Command should be refused for a viewer without roles`` () =
    test <@ Access.toCommand Sample.ordinary = Error NotAnAdministrator @>

/// ADR-031: автор не является отдельным правом — в срезе он всегда администратор.
/// Без этой проверки правило легко испортить обратно, сверив личность со сходкой.
[<Fact>]
let ``Command should be refused for the author who lost the administrator role`` () =
    let author = Sample.draft |> Meetup.toSnapshot |> _.Author

    test
        <@
            author = Sample.ordinary.IdentityId
            && Access.toCommand Sample.ordinary = Error NotAnAdministrator
        @>

[<Fact>]
let ``Administrator should be recognised among several roles`` () =
    let viewer =
        { Sample.ordinary with
            Roles = Set.singleton Administrator
        }

    test <@ Viewer.isAdministrator viewer @>
