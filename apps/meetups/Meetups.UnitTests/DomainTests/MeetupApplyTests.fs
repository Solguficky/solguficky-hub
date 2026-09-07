module Meetups.DomainTests.MeetupApplyTests

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
    let identities =
        [
            identity Sample.draft
            identity Sample.titled
            identity Sample.published
        ]
        |> List.distinct

    test <@ identities = [ Sample.meetupId, Sample.authorId ] @>

[<Fact>]
let ``Apply should leave the lifecycle planned`` () =
    // Переход «состоялась» и отмена в срез не входят: ни одна команда их не даёт.
    test <@ (Meetup.toSnapshot Sample.published).Lifecycle = Planned @>
