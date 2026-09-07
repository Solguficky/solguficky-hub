/// Один валидный образец на доменный тип: вариации тесты получают переопределением,
/// потому что отличие от нормы и есть суть теста.
///
/// Состояния строятся публичным путём — применением событий из состояния «до».
/// Другого способа получить сходку у теста нет, и это то же свойство ядра, которое
/// проверяет срез.
module Meetups.TestData.Sample

open System
open Meetups.Domain

let authorId = PersonId(Guid.Parse "0199c0de-0000-7000-8000-000000000001")
let otherAuthorId = PersonId(Guid.Parse "0199c0de-0000-7000-8000-000000000002")
let meetupId = MeetupId(Guid.Parse "0199c0de-0000-7000-8000-0000000000f1")

/// Время приходит в домен значением, поэтому тесту достаточно двух моментов и он
/// не зависит от часов машины.
let fixedNow = DateTimeOffset(2026, 9, 7, 18, 30, 0, TimeSpan.Zero)
let later = fixedNow.AddDays 1.0

let attributes =
    {
        Title = "F# after hours"
        Description = "Разбираем вертикальные срезы на живом коде"
        Venue = "Тбилиси, Fabrika"
        Kind = "Митап"
        CalendarLink = "https://calendar.example/f-sharp-after-hours"
    }

let day = Day(DateOnly(2026, 10, 3))

/// Свежесозданный черновик: пустые тексты, NoDate, Planned, Hidden, версия 1.
let draft = Meetup.apply Initial (MeetupCreated(meetupId, authorId))

/// Черновик с заголовком: состояние, из которого публикация разрешена.
let titled =
    Meetup.apply (Existing draft) (MeetupChanged(AttributesChanged attributes))

/// Опубликованная сходка: видна, отметка первой публикации заполнена fixedNow.
let published = Meetup.apply (Existing titled) (MeetupPublished fixedNow)
