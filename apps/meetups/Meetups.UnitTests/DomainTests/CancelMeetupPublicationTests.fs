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
let ``When the worker has already published the meetup expect a refusal`` () =
    // Гонка с воркером: человек видел момент, а сходка уже видима. Успех без
    // события сказал бы «отменено» про опубликованную сходку (PER-457).
    let decision =
        Meetup.decideCancelScheduledPublication (Existing Sample.publishedByWorker)

    test <@ decision = Error TransitionNotAllowed @>

[<Fact>]
let ``When the meetup was published by hand expect the same refusal`` () =
    // Домен не различает, кто опубликовал: отменять поздно в обоих случаях.
    let decision = Meetup.decideCancelScheduledPublication (Existing Sample.published)

    test <@ decision = Error TransitionNotAllowed @>

[<Fact>]
let ``When the published meetup is reached after a conflict expect it is not a safe retry`` () =
    // Тот же ответ на пути PER-78: конфликт версии с воркером не превращается в
    // «цель достигнута», хотя момента у видимой сходки нет.
    test <@ not (Meetup.targetReached MeetupPublicationCancelled (Existing Sample.publishedByWorker)) @>

[<Fact>]
let ``When the hidden meetup without a moment is reached after a conflict expect a safe retry`` () =
    test <@ Meetup.targetReached MeetupPublicationCancelled (Existing Sample.titled) @>

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
