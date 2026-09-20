module Meetups.DomainTests.ScheduleTests

open System
open Meetups.Domain
open Swensen.Unquote
open Xunit

let private at (year, month, day) (hours, minutes) =
    {
        Date = DateOnly(year, month, day)
        Time =
            LocalTime.create (TimeOnly(hours, minutes))
            |> Result.defaultWith (fun _ -> failwith "the sample time must have minute precision")
    }

[<Fact>]
let ``Local time should reject seconds and fractions`` () =
    test
        <@
            LocalTime.create (TimeOnly(18, 30, 1)) = Error MorePreciseThanMinute
            && LocalTime.create (TimeOnly(18, 30).Add(TimeSpan.FromTicks 1L)) = Error MorePreciseThanMinute
        @>

[<Fact>]
let ``Every local time should expose zero seconds`` () =
    let times =
        [
            for hour in 0..23 do
                for minute in 0..59 -> TimeOnly(hour, minute)
        ]

    test
        <@
            times
            |> List.map LocalTime.create
            |> List.forall (
                function
                | Ok value -> (LocalTime.value value).Second = 0
                | Error _ -> false
            )
        @>

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
