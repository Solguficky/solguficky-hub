module Meetups.DomainTests.CancelMeetupTests

open Meetups.Domain
open Meetups.TestData
open Swensen.Unquote
open Xunit

[<Fact>]
let ``When a planned meetup is cancelled expect a MeetupCancelled event`` () =
    test <@ Meetup.decideCancel (Existing Sample.titled) = Ok(Some MeetupCancelled) @>

/// Оси независимы: отмена двигает жизненный цикл и не трогает видимость. Проверяется
/// на опубликованной сходке, а не на черновике: у черновика Hidden совпадает со
/// значением по умолчанию, и тест зеленел бы на реализации, которая прячет
/// отменённую сходку вместе с отменой.
[<Fact>]
let ``When the cancellation is applied expect the visibility and the mark untouched`` () =
    let snapshot =
        Meetup.apply (Existing Sample.published) MeetupCancelled
        |> Meetup.toSnapshot

    let actual = snapshot.Lifecycle, snapshot.Visibility, snapshot.FirstPublishedAt

    test <@ actual = (Cancelled, Visible, Some Sample.fixedNow) @>

[<Fact>]
let ``When the meetup is already cancelled expect no event`` () =
    // Команда сформулирована как целевое состояние: повтор успешен и события не даёт.
    test <@ Meetup.decideCancel (Existing Sample.cancelled) = Ok None @>

[<Fact>]
let ``When the meetup does not exist expect the cancellation is refused`` () =
    test <@ Meetup.decideCancel Initial = Error MeetupNotFound @>

/// Обе конечные стадии оси терминальны (ADR-022): состоявшуюся сходку отменять уже
/// поздно. Отказ переходом, а не успехом без события: сходка не в запрошенном
/// состоянии, и повтором это назвать нельзя.
[<Fact>]
let ``When the meetup already took place expect the cancellation is refused`` () =
    test <@ Meetup.decideCancel (Existing Sample.held) = Error TransitionNotAllowed @>
