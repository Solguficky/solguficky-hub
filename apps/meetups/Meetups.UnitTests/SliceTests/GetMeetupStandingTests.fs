module Meetups.SliceTests.GetMeetupStandingTests

open System.Threading.Tasks
open Grpc.Core
open Meetups.Domain
open Meetups.Slices.GetMeetupStanding
open Meetups.TestData
open Meetups.TestRpc
open Swensen.Unquote
open Xunit

let private load found : MeetupId -> Task<MeetupSnapshot option> =
    fun _ -> Task.FromResult(Some(Meetup.toSnapshot found))

let private missing: MeetupId -> Task<MeetupSnapshot option> =
    fun _ -> Task.FromResult None

let private request () = Meetups.V1.GetMeetupStandingRequest(Id = "0199c0de-0000-7000-8000-0000000000f1")

let private answer (load: MeetupId -> Task<MeetupSnapshot option>) =
    (Api.handle load (request ())).GetAwaiter().GetResult()

/// Скрытая сходка отвечает тем же путём, что видимая: человека в запросе нет, и
/// видимость здесь — данные ответа, а не правило отказа.
[<Fact>]
let ``The standing read answers a hidden meetup with its state rather than a refusal`` () =
    let hidden = answer (load Sample.titled)
    let visible = answer (load Sample.published)

    test
        <@
            hidden.Visibility = Meetups.V1.MeetupVisibility.Hidden
            && hidden.Lifecycle = Meetups.V1.MeetupLifecycle.Planned
            && visible.Visibility = Meetups.V1.MeetupVisibility.Visible
        @>

[<Fact>]
let ``The standing read carries a cancelled lifecycle`` () =
    let cancelled = answer (load Sample.cancelledVisible)

    test <@ cancelled.Lifecycle = Meetups.V1.MeetupLifecycle.Cancelled @>

[<Fact>]
let ``The standing read reports a missing meetup as NOT_FOUND and a malformed id as INVALID_ARGUMENT`` () =
    let absent = codeOf (fun () -> Api.handle missing (request ()))

    let malformed =
        codeOf (fun () -> Api.handle missing (Meetups.V1.GetMeetupStandingRequest(Id = "not-a-uuid")))

    test
        <@
            absent = Some StatusCode.NotFound
            && malformed = Some StatusCode.InvalidArgument
        @>
