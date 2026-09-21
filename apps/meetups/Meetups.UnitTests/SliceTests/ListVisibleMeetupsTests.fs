module Meetups.SliceTests.ListVisibleMeetupsTests

open System
open System.Threading.Tasks
open Grpc.Core
open Meetups.Domain
open Meetups.Slices.ListVisibleMeetups
open Meetups.TestData
open Meetups.TestRpc
open Swensen.Unquote
open Xunit

/// День сообщества приходит значением, поэтому тесту не нужны ни часы, ни часовой
/// пояс: он подставляет тот же день, что и продуктовое чтение.
let private deps (read: Viewer -> Task<MeetupSnapshot list>) (today: DateOnly) : Deps =
    {
        Read = read
        Today = fun () -> today
    }

let private request viewer = Meetups.V1.ListVisibleMeetupsRequest(Viewer = viewer)

let private contractViewer () = Meetups.V1.Viewer(IdentityId = "0199c0de-0000-7000-8000-000000000001")

[<Fact>]
let ``The list query returns the read result for its viewer`` () =
    let calls = ResizeArray<Viewer>()

    let read viewer =
        calls.Add viewer
        Task.FromResult [ Meetup.toSnapshot Sample.published ]

    let result =
        execute
            (deps read (DateOnly(2026, 9, 21)))
            {
                Viewer = Sample.ordinary
            }
        |> Async.AwaitTask
        |> Async.RunSynchronously

    test
        <@
            result = [ Meetup.toSnapshot Sample.published ]
            && calls |> List.ofSeq = [ Sample.ordinary ]
        @>

[<Fact>]
let ``The list query orders dated meetups before meetups without a date`` () =
    let dated =
        { Meetup.toSnapshot Sample.published with
            Title = "Dated"
            Schedule = Fixed(Day(DateOnly(2026, 10, 3)))
        }

    let undated =
        { Meetup.toSnapshot Sample.published with
            Title = "Undated"
            Schedule = NoDate
        }

    let read _ = Task.FromResult [ undated; dated ]

    let actual =
        execute
            (deps read (DateOnly(2026, 10, 1)))
            {
                Viewer = Sample.ordinary
            }
        |> Async.AwaitTask
        |> Async.RunSynchronously
        |> List.map _.Title

    test <@ actual = [ "Dated"; "Undated" ] @>

/// Критерий приёмки: состоявшаяся, отменённая и прошедшая не показываются среди
/// актуальных. Прошедшая определяется расписанием и днём сообщества, а не командой:
/// строка остаётся Planned и в архив попадает чтением.
[<Fact>]
let ``The list query drops held, cancelled and past meetups`` () =
    let past =
        { Meetup.toSnapshot Sample.published with
            Title = "Past"
            Schedule = Fixed(Day(DateOnly(2026, 9, 20)))
        }

    let today =
        { Meetup.toSnapshot Sample.published with
            Title = "Today"
            Schedule = Fixed(Day(DateOnly(2026, 9, 21)))
        }

    let held =
        { Meetup.toSnapshot Sample.held with
            Title = "Held"
        }

    let cancelled =
        { Meetup.toSnapshot Sample.cancelledVisible with
            Title = "Cancelled"
        }

    let read _ = Task.FromResult [ past; today; held; cancelled ]

    let actual =
        execute
            (deps read (DateOnly(2026, 9, 21)))
            {
                Viewer = Sample.ordinary
            }
        |> Async.AwaitTask
        |> Async.RunSynchronously
        |> List.map _.Title

    test <@ actual = [ "Today" ] @>

[<Fact>]
let ``The list API refuses a missing viewer before reading`` () =
    let read _ = failwith "Read must not be reached"

    let code =
        codeOf (fun () -> Api.handle (deps read (DateOnly(2026, 9, 21))) (Meetups.V1.ListVisibleMeetupsRequest()))

    test <@ code = Some StatusCode.InvalidArgument @>

[<Fact>]
let ``The list API renders summaries returned by the read`` () =
    let read _ = Task.FromResult [ Meetup.toSnapshot Sample.published ]

    let response =
        (Api.handle (deps read (DateOnly(2026, 9, 21))) (request (contractViewer ()))).GetAwaiter().GetResult()

    test
        <@
            response.Meetups.Count = 1
            && response.Meetups[0].Id = "0199c0de-0000-7000-8000-0000000000f1"
            && response.Meetups[0].Title = Sample.attributes.Title
            && response.Meetups[0].Visibility = Meetups.V1.MeetupVisibility.Visible
        @>
