module Meetups.SliceTests.GetMeetupTests

open System.Threading.Tasks
open Grpc.Core
open Meetups.Domain
open Meetups.Slices.GetMeetup
open Meetups.TestData
open Meetups.TestRpc
open Swensen.Unquote
open Xunit

let private contractViewer () = Meetups.V1.Viewer(IdentityId = "0199c0de-0000-7000-8000-000000000001")

let private request () =
    Meetups.V1.GetMeetupRequest(Viewer = contractViewer (), Id = "0199c0de-0000-7000-8000-0000000000f1")

[<Fact>]
let ``The get query returns the read result for its viewer and identifier`` () =
    let calls = ResizeArray<Viewer * MeetupId>()
    let stored = Meetup.toSnapshot Sample.published

    let read viewer id =
        calls.Add(viewer, id)
        Task.FromResult(Some stored)

    let result =
        execute
            read
            {
                Id = Sample.meetupId
                Viewer = Sample.ordinary
            }
        |> Async.AwaitTask
        |> Async.RunSynchronously

    test
        <@
            result = Ok stored
            && calls |> List.ofSeq = [ Sample.ordinary, Sample.meetupId ]
        @>

[<Fact>]
let ``The get query reports a missing meetup as not found`` () =
    let read _ _ = Task.FromResult None

    let result =
        execute
            read
            {
                Id = Sample.meetupId
                Viewer = Sample.ordinary
            }
        |> Async.AwaitTask
        |> Async.RunSynchronously

    test <@ result = Error GetMeetupError.NotFound @>

[<Fact>]
let ``The get API maps a missing meetup to NOT_FOUND`` () =
    let read _ _ = Task.FromResult None
    let code = codeOf (fun () -> Api.handle read (request ()))

    test <@ code = Some StatusCode.NotFound @>

[<Fact>]
let ``The get API refuses a malformed identifier before reading`` () =
    let read _ _ = failwith "Read must not be reached"
    let malformed = request ()
    malformed.Id <- "not-a-uuid"

    let code = codeOf (fun () -> Api.handle read malformed)

    test <@ code = Some StatusCode.InvalidArgument @>
