module Meetups.DomainTests.CancelMeetupPublicationTests

open Meetups.Domain
open Meetups.TestData
open Swensen.Unquote
open Xunit

[<Fact>]
let ``When the moment is scheduled expect the cancellation event`` () =
    let decision = Meetup.decideCancelScheduledPublication (Existing Sample.scheduled)

    test <@ decision = Ok(Some MeetupPublicationCancelled) @>

[<Fact>]
let ``When no moment is scheduled expect no event`` () =
    let decision = Meetup.decideCancelScheduledPublication (Existing Sample.titled)

    test <@ decision = Ok None @>

[<Fact>]
let ``When the meetup is visible expect no event`` () =
    // У видимой сходки момента не бывает, поэтому её отмена — повтор целевого
    // состояния: успех без события, а не отказ.
    let decision = Meetup.decideCancelScheduledPublication (Existing Sample.published)

    test <@ decision = Ok None @>

[<Fact>]
let ``When the moment has already passed expect it is still cancelled`` () =
    // Отмена не читает часов: человек передумал до того, как публикация случилась, а
    // гонку с воркером разрешает версия строки, а не проверка времени здесь.
    let past = Sample.fixedNow.AddDays -1.0

    let state =
        { Meetup.toSnapshot Sample.scheduled with
            ScheduledPublishAt = Some past
        }
        |> Meetup.rehydrate
        |> Existing

    let decision = Meetup.decideCancelScheduledPublication state

    test <@ decision = Ok(Some MeetupPublicationCancelled) @>

[<Fact>]
let ``When no meetup exists expect not found`` () =
    let decision = Meetup.decideCancelScheduledPublication Initial

    test <@ decision = Error MeetupNotFound @>
