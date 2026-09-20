/// Один валидный образец на доменный тип: вариации тесты получают переопределением,
/// потому что отличие от нормы и есть суть теста.
///
/// Состояния строятся публичным путём — применением событий из состояния «до».
/// Это то же свойство ядра, которое проверяет срез. Исключение — состояния осей, у
/// которых команды ещё нет: они восстанавливаются из снимка, и у каждого такого
/// образца ниже сказано, почему события не хватило.
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

/// Свежесозданный черновик: пустые тексты, NoDate, Planned, Hidden, версия 1.
let draft = Meetup.apply Initial (MeetupCreated(meetupId, authorId))

/// Черновик с заголовком: состояние, из которого публикация разрешена.
let titled =
    Meetup.apply (Existing draft) (MeetupChanged(AttributesChanged attributes))

/// Опубликованная сходка: видна, отметка первой публикации заполнена fixedNow.
let published = Meetup.apply (Existing titled) (MeetupPublished fixedNow)

/// Отменённая сходка — единственные образцы, собранные не применением события:
/// команды отмены в домене ещё нет, её заводит соседний лист (PER-197). Путь всё
/// равно публичный и настоящий — восстановление из снимка, которым состояние
/// приходит из хранилища. Схема такие строки допускает уже сегодня
/// (meetups_lifecycle_check), поэтому состояние не выдумано тестом: это ровно то,
/// что домен обязан уметь прочитать и отклонить.
let private withLifecycle (lifecycle: MeetupLifecycle) (meetup: Meetup) =
    { Meetup.toSnapshot meetup with
        Lifecycle = lifecycle
    }
    |> Meetup.rehydrate

/// Отменённая скрытая сходка с заголовком: публикация отклоняется переходом, а не
/// полнотой.
let cancelled = titled |> withLifecycle Cancelled

/// Отменённая скрытая сходка без заголовка: на ней видно, что состояние проверяется
/// раньше заголовка и настоящая причина отказа не подменяется.
let cancelledDraft = draft |> withLifecycle Cancelled

/// Отменённая, но уже видимая сходка. Отдельный образец, потому что на ней
/// пересекаются два правила: команда сформулирована как целевое состояние, и сходка
/// в нём уже находится. I5 выигрывает у отмены, и это решение, а не побочный эффект
/// порядка веток, — поэтому у него свой тест.
let cancelledVisible = published |> withLifecycle Cancelled

/// Состоявшаяся сходка: узкое правило PER-195 её публикацию не закрывает.
let held = titled |> withLifecycle Held
