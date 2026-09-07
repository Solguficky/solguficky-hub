/// Раскладка снимка по колонкам таблицы. Проверяется без PostgreSQL, потому что
/// отображение чистое: схема допускает ровно семь сочетаний формы и точности, и
/// промах в любом из них база поймала бы только в рантайме одной из четырёх команд.
module Meetups.InfrastructureTests.MeetupRowTests

open System
open Swensen.Unquote
open Xunit
open Meetups.Domain
open Meetups.Infrastructure
open Meetups.TestData

let private snapshotWith (schedule: Schedule) : MeetupSnapshot =
    { Meetup.toSnapshot Sample.titled with
        Schedule = schedule
    }

let private interval =
    LocalInterval.create
        {
            Date = DateOnly(2026, 10, 3)
            Time = TimeOnly(18, 30)
        }
        {
            Date = DateOnly(2026, 10, 3)
            Time = TimeOnly(21, 0)
        }
    |> Result.defaultWith (fun _ -> failwith "unreachable")

let private dayStart =
    DayStart
        {
            Date = DateOnly(2026, 10, 3)
            Time = TimeOnly(18, 30)
        }

/// Все семь допустимых форм разом: список здесь уместнее семи почти одинаковых
/// тестов, потому что проверяется одно свойство — обратимость.
let private everyForm =
    [
        NoDate
        Tentative Sample.day
        Fixed Sample.day
        Tentative dayStart
        Fixed dayStart
        Tentative(Interval interval)
        Fixed(Interval interval)
    ]

[<Fact>]
let ``Every schedule form survives the round trip through row columns`` () =
    let restored =
        everyForm
        |> List.map (fun schedule ->
            snapshotWith schedule
            |> MeetupRow.ofSnapshot
            |> MeetupRow.toSnapshot
        )

    test <@ restored = List.map snapshotWith everyForm @>

/// Ожидаемая раскладка строится вне цитаты: пустой Nullable боксируется в null, и
/// Unquote, вычисляя `.HasValue` рефлексией, падает на нём вместо того, чтобы
/// показать расхождение. Сравнение записей целиком заодно проверяет все шесть
/// колонок разом, а не по одной.
[<Fact>]
let ``A meetup without a date leaves every schedule column empty`` () =
    let expected: MeetupRow.ScheduleColumns =
        {
            Form = "no_date"
            Precision = null
            StartDate = Nullable()
            StartTime = Nullable()
            EndDate = Nullable()
            EndTime = Nullable()
        }

    test <@ MeetupRow.scheduleColumns NoDate = expected @>

[<Fact>]
let ``A day precision writes the date and leaves the time empty`` () =
    let expected: MeetupRow.ScheduleColumns =
        {
            Form = "tentative"
            Precision = "day"
            StartDate = Nullable(DateOnly(2026, 10, 3))
            StartTime = Nullable()
            EndDate = Nullable()
            EndTime = Nullable()
        }

    test <@ MeetupRow.scheduleColumns (Tentative Sample.day) = expected @>

[<Fact>]
let ``An interval writes all four boundary columns`` () =
    let expected: MeetupRow.ScheduleColumns =
        {
            Form = "fixed"
            Precision = "interval"
            StartDate = Nullable(DateOnly(2026, 10, 3))
            StartTime = Nullable(TimeOnly(18, 30))
            EndDate = Nullable(DateOnly(2026, 10, 3))
            EndTime = Nullable(TimeOnly(21, 0))
        }

    test <@ MeetupRow.scheduleColumns (Fixed(Interval interval)) = expected @>

[<Fact>]
let ``Axes of state are written as the lowercase words the schema checks`` () =
    let draft = MeetupRow.ofSnapshot (Meetup.toSnapshot Sample.draft)
    let published = MeetupRow.ofSnapshot (Meetup.toSnapshot Sample.published)

    let actual =
        draft.Lifecycle, draft.Visibility, draft.FirstPublishedAt, published.Visibility, published.FirstPublishedAt

    let expected = "planned", "hidden", Nullable(), "visible", Nullable Sample.fixedNow

    test <@ actual = expected @>

/// Хвост точнее микросекунды до колонки всё равно не доходит: TIMESTAMPTZ его не
/// хранит. Строка отбрасывает его сама, потому что от неё живут два потребителя —
/// колонки состояния и payload события, — и усечение обязано быть у них общим.
[<Fact>]
let ``A moment finer than the state column is cut to its precision`` () =
    let snapshot =
        { Meetup.toSnapshot Sample.published with
            FirstPublishedAt = Some(Sample.fixedNow.AddTicks 17L)
        }

    let row = MeetupRow.ofSnapshot snapshot

    test <@ row.FirstPublishedAt = Nullable(Sample.fixedNow.AddTicks 10L) @>

/// Строку, которую схема одобрила, а домен прочитать не может, адаптер обязан
/// ронять: подстановка значения по умолчанию превратила бы порчу в правдоподобную
/// сходку и увела бы её дальше по системе.
[<Fact>]
let ``An unknown schedule form is rejected instead of defaulting`` () =
    let row =
        { MeetupRow.ofSnapshot (snapshotWith NoDate) with
            ScheduleForm = "someday"
        }

    raises<exn> <@ MeetupRow.toSnapshot row @>

[<Fact>]
let ``An unknown lifecycle is rejected instead of defaulting`` () =
    let row =
        { MeetupRow.ofSnapshot (snapshotWith NoDate) with
            Lifecycle = "postponed"
        }

    raises<exn> <@ MeetupRow.toSnapshot row @>

[<Fact>]
let ``An interval missing its end is rejected instead of narrowing to a day start`` () =
    let row =
        { MeetupRow.ofSnapshot (snapshotWith (Fixed(Interval interval))) with
            ScheduleEndTime = Nullable()
        }

    raises<exn> <@ MeetupRow.toSnapshot row @>
