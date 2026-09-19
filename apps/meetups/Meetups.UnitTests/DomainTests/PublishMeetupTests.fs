module Meetups.DomainTests.PublishMeetupTests

open Meetups.Domain
open Meetups.TestData
open Swensen.Unquote
open Xunit

[<Fact>]
let ``When the title is empty expect the publication is refused`` () =
    let decision = Meetup.decidePublish Sample.fixedNow (Existing Sample.draft)

    test <@ decision = Error TitleRequiredForPublication @>

[<Fact>]
let ``When the title is only blanks expect the publication is refused`` () =
    let blankTitle =
        { Sample.attributes with
            Title = "   "
        }

    let blank =
        Meetup.apply (Existing Sample.draft) (MeetupChanged(AttributesChanged blankTitle))

    test <@ Meetup.decidePublish Sample.fixedNow (Existing blank) = Error TitleRequiredForPublication @>

[<Fact>]
let ``When the meetup does not exist expect the publication is refused`` () =
    test <@ Meetup.decidePublish Sample.fixedNow Initial = Error MeetupNotFound @>

[<Fact>]
let ``When the title is set expect a MeetupPublished event carrying the supplied instant`` () =
    let decision = Meetup.decidePublish Sample.fixedNow (Existing Sample.titled)

    test <@ decision = Ok(Some(MeetupPublished Sample.fixedNow)) @>

[<Fact>]
let ``When the publication is applied expect the meetup becomes visible and stamped`` () =
    let snapshot = Meetup.toSnapshot Sample.published

    test <@ (snapshot.Visibility, snapshot.FirstPublishedAt) = (Visible, Some Sample.fixedNow) @>

[<Fact>]
let ``When an already visible meetup is published again expect no event`` () =
    // Команда сформулирована как целевое состояние: повтор успешен и события не даёт.
    test <@ Meetup.decidePublish Sample.later (Existing Sample.published) = Ok None @>

[<Fact>]
let ``When the meetup is cancelled expect the publication is refused`` () =
    test <@ Meetup.decidePublish Sample.fixedNow (Existing Sample.cancelled) = Error TransitionNotAllowed @>

/// Порядок проверок наблюдаем: у отменённого черновика нет и заголовка, и оба отказа
/// достижимы. Тест требует именно отказ перехода — иначе настоящая причина пряталась
/// бы за требованием заголовка, а «различимый код» наблюдался бы только тогда, когда
/// заголовок случайно заполнен.
[<Fact>]
let ``When a cancelled meetup has no title expect the refusal to name the transition`` () =
    test <@ Meetup.decidePublish Sample.fixedNow (Existing Sample.cancelledDraft) = Error TransitionNotAllowed @>

/// Отмена закрывает переход к видимости, а не команду как таковую: у уже видимой
/// сходки переходить некуда, и I5 выигрывает. Тест закрепляет именно приоритет —
/// без него порядок веток остался бы случайным, а поведение обнаружилось бы только
/// после того, как соседний лист заведёт отмену, не скрывающую сходку.
[<Fact>]
let ``When a cancelled meetup is already visible expect no event rather than a refusal`` () =
    test <@ Meetup.decidePublish Sample.later (Existing Sample.cancelledVisible) = Ok None @>

/// Узкое правило PER-195: публикацию закрывает отмена, а не любая терминальная
/// стадия. Ретроспективно заведённую прошедшую сходку сообществу показать нужно.
[<Fact>]
let ``When the meetup is held expect the publication is still allowed`` () =
    test <@ Meetup.decidePublish Sample.fixedNow (Existing Sample.held) = Ok(Some(MeetupPublished Sample.fixedNow)) @>

/// Ось видимости не двигает жизненный цикл: у публикации состоявшейся сходки
/// меняется только видимость и отметка.
[<Fact>]
let ``When a held meetup is published expect its lifecycle to stay untouched`` () =
    let snapshot =
        Meetup.apply (Existing Sample.held) (MeetupPublished Sample.fixedNow)
        |> Meetup.toSnapshot

    test <@ (snapshot.Lifecycle, snapshot.Visibility) = (Held, Visible) @>

[<Fact>]
let ``When the publication is applied twice expect the first publication mark to survive`` () =
    let republished =
        Meetup.apply (Existing Sample.published) (MeetupPublished Sample.later)
        |> Meetup.toSnapshot

    test <@ republished.FirstPublishedAt = Some Sample.fixedNow @>
