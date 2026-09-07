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
