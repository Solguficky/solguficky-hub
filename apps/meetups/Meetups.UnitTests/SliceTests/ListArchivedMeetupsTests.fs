module Meetups.SliceTests.ListArchivedMeetupsTests

open System
open System.Threading.Tasks
open Grpc.Core
open Meetups.Domain
open Meetups.Slices.ListArchivedMeetups
open Meetups.TestData
open Meetups.TestRpc
open Swensen.Unquote
open Xunit

let private deps (read: Viewer -> Task<MeetupSnapshot list>) (today: DateOnly) : Deps =
    {
        Read = read
        Today = fun () -> today
    }

let private request viewer = Meetups.V1.ListArchivedMeetupsRequest(Viewer = viewer)

let private contractViewer () = Meetups.V1.Viewer(IdentityId = "0199c0de-0000-7000-8000-000000000001")

/// Архив — дополнение актуального списка: в него входит то, что оттуда выпало, а
/// планируемая с датой впереди и сходка без даты остаются актуальными.
[<Fact>]
let ``The archive query returns held, cancelled and past meetups only`` () =
    let past =
        { Meetup.toSnapshot Sample.published with
            Title = "Past"
            Schedule = Fixed(Day(DateOnly(2026, 9, 20)))
        }

    let planned =
        { Meetup.toSnapshot Sample.published with
            Title = "Planned"
            Schedule = Fixed(Day(DateOnly(2026, 10, 3)))
        }

    let undated =
        { Meetup.toSnapshot Sample.published with
            Title = "Undated"
            Schedule = NoDate
        }

    let held =
        { Meetup.toSnapshot Sample.held with
            Title = "Held"
        }

    let cancelled =
        { Meetup.toSnapshot Sample.cancelledVisible with
            Title = "Cancelled"
        }

    let read _ =
        Task.FromResult
            [
                past
                planned
                undated
                held
                cancelled
            ]

    let actual =
        execute
            (deps read (DateOnly(2026, 9, 21)))
            {
                Viewer = Sample.ordinary
            }
        |> Async.AwaitTask
        |> Async.RunSynchronously
        |> List.map _.Title

    test <@ actual = [ "Past"; "Held"; "Cancelled" ] @>

/// Архив читают с конца: новейшая дата первой, сходка без даты последней — она не
/// получает вымышленного места среди датированных.
[<Fact>]
let ``The archive query orders dates newest first and keeps undated meetups last`` () =
    let older =
        { Meetup.toSnapshot Sample.published with
            Title = "Older"
            Schedule = Fixed(Day(DateOnly(2026, 9, 19)))
        }

    let newer =
        { Meetup.toSnapshot Sample.published with
            Title = "Newer"
            Schedule = Fixed(Day(DateOnly(2026, 9, 20)))
        }

    let undated =
        { Meetup.toSnapshot Sample.published with
            Title = "Undated"
            Schedule = NoDate
        }

    let held =
        { Meetup.toSnapshot Sample.held with
            Title = "Held"
            Schedule = NoDate
        }

    let read _ = Task.FromResult [ older; undated; held; newer ]

    let actual =
        execute
            (deps read (DateOnly(2026, 9, 21)))
            {
                Viewer = Sample.ordinary
            }
        |> Async.AwaitTask
        |> Async.RunSynchronously
        |> List.map _.Title

    test <@ actual = [ "Newer"; "Older"; "Held" ] @>

/// Долгая интервальная сходка, закончившаяся раньше короткой, не обгоняет её в
/// архиве: порядок решает конец интервала, а не начало (Archive.sortOrder).
[<Fact>]
let ``The archive query orders interval meetups by their end date`` () =
    let interval startDate endDate =
        LocalInterval.create
            {
                Date = startDate
                Time =
                    LocalTime.create (TimeOnly(10, 0))
                    |> Result.defaultWith (fun _ -> failwith "unreachable")
            }
            {
                Date = endDate
                Time =
                    LocalTime.create (TimeOnly(18, 0))
                    |> Result.defaultWith (fun _ -> failwith "unreachable")
            }
        |> Result.defaultWith (fun _ -> failwith "the sample interval ends before it starts")

    let long =
        { Meetup.toSnapshot Sample.published with
            Title = "Long"
            Schedule = Fixed(Interval(interval (DateOnly(2026, 9, 1)) (DateOnly(2026, 9, 10))))
        }

    let short =
        { Meetup.toSnapshot Sample.published with
            Title = "Short"
            Schedule = Fixed(Interval(interval (DateOnly(2026, 9, 15)) (DateOnly(2026, 9, 16))))
        }

    let read _ = Task.FromResult [ long; short ]

    let actual =
        execute
            (deps read (DateOnly(2026, 9, 21)))
            {
                Viewer = Sample.ordinary
            }
        |> Async.AwaitTask
        |> Async.RunSynchronously
        |> List.map _.Title

    test <@ actual = [ "Short"; "Long" ] @>

[<Fact>]
let ``The archive API refuses a missing viewer before reading`` () =
    let read _ = failwith "Read must not be reached"

    let code =
        codeOf (fun () -> Api.handle (deps read (DateOnly(2026, 9, 21))) (Meetups.V1.ListArchivedMeetupsRequest()))

    test <@ code = Some StatusCode.InvalidArgument @>

[<Fact>]
let ``The archive API renders summaries returned by the read`` () =
    let read _ = Task.FromResult [ Meetup.toSnapshot Sample.held ]

    let response =
        (Api.handle (deps read (DateOnly(2026, 9, 21))) (request (contractViewer ()))).GetAwaiter().GetResult()

    test
        <@
            response.Meetups.Count = 1
            && response.Meetups[0].Id = "0199c0de-0000-7000-8000-0000000000f1"
            && response.Meetups[0].Lifecycle = Meetups.V1.MeetupLifecycle.Held
        @>
