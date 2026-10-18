module Meetups.DomainTests.ChangeMeetupAttributesTests

open Meetups.Domain
open Meetups.TestData
open Swensen.Unquote
open Xunit

[<Fact>]
let ``When all five attributes change expect a single MeetupChanged event carrying them`` () =
    let decision =
        Meetup.decideChangeAttributes Sample.attributes (Existing Sample.draft)

    test <@ decision = Ok(MeetupChanged(AttributesChanged Sample.attributes)) @>

[<Fact>]
let ``When the meetup does not exist expect the change is refused`` () =
    let decision = Meetup.decideChangeAttributes Sample.attributes Initial

    test <@ decision = Error MeetupNotFound @>

[<Fact>]
let ``When the change is applied expect every attribute to carry the requested value`` () =
    let snapshot = Meetup.toSnapshot Sample.titled

    let actual =
        snapshot.Title, snapshot.Description, snapshot.Venue, snapshot.Kind, snapshot.CalendarLink

    let expected =
        Sample.attributes.Title,
        Sample.attributes.Description,
        Sample.attributes.Venue,
        Sample.attributes.Kind,
        Sample.attributes.CalendarLink

    test <@ actual = expected @>

[<Fact>]
let ``When the change is applied expect the schedule, the visibility and the publication mark untouched`` () =
    // Проверяется на опубликованной сходке с заданным расписанием, а не на черновике:
    // у черновика все три поля совпадают со значениями по умолчанию, и тест зеленел бы
    // на реализации, которая сбрасывает их при каждой правке атрибутов.
    let scheduled =
        Meetup.apply (Existing Sample.published) (MeetupChanged(ScheduleChanged(Fixed Sample.day)))

    let renamed =
        { Sample.attributes with
            Title = "F# after hours, второй заход"
        }

    let after =
        Meetup.apply (Existing scheduled) (MeetupChanged(AttributesChanged renamed))
        |> Meetup.toSnapshot

    let actual = after.Schedule, after.Visibility, after.FirstPublishedAt, after.Author

    test <@ actual = (Fixed Sample.day, Visible, Some Sample.fixedNow, Sample.authorId) @>

[<Fact>]
let ``When the attributes repeat the current values expect a MeetupChanged event all the same`` () =
    // Пустой diff у потребителя не является поводом уведомления, и подавлять
    // событие домену не за что: решение принимает Notifications по своей реплике.
    let decision =
        Meetup.decideChangeAttributes Sample.attributes (Existing Sample.titled)

    test <@ decision = Ok(MeetupChanged(AttributesChanged Sample.attributes)) @>

[<Fact>]
let ``When the title is emptied expect the change to be accepted`` () =
    // Атрибуты тотальны: пустая строка легитимна, а заголовок обязателен только
    // на переходе к публикации.
    let cleared =
        { Sample.attributes with
            Title = ""
        }

    let snapshot =
        Meetup.apply (Existing Sample.titled) (MeetupChanged(AttributesChanged cleared))
        |> Meetup.toSnapshot

    test <@ snapshot.Title = "" @>

/// Отмена терминальна и закрывает редактирование. Отказ переходом, а не «не
/// найдено»: сходка существует, и у человека на эти два случая разные действия.
[<Fact>]
let ``When the meetup is cancelled expect the change is refused`` () =
    let decision =
        Meetup.decideChangeAttributes Sample.attributes (Existing Sample.cancelled)

    test <@ decision = Error TransitionNotAllowed @>

[<Fact>]
let ``When the title of a published meetup is emptied expect the change to be accepted`` () =
    // I4 остался переходным инвариантом и стоячим не стал (ADR-031, пересмотр
    // 2026-09-21): заголовок обязателен на переходе к публикации, а не в покое.
    // Тест «When the title is emptied» выше проверяет то же на скрытой сходке —
    // и это разные утверждения: стоячий инвариант различал бы их по видимости.
    let cleared =
        { Sample.attributes with
            Title = ""
        }

    let decision = Meetup.decideChangeAttributes cleared (Existing Sample.published)

    let after =
        Meetup.apply (Existing Sample.published) (MeetupChanged(AttributesChanged cleared))
        |> Meetup.toSnapshot

    let actual = decision, after.Title, after.Visibility

    test <@ actual = (Ok(MeetupChanged(AttributesChanged cleared)), "", Visible) @>

[<Fact>]
let ``When the change erases the title of a scheduled meetup expect it is refused like publication`` () =
    // Воркер такую сходку не опубликовал бы и держал бы в голове очереди (PER-457).
    let erased =
        { Sample.attributes with
            Title = "  "
        }

    let decision = Meetup.decideChangeAttributes erased (Existing Sample.scheduled)

    test <@ decision = Error TitleRequiredForPublication @>

[<Fact>]
let ``When the change erases the title of an unscheduled draft expect it is accepted`` () =
    // Без момента пустой заголовок ничего не обещает: полноту проверяет публикация.
    let erased =
        { Sample.attributes with
            Title = ""
        }

    let decision = Meetup.decideChangeAttributes erased (Existing Sample.titled)

    test <@ decision = Ok(MeetupChanged(AttributesChanged erased)) @>

[<Fact>]
let ``When an untitled draft scheduled before the rule changes its venue expect it is accepted`` () =
    // Запрещено стирание, а не пустой заголовок при моменте: иначе застрявший до
    // PER-457 черновик нельзя было бы поправить вовсе.
    let stuck =
        Meetup.apply (Existing Sample.draft) (MeetupPublicationScheduled Sample.later)

    let moved =
        { Sample.attributes with
            Title = ""
            Venue = "Другое место"
        }

    let decision = Meetup.decideChangeAttributes moved (Existing stuck)

    test <@ decision = Ok(MeetupChanged(AttributesChanged moved)) @>

[<Fact>]
let ``When a scheduled meetup is cancelled and its title erased expect the state reason wins`` () =
    let cancelled = Meetup.apply (Existing Sample.scheduled) MeetupCancelled

    let erased =
        { Sample.attributes with
            Title = ""
        }

    test <@ Meetup.decideChangeAttributes erased (Existing cancelled) = Error TransitionNotAllowed @>
