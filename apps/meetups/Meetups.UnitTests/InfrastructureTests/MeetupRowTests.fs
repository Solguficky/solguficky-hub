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

let private minute hours minutes =
    LocalTime.create (TimeOnly(hours, minutes))
    |> Result.defaultWith (fun _ -> failwith "the sample time must have minute precision")

let private snapshotWith (schedule: Schedule) : MeetupSnapshot =
    { Meetup.toSnapshot Sample.titled with
        Schedule = schedule
    }

let private interval =
    LocalInterval.create
        {
            Date = DateOnly(2026, 10, 3)
            Time = minute 18 30
        }
        {
            Date = DateOnly(2026, 10, 3)
            Time = minute 21 0
        }
    |> Result.defaultWith (fun _ -> failwith "unreachable")

let private dayStart =
    DayStart
        {
            Date = DateOnly(2026, 10, 3)
            Time = minute 18 30
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

[<Fact>]
let ``Every schedule writes only minute-precision times`` () =
    let hasZeroSeconds (time: Nullable<TimeOnly>) =
        not time.HasValue
        || time.Value.Ticks % TimeSpan.TicksPerMinute = 0L

    test
        <@
            everyForm
            |> List.map MeetupRow.scheduleColumns
            |> List.forall (fun columns ->
                hasZeroSeconds columns.StartTime
                && hasZeroSeconds columns.EndTime
            )
        @>

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

/// Материалы переживают круг через колонку целиком: оба вида источника, позиция,
/// название и оба поля, указывающие на человека. Порядок коллекции — порядок
/// массива, и он же возвращается чтением.
[<Fact>]
let ``Every material source survives the round trip through the row column`` () =
    let materials =
        [
            Sample.material
            {
                Id = Sample.otherMaterialId
                Position = 2
                Title = "Афиша"
                Source = FileId "AgACAgIAAxkBAAI"
                BoundBy = Sample.otherAuthorId
            }
        ]

    let snapshot =
        { Meetup.toSnapshot Sample.titled with
            Materials = materials
        }

    let restored =
        snapshot
        |> MeetupRow.ofSnapshot
        |> MeetupRow.toSnapshot

    test <@ restored.Materials = materials @>

/// Строку с чужим видом источника адаптер обязан ронять, а не подставлять значение
/// по умолчанию: порча не должна становиться правдоподобным материалом.
[<Fact>]
let ``An unknown material source kind is rejected instead of defaulting`` () =
    let row =
        { MeetupRow.ofSnapshot (Meetup.toSnapshot Sample.withMaterial) with
            Materials =
                """[{"id":"0199c0de-0000-7000-8000-0000000000a1","position":1,"title":"x","source":{"kind":"video_note","value":"y"},"bound_by":"0199c0de-0000-7000-8000-000000000001"}]"""
        }

    raises<exn> <@ MeetupRow.toSnapshot row @>

[<Fact>]
let ``Materials that are not an array are rejected instead of defaulting`` () =
    let row =
        { MeetupRow.ofSnapshot (Meetup.toSnapshot Sample.withMaterial) with
            Materials = """{"id":"0199c0de-0000-7000-8000-0000000000a1"}"""
        }

    raises<exn> <@ MeetupRow.toSnapshot row @>

/// Порча идентификатора внутри элемента — такая же «схема одобрила, домен не
/// прочитал», как неизвестный вид источника, и обязана падать с идентификатором
/// сходки: голое исключение разбора не отличить от сбоя вне строки.
[<Fact>]
let ``A material with a broken identifier is rejected with the meetup id`` () =
    let row =
        { MeetupRow.ofSnapshot (Meetup.toSnapshot Sample.withMaterial) with
            Materials =
                """[{"id":"not-a-uuid","position":1,"title":"x","source":{"kind":"file_id","value":"y"},"bound_by":"0199c0de-0000-7000-8000-000000000001"}]"""
        }

    let thrown =
        try
            MeetupRow.toSnapshot row |> ignore
            None
        with ex ->
            Some ex.Message

    test
        <@
            thrown
            |> Option.exists (fun message -> message.Contains(string row.Id))
        @>
