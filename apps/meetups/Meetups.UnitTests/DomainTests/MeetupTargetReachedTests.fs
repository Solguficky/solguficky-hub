module Meetups.DomainTests.MeetupTargetReachedTests

open Meetups.Domain
open Meetups.TestData
open Swensen.Unquote
open Xunit

/// PER-199: расхождение версий ещё не конфликт, если цель команды уже в силе —
/// но только пока переход остаётся допустимым. `targetReached` — единственное
/// место, где это решается для безопасного повтора (`SafeRetry.discriminate`),
/// поэтому у него свой прямой тест, а не только сквозной через `Api.handle`.
[<Fact>]
let ``Matching attributes on a still-editable meetup are a reached target`` () =
    let event = MeetupChanged(AttributesChanged Sample.attributes)

    test <@ Meetup.targetReached event (Existing Sample.titled) = true @>

/// Обнаруженный при ревью дефект: конкурентная отмена не должна прятаться за
/// совпадением полей. `decideChangeAttributes` отклоняет отменённую сходку без
/// исключений (`Meetup.fs`), поэтому «цель уже достигнута» не может быть правдой
/// на отменённой сходке, даже если атрибуты совпали случайно.
[<Fact>]
let ``Matching attributes on a concurrently cancelled meetup are not a reached target`` () =
    let event = MeetupChanged(AttributesChanged Sample.attributes)

    test <@ Meetup.targetReached event (Existing Sample.cancelled) = false @>

[<Fact>]
let ``A matching schedule on a still-editable meetup is a reached target`` () =
    let schedule = Fixed Sample.day

    let scheduled =
        Meetup.apply (Existing Sample.draft) (MeetupChanged(ScheduleChanged schedule))

    test <@ Meetup.targetReached (MeetupChanged(ScheduleChanged schedule)) (Existing scheduled) = true @>

/// Тот же дефект, что и у атрибутов, на второй команде изменения: расписание тоже
/// не участвует в решении `decideSetSchedule` о жизненном цикле, поэтому оно так
/// же легко маскировало бы отменённую concurrently сходку.
[<Fact>]
let ``A matching schedule on a concurrently cancelled meetup is not a reached target`` () =
    let schedule = Fixed Sample.day

    let scheduled =
        Meetup.apply (Existing Sample.draft) (MeetupChanged(ScheduleChanged schedule))

    let cancelledScheduled =
        { Meetup.toSnapshot scheduled with
            Lifecycle = Cancelled
        }
        |> Meetup.rehydrate

    test <@ Meetup.targetReached (MeetupChanged(ScheduleChanged schedule)) (Existing cancelledScheduled) = false @>

/// Регрессия: у переходов отмена уже учтена самими осями (I5 в `decidePublish` и
/// `decideUnpublish`), и `targetReached` это решение не переопределяет — иначе
/// отменённая видимая сходка перестала бы быть безопасным повтором для повторной
/// публикации.
[<Fact>]
let ``A visible meetup is a reached target for publication even when cancelled`` () =
    test <@ Meetup.targetReached (MeetupPublished Sample.fixedNow) (Existing Sample.cancelledVisible) = true @>
