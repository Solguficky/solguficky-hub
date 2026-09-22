/// Один валидный образец на доменный тип: вариации тесты получают переопределением,
/// потому что отличие от нормы и есть суть теста.
///
/// Состояния строятся публичным путём — применением событий из состояния «до».
/// Это то же свойство ядра, которое проверяет срез.
module Meetups.TestData.Sample

open System
open Meetups.Domain

let authorId = PersonId(Guid.Parse "0199c0de-0000-7000-8000-000000000001")
let otherAuthorId = PersonId(Guid.Parse "0199c0de-0000-7000-8000-000000000002")
let meetupId = MeetupId(Guid.Parse "0199c0de-0000-7000-8000-0000000000f1")

/// Смотрящий, которому пишущие команды доступны (ADR-031).
let administrator =
    {
        IdentityId = authorId
        Roles = Set.singleton Administrator
    }

/// Тот же человек, но без роли: автор отдельным правом не является, и на этом
/// образце это видно без комментария.
let ordinary =
    {
        IdentityId = authorId
        Roles = Set.empty
    }

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

/// Материал-ссылка: источник хранится тем, чем является, а авторство привязки —
/// внутренним идентификатором прикрепившего, не Telegram-атрибутом.
let materialId = MaterialId(Guid.Parse "0199c0de-0000-7000-8000-0000000000a1")
let otherMaterialId = MaterialId(Guid.Parse "0199c0de-0000-7000-8000-0000000000a2")

let material =
    {
        Id = materialId
        Position = 1
        Title = "Опрос о дате"
        Source = MessageLink "https://t.me/solguficky/42"
        BoundBy = authorId
    }

/// Свежесозданный черновик: пустые тексты, NoDate, Planned, Hidden, версия 1.
let draft = Meetup.apply Initial (MeetupCreated(meetupId, authorId))

/// Черновик с заголовком: состояние, из которого публикация разрешена.
let titled =
    Meetup.apply (Existing draft) (MeetupChanged(AttributesChanged attributes))

/// Опубликованная сходка: видна, отметка первой публикации заполнена fixedNow.
let published = Meetup.apply (Existing titled) (MeetupPublished fixedNow)

/// Отменённые образцы: событие применяется к состоянию «до», как и у остальных.
/// Схема допускала `cancelled` с первой миграции, а команду завёл PER-197.
let cancelled = Meetup.apply (Existing titled) MeetupCancelled

/// Сходка с назначенным моментом отложенной публикации: скрыта, момент в будущем.
/// Состояния «запланирована публикация» не существует — признак выводится из поля.
let scheduled = Meetup.apply (Existing titled) (MeetupPublicationScheduled later)

/// Отменённая скрытая сходка без заголовка: на ней видно, что состояние проверяется
/// раньше заголовка и настоящая причина отказа не подменяется.
let cancelledDraft = Meetup.apply (Existing draft) MeetupCancelled

/// Отменённая, но уже видимая сходка. Отдельный образец, потому что на ней
/// пересекаются два правила: команда сформулирована как целевое состояние, и сходка
/// в нём уже находится. I5 выигрывает у отмены, и это решение, а не побочный эффект
/// порядка веток, — поэтому у него свой тест.
let cancelledVisible = Meetup.apply (Existing published) MeetupCancelled

/// Состоявшаяся сходка: переход заведён PER-229, а публикацию он не закрывает —
/// скрытую состоявшуюся показывают сообществу (PER-195).
let held = Meetup.apply (Existing titled) MeetupHeld

/// Черновик с одним материалом: состояние, на котором видно и повтор по
/// идентификатору материала, и позицию следующего.
let withMaterial = Meetup.apply (Existing titled) (MeetupMaterialAttached material)

/// Отменённая сходка с материалом: на ней проверяется, что повтор прикрепления
/// выигрывает у отмены, а новое прикрепление — нет.
let cancelledWithMaterial = Meetup.apply (Existing withMaterial) MeetupCancelled
