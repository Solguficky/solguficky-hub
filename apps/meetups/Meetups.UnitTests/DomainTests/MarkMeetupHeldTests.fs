module Meetups.DomainTests.MarkMeetupHeldTests

open Meetups.Domain
open Meetups.TestData
open Swensen.Unquote
open Xunit

[<Fact>]
let ``When a planned meetup is marked as held expect a MeetupHeld event`` () =
    test <@ Meetup.decideMarkHeld (Existing Sample.titled) = Ok(Some MeetupHeld) @>

/// Оси независимы: переход двигает жизненный цикл и не трогает видимость. Проверяется
/// на опубликованной сходке, а не на черновике: у черновика Hidden совпадает со
/// значением по умолчанию, и тест зеленел бы на реализации, которая прячет
/// состоявшуюся сходку вместе с отметкой.
[<Fact>]
let ``When the held transition is applied expect the visibility and the mark untouched`` () =
    let snapshot =
        Meetup.apply (Existing Sample.published) MeetupHeld
        |> Meetup.toSnapshot

    let actual = snapshot.Lifecycle, snapshot.Visibility, snapshot.FirstPublishedAt

    test <@ actual = (Held, Visible, Some Sample.fixedNow) @>

[<Fact>]
let ``When the meetup is already held expect no event`` () =
    // Команда сформулирована как целевое состояние: повтор успешен и события не даёт.
    test <@ Meetup.decideMarkHeld (Existing Sample.held) = Ok None @>

[<Fact>]
let ``When the meetup does not exist expect the held transition is refused`` () =
    test <@ Meetup.decideMarkHeld Initial = Error MeetupNotFound @>

/// Обе конечные стадии оси терминальны (ADR-022): отмена необратима, и состоявшейся
/// её не перебить — но и отменённую в состоявшуюся не переводят.
[<Fact>]
let ``When the meetup is cancelled expect the held transition is refused`` () =
    test <@ Meetup.decideMarkHeld (Existing Sample.cancelled) = Error TransitionNotAllowed @>
