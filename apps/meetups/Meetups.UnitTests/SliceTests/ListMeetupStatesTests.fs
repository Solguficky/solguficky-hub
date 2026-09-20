module Meetups.SliceTests.ListMeetupStatesTests

open System
open System.Threading.Tasks
open Grpc.Core
open Meetups.Domain
open Meetups.Infrastructure
open Meetups.Slices.ListMeetupStates
open Meetups.TestData
open Meetups.TestRpc
open Swensen.Unquote
open Xunit

/// Ключи различаются только хвостом: порядку обхода больше ничего не нужно, а
/// читаемый номер показывает в падении, на какой строке страница разошлась.
let private key (n: int) = MeetupId(Guid.Parse("0199c0de-0000-7000-8000-" + n.ToString "D12"))

let private snapshotAt n =
    { Meetup.toSnapshot Sample.published with
        Id = key n
    }

let private snapshots count = [ 1..count ] |> List.map snapshotAt

let private pageOf rows : MeetupReading.StatesPage =
    {
        Snapshots = rows
        ConsistentAt = Sample.fixedNow
    }

let private returning rows _ _ = Task.FromResult(pageOf rows)

let private run read after size =
    execute
        read
        {
            After = after
            Size = size
        }
    |> Async.AwaitTask
    |> Async.RunSynchronously

let private request () = Meetups.V1.ListMeetupStatesRequest()

let private handled read request = (Api.handle read request).GetAwaiter().GetResult()

[<Fact>]
let ``The query asks the read for one row beyond the page size`` () =
    let asked = ResizeArray<MeetupId option * int>()

    let read after limit =
        asked.Add(after, limit)
        Task.FromResult(pageOf [])

    run read (Some(key 7)) 10 |> ignore

    test <@ asked |> List.ofSeq = [ Some(key 7), 11 ] @>

[<Fact>]
let ``The page returns only the rows that were asked for`` () =
    let page = run (returning (snapshots 3)) None 2
    let ids = page.Snapshots |> List.map _.Id

    test <@ ids = [ key 1; key 2 ] @>

[<Fact>]
let ``The cursor points at the last row of the page, not at the hidden one`` () =
    let page = run (returning (snapshots 3)) None 2

    test <@ page.Next = Some(key 2) @>

[<Fact>]
let ``A page the read filled short of the extra row ends the enumeration`` () =
    let page = run (returning (snapshots 2)) None 2

    test <@ page.Next = None @>

[<Fact>]
let ``An empty page ends the enumeration`` () =
    let page = run (returning []) None 2

    test <@ page.Next = None @>

[<Fact>]
let ``The page carries the moment of the read it came from`` () =
    let page = run (returning (snapshots 1)) None 2

    test <@ page.ConsistentAt = Sample.fixedNow @>

[<Fact>]
let ``A cursor round trip returns the identifier it was made from`` () =
    let token = Cursor.encode (key 5)

    test <@ Cursor.decode token = Ok(Some(key 5)) @>

[<Fact>]
let ``An empty cursor opens the enumeration at its start`` () =
    let opened = Cursor.decode ""

    test <@ opened = Ok None @>

[<Fact>]
let ``A cursor that is not base64 is refused`` () =
    let refused = Cursor.decode "not-a-token"

    test <@ refused = Error() @>

[<Fact>]
let ``A cursor that decodes to something other than an identifier is refused`` () =
    let token = Convert.ToBase64String(Text.Encoding.UTF8.GetBytes "hello")

    test <@ Cursor.decode token = Error() @>

[<Fact>]
let ``The API defaults an unset page size to the service default`` () =
    let asked = ResizeArray<int>()

    let read _ limit =
        asked.Add limit
        Task.FromResult(pageOf [])

    handled read (request ()) |> ignore

    test <@ asked |> List.ofSeq = [ defaultPageSize + 1 ] @>

[<Fact>]
let ``The API accepts the largest page size the contract promises`` () =
    let largest = request ()
    largest.PageSize <- maxPageSize

    let response = handled (returning (snapshots 1)) largest

    test <@ response.Meetups.Count = 1 @>

[<Fact>]
let ``The API refuses a page size above the maximum`` () =
    let read _ _ = failwith "Read must not be reached"
    let oversized = request ()
    oversized.PageSize <- maxPageSize + 1

    let code = codeOf (fun () -> Api.handle read oversized)

    test <@ code = Some StatusCode.InvalidArgument @>

[<Fact>]
let ``The API refuses a negative page size`` () =
    let read _ _ = failwith "Read must not be reached"
    let negative = request ()
    negative.PageSize <- -1

    let code = codeOf (fun () -> Api.handle read negative)

    test <@ code = Some StatusCode.InvalidArgument @>

[<Fact>]
let ``The API refuses a page token it did not issue`` () =
    let read _ _ = failwith "Read must not be reached"
    let malformed = request ()
    malformed.PageToken <- "not-a-token"

    let code = codeOf (fun () -> Api.handle read malformed)

    test <@ code = Some StatusCode.InvalidArgument @>

[<Fact>]
let ``The API continues the enumeration from the identifier in the token`` () =
    let asked = ResizeArray<MeetupId option>()

    let read after _ =
        asked.Add after
        Task.FromResult(pageOf [])

    let next = request ()
    next.PageToken <- Cursor.encode (key 4)
    handled read next |> ignore

    test <@ asked |> List.ofSeq = [ Some(key 4) ] @>

[<Fact>]
let ``The API hands back a token that reopens the enumeration`` () =
    let paged = request ()
    paged.PageSize <- 2

    let response = handled (returning (snapshots 3)) paged
    let resumed = Cursor.decode response.NextPageToken

    test <@ resumed = Ok(Some(key 2)) @>

[<Fact>]
let ``The API leaves the token empty on the last page`` () =
    let response = handled (returning (snapshots 1)) (request ())

    test <@ response.NextPageToken = "" @>

[<Fact>]
let ``The API renders the consistency moment as RFC 3339 UTC`` () =
    let response = handled (returning (snapshots 1)) (request ())
    let rendered = response.ConsistentAt

    test <@ rendered = "2026-09-07T18:30:00.0000000Z" @>

[<Fact>]
let ``The API renders every snapshot of the page`` () =
    let response = handled (returning (snapshots 2)) (request ())

    test <@ response.Meetups.Count = 2 @>
