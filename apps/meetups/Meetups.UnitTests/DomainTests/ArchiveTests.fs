module Meetups.DomainTests.ArchiveTests

open System
open Meetups.Domain
open Meetups.TestData
open Swensen.Unquote
open Xunit

let private today = DateOnly(2026, 9, 21)

let private snapshot (schedule: Schedule) (lifecycle: MeetupLifecycle) =
    { Meetup.toSnapshot Sample.titled with
        Schedule = schedule
        Lifecycle = lifecycle
    }

let private moment date hours minutes =
    {
        Date = date
        Time =
            TimeOnly(hours, minutes)
            |> LocalTime.create
            |> Result.defaultWith (fun _ -> failwith "the sample time is not minute-precise")
    }

/// «Прошедшая» выводится расписанием: без даты и с обсуждаемой датой сходка
/// прошедшей не становится — иначе живая сходка тихо исчезала бы из актуальных.
[<Fact>]
let ``A meetup without a confirmed date never passes`` () =
    test <@ not (Archive.hasPassed today NoDate) @>
    test <@ not (Archive.hasPassed today (Tentative(Day(today.AddDays -7)))) @>
    test <@ not (Archive.hasPassed today (Tentative(DayStart(moment (today.AddDays -7) 18 0)))) @>

/// Граница — календарный день: вчерашняя сходка прошедшая, сегодняшняя и будущая
/// нет. Время из расписания не выдумывается (ADR-022).
[<Fact>]
let ``A fixed day passes only when it is earlier than today`` () =
    test <@ Archive.hasPassed today (Fixed(Day(today.AddDays -1))) @>
    test <@ not (Archive.hasPassed today (Fixed(Day today))) @>
    test <@ not (Archive.hasPassed today (Fixed(Day(today.AddDays 1)))) @>

[<Fact>]
let ``A fixed moment passes by its calendar date`` () =
    test <@ Archive.hasPassed today (Fixed(DayStart(moment (today.AddDays -1) 18 0))) @>
    test <@ not (Archive.hasPassed today (Fixed(DayStart(moment today 0 1)))) @>

/// Интервал держит сходку актуальной до последнего дня: решает дата конца.
[<Fact>]
let ``An interval passes by its end date`` () =
    let interval startDate endDate =
        LocalInterval.create (moment startDate 10 0) (moment endDate 18 0)
        |> Result.defaultWith (fun _ -> failwith "the sample interval ends before it starts")

    test <@ Archive.hasPassed today (Fixed(Interval(interval (today.AddDays -3) (today.AddDays -1)))) @>
    test <@ not (Archive.hasPassed today (Fixed(Interval(interval (today.AddDays -1) today)))) @>
    test <@ not (Archive.hasPassed today (Fixed(Interval(interval today (today.AddDays 2))))) @>

/// Архив целиком: обе конечные стадии жизненного цикла и планируемая прошедшая.
/// Планируемая с датой впереди или без даты остаётся актуальной.
[<Fact>]
let ``A held or cancelled meetup is archived regardless of its schedule`` () =
    test <@ Archive.isArchived today (snapshot (Fixed(Day(today.AddDays 30))) Held) @>
    test <@ Archive.isArchived today (snapshot NoDate Cancelled) @>

[<Fact>]
let ``A planned meetup is archived only when its date has passed`` () =
    test <@ Archive.isArchived today (snapshot (Fixed(Day(today.AddDays -1))) Planned) @>
    test <@ not (Archive.isArchived today (snapshot (Fixed(Day today)) Planned)) @>
    test <@ not (Archive.isArchived today (snapshot NoDate Planned)) @>

/// Архив сортирует по тому же дню, что делает сходку архивной — концом интервала,
/// а не началом. Иначе долгая сходка обгоняла бы недавно закончившуюся короткую,
/// хотя закончилась раньше.
[<Fact>]
let ``An interval orders by its end date, not its start`` () =
    let interval startDate endDate =
        LocalInterval.create (moment startDate 10 0) (moment endDate 18 0)
        |> Result.defaultWith (fun _ -> failwith "the sample interval ends before it starts")

    let long = Fixed(Interval(interval (today.AddDays -20) (today.AddDays -10)))
    let short = Fixed(Interval(interval (today.AddDays -5) (today.AddDays -1)))

    test <@ Archive.sortOrder short > Archive.sortOrder long @>
