/// Восстановление состояния из снимка. Свойство обратимости проверяется здесь,
/// потому что от него зависит вся запись: агрегат, собранный из строки таблицы,
/// обязан быть неотличим от собранного применением событий.
module Meetups.DomainTests.MeetupRehydrateTests

open Swensen.Unquote
open Xunit
open Meetups.Domain
open Meetups.TestData

[<Fact>]
let ``A snapshot restores into the very meetup it was taken from`` () =
    let restored =
        [
            Sample.draft
            Sample.titled
            Sample.published
        ]
        |> List.map (Meetup.toSnapshot >> Meetup.rehydrate)

    test
        <@
            restored = [
                Sample.draft
                Sample.titled
                Sample.published
            ]
        @>

[<Fact>]
let ``A missing row restores into the state where the meetup does not exist yet`` () =
    test <@ Meetup.restore None = Initial @>

[<Fact>]
let ``A present row restores into an existing meetup`` () =
    let snapshot = Meetup.toSnapshot Sample.titled

    test <@ Meetup.restore (Some snapshot) = Existing Sample.titled @>

/// Восстановленное состояние остаётся полноценным входом решений: версия и оси
/// приезжают из снимка, поэтому команда поверх него отклоняется и принимается ровно
/// так же, как поверх состояния, собранного событиями.
[<Fact>]
let ``A decision over a restored meetup matches the decision over the original`` () =
    let restored =
        Meetup.toSnapshot Sample.published
        |> Meetup.rehydrate

    test
        <@
            Meetup.decidePublish Sample.later (Existing restored) = Ok None
            && Meetup.decideCreateDraft Sample.otherAuthorId Sample.meetupId (Existing restored) = Error
                DraftBelongsToAnotherAuthor
        @>
