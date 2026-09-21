module Meetups.DomainTests.UnpublishMeetupTests

open Meetups.Domain
open Meetups.TestData
open Swensen.Unquote
open Xunit

[<Fact>]
let ``When a visible meetup is unpublished expect a MeetupUnpublished event`` () =
    test <@ Meetup.decideUnpublish (Existing Sample.published) = Ok(Some MeetupUnpublished) @>

/// Снятие двигает только видимость. Отметка первой публикации переживает его
/// намеренно: задним числом её не восстановить, и именно она делает следующую
/// публикацию возвратом, а не первым показом.
[<Fact>]
let ``When the unpublication is applied expect the meetup hidden and the mark kept`` () =
    let snapshot =
        Meetup.apply (Existing Sample.published) MeetupUnpublished
        |> Meetup.toSnapshot

    let actual = snapshot.Visibility, snapshot.Lifecycle, snapshot.FirstPublishedAt

    test <@ actual = (Hidden, Planned, Some Sample.fixedNow) @>

[<Fact>]
let ``When the meetup is already hidden expect no event`` () =
    // Команда сформулирована как целевое состояние: повтор успешен и события не даёт.
    test <@ Meetup.decideUnpublish (Existing Sample.titled) = Ok None @>

[<Fact>]
let ``When the meetup does not exist expect the unpublication is refused`` () =
    test <@ Meetup.decideUnpublish Initial = Error MeetupNotFound @>

/// Отмена закрывает снятие ровно потому же, почему закрывает публикацию: она
/// описывает ход сходки, а не способ её спрятать. Без этого отказа пара «отменить,
/// затем снять» уводила бы сходку туда, откуда её не возвращает ни одна команда —
/// публикацию отменённой скрытой отклоняет соседнее решение, — и извещение об отмене
/// исчезало бы из человеческих чтений навсегда.
[<Fact>]
let ``When a cancelled meetup is visible expect the unpublication is refused`` () =
    let decision = Meetup.decideUnpublish (Existing Sample.cancelledVisible)

    test <@ decision = Error TransitionNotAllowed @>

/// I5 выигрывает у отмены и здесь, ровно как в публикации: у скрытой сходки
/// переходить некуда, и отказывать не в чем. Приоритет закреплён тестом, потому что
/// порядок веток решения наблюдаем снаружи.
[<Fact>]
let ``When a cancelled meetup is already hidden expect no event rather than a refusal`` () =
    test <@ Meetup.decideUnpublish (Existing Sample.cancelled) = Ok None @>

/// Снятие закрывает отмена, а не любая терминальная стадия жизненного цикла:
/// состоявшуюся сходку с публикации снимают так же, как запланированную.
[<Fact>]
let ``When the meetup is held expect the unpublication is still allowed`` () =
    let visible =
        Meetup.apply (Existing Sample.held) (MeetupPublished Sample.fixedNow)

    test <@ Meetup.decideUnpublish (Existing visible) = Ok(Some MeetupUnpublished) @>
