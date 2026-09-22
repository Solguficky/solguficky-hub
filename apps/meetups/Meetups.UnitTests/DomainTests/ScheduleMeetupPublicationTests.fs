module Meetups.DomainTests.ScheduleMeetupPublicationTests

open Meetups.Domain
open Meetups.TestData
open Swensen.Unquote
open Xunit

[<Fact>]
let ``When the meetup is a hidden draft expect the moment is scheduled`` () =
    let decision =
        Meetup.decideSchedulePublication Sample.fixedNow Sample.later (Existing Sample.titled)

    test <@ decision = Ok(Some(MeetupPublicationScheduled Sample.later)) @>

[<Fact>]
let ``When the same moment is scheduled again expect no event`` () =
    let decision =
        Meetup.decideSchedulePublication Sample.fixedNow Sample.later (Existing Sample.scheduled)

    test <@ decision = Ok None @>

[<Fact>]
let ``When the same moment is scheduled again after it has passed expect no event`` () =
    // Воркер ещё не забрал уже наступивший момент, а повтор той же команды не
    // должен отвечать отказом «время прошло»: I5 проверяется раньше значения.
    let past = Sample.fixedNow.AddMinutes -1.0

    let overdue =
        Meetup.apply (Existing Sample.titled) (MeetupPublicationScheduled past)

    let decision =
        Meetup.decideSchedulePublication Sample.fixedNow past (Existing overdue)

    test <@ decision = Ok None @>

[<Fact>]
let ``When another moment is scheduled expect the state is replaced by an event`` () =
    let moved = Sample.later.AddHours 2.0

    let decision =
        Meetup.decideSchedulePublication Sample.fixedNow moved (Existing Sample.scheduled)

    test <@ decision = Ok(Some(MeetupPublicationScheduled moved)) @>

[<Fact>]
let ``When the moment equals now expect it is refused as already past`` () =
    // Равенство — уже опоздание: назначить публикацию на текущее мгновение значит
    // просить воркер опубликовать её задним числом.
    let decision =
        Meetup.decideSchedulePublication Sample.fixedNow Sample.fixedNow (Existing Sample.titled)

    test <@ decision = Error PublicationMomentInThePast @>

[<Fact>]
let ``When the moment has passed expect it is refused as already past`` () =
    let past = Sample.fixedNow.AddMinutes -1.0

    let decision =
        Meetup.decideSchedulePublication Sample.fixedNow past (Existing Sample.titled)

    test <@ decision = Error PublicationMomentInThePast @>

[<Fact>]
let ``When the meetup is visible expect the moment is refused by the state`` () =
    let decision =
        Meetup.decideSchedulePublication Sample.fixedNow Sample.later (Existing Sample.published)

    test <@ decision = Error TransitionNotAllowed @>

[<Fact>]
let ``When the meetup is cancelled expect the moment is refused by the state`` () =
    let decision =
        Meetup.decideSchedulePublication Sample.fixedNow Sample.later (Existing Sample.cancelled)

    test <@ decision = Error TransitionNotAllowed @>

[<Fact>]
let ``When the meetup is cancelled and the moment is in the past expect the state reason wins`` () =
    // Порядок проверок наблюдаем снаружи, поэтому зафиксирован: отменённая сходка
    // отвечает отказом состояния, а не «время прошло», иначе настоящая причина
    // отказа пряталась бы за значением, которое человек уже не изменит.
    let past = Sample.fixedNow.AddDays -1.0

    let decision =
        Meetup.decideSchedulePublication Sample.fixedNow past (Existing Sample.cancelled)

    test <@ decision = Error TransitionNotAllowed @>

[<Fact>]
let ``When the meetup took place expect the moment is still scheduled`` () =
    // Ретроспективно заведённую состоявшуюся сходку показывают сообществу;
    // назначение закрывают видимость и отмена, а не жизненный цикл.
    let decision =
        Meetup.decideSchedulePublication Sample.fixedNow Sample.later (Existing Sample.held)

    test <@ decision = Ok(Some(MeetupPublicationScheduled Sample.later)) @>

[<Fact>]
let ``When no meetup exists expect not found`` () =
    let decision = Meetup.decideSchedulePublication Sample.fixedNow Sample.later Initial

    test <@ decision = Error MeetupNotFound @>
