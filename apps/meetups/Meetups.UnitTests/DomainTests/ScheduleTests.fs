module Meetups.DomainTests.ScheduleTests

open System
open Meetups.Domain
open Swensen.Unquote
open Xunit

let private at (year, month, day) (hours, minutes) =
    {
        Date = DateOnly(year, month, day)
        Time = TimeOnly(hours, minutes)
    }

let private bounds interval = LocalInterval.start interval, LocalInterval.finish interval

[<Fact>]
let ``Interval should be built when the end is later than the start`` () =
    let start = at (2026, 10, 3) (18, 0)
    let finish = at (2026, 10, 3) (21, 0)

    test
        <@
            LocalInterval.create start finish
            |> Result.map bounds = Ok(start, finish)
        @>

[<Fact>]
let ``Interval should be built when the end equals the start`` () =
    let moment = at (2026, 10, 3) (18, 0)

    test
        <@
            LocalInterval.create moment moment
            |> Result.map bounds = Ok(moment, moment)
        @>

[<Fact>]
let ``Interval should be rejected when the end precedes the start`` () =
    let start = at (2026, 10, 3) (21, 0)
    let finish = at (2026, 10, 3) (18, 0)

    test <@ LocalInterval.create start finish = Error IntervalEndsBeforeItStarts @>

[<Fact>]
let ``Interval should compare the date before the time`` () =
    // Вечер третьего и утро четвёртого: по времени суток окончание раньше начала,
    // по моменту — позже. Сравнение по паре, а не по времени, ловится только здесь.
    let start = at (2026, 10, 3) (21, 0)
    let finish = at (2026, 10, 4) (9, 0)

    test
        <@
            LocalInterval.create start finish
            |> Result.map bounds = Ok(start, finish)
        @>

[<Fact>]
let ``Schedule order should put a day before a time and no date last`` () =
    let date = DateOnly(2026, 10, 3)

    let schedules =
        [
            NoDate
            Fixed(DayStart(at (2026, 10, 3) (18, 0)))
            Tentative(Day date)
            Fixed(DayStart(at (2026, 10, 2) (21, 0)))
        ]

    test
        <@
            schedules |> List.sortBy Schedule.order = [
                Fixed(DayStart(at (2026, 10, 2) (21, 0)))
                Tentative(Day date)
                Fixed(DayStart(at (2026, 10, 3) (18, 0)))
                NoDate
            ]
        @>
