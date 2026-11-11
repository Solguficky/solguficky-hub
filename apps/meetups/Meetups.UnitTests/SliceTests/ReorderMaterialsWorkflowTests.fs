module Meetups.SliceTests.ReorderMaterialsWorkflowTests

open System
open System.Threading.Tasks
open Meetups.Domain
open Meetups.Infrastructure
open Meetups.Slices.ReorderMaterials
open Meetups.TestData
open Swensen.Unquote
open Xunit

let private stub: Deps =
    {
        Load = fun _ -> failwith "unexpected load"
        Commit = fun _ _ _ _ -> failwith "unexpected commit"
        Now = fun () -> Sample.later
        NewEventId = fun () -> Guid.Empty
        RequestId = None
    }

let private command: Command =
    {
        Id = Sample.meetupId
        MaterialIds = []
        Viewer = Sample.administrator
        ExpectedVersion = Sample.expectedVersion
    }

let private run deps cmd =
    execute deps cmd
    |> Async.AwaitTask
    |> Async.RunSynchronously

[<Fact>]
let ``An ordinary viewer is refused like for a missing meetup and nothing is written`` () =
    test
        <@
            run
                { stub with
                    Load = fun _ -> Task.FromResult None
                }
                { command with
                    Viewer = Sample.ordinary
                } = Error(ReorderMaterialsError.Forbidden CannotActOnMeetup)
        @>

[<Fact>]
let ``Missing and mismatched collections are rejected without writing`` () =
    let missing =
        run
            { stub with
                Load = fun _ -> Task.FromResult None
            }
            command

    let mismatch =
        run
            { stub with
                Load = fun _ -> Task.FromResult(Some(Meetup.toSnapshot Sample.withMaterial))
            }
            command

    test
        <@
            missing = Error(ReorderMaterialsError.Domain MaterialOrderError.MeetupNotFound)
            && mismatch = Error(ReorderMaterialsError.Domain MaterialOrderError.MaterialSetMismatch)
        @>

[<Fact>]
let ``Reorder commits one event with the shown version and a retry succeeds without writing`` () =
    let second =
        { Sample.material with
            Id = Sample.otherMaterialId
            Position = 2
        }

    let before =
        Meetup.apply (Existing Sample.withMaterial) (MeetupMaterialAttached second)
        |> Meetup.toSnapshot

    let order =
        [
            Sample.otherMaterialId
            Sample.materialId
        ]

    let writes = ResizeArray<_>()

    let deps =
        { stub with
            Load = fun _ -> Task.FromResult(Some before)
            Commit =
                fun _ version state event ->
                    writes.Add(version, event)
                    Task.FromResult(Ok(Meetup.apply state event |> Meetup.toSnapshot))
        }

    let cmd =
        { command with
            MaterialIds = order
            ExpectedVersion = before.Version
        }

    let result = run deps cmd

    let after =
        Meetup.apply (Meetup.restore (Some before)) (MaterialsReordered order)
        |> Meetup.toSnapshot

    let retry =
        run
            { stub with
                Load = fun _ -> Task.FromResult(Some after)
            }
            cmd

    test
        <@
            result = Ok after
            && retry = Ok after
            && List.ofSeq writes = [
                Some before.Version, MaterialsReordered order
            ]
        @>

[<Fact>]
let ``A write conflict is not retried unless the exact target has been reached`` () =
    let second =
        { Sample.material with
            Id = Sample.otherMaterialId
            Position = 2
        }

    let before =
        Meetup.apply (Existing Sample.withMaterial) (MeetupMaterialAttached second)
        |> Meetup.toSnapshot

    let order =
        [
            Sample.otherMaterialId
            Sample.materialId
        ]

    let after =
        Meetup.apply (Meetup.restore (Some before)) (MaterialsReordered order)
        |> Meetup.toSnapshot

    let conflicting =
        { stub with
            Load = fun _ -> Task.FromResult(Some before)
            Commit = fun _ _ _ _ -> Task.FromResult(Error MeetupStore.VersionConflict)
        }

    let cmd =
        { command with
            MaterialIds = order
        }

    let conflict = run conflicting cmd
    let mutable reads = 0

    let reached =
        run
            { conflicting with
                Load =
                    fun _ ->
                        reads <- reads + 1
                        Task.FromResult(Some(if reads = 1 then before else after))
            }
            cmd

    test
        <@
            conflict = Error ReorderMaterialsError.Conflict
            && reached = Ok after
        @>

[<Fact>]
let ``The API rejects malformed ids and a missing version before loading`` () =
    let viewer = Meetups.V1.Viewer(IdentityId = "0199c0de-0000-7000-8000-000000000001")
    viewer.Rights.Add Identity.V1.AccessRight.ManageMeetups

    let request =
        Meetups.V1.ReorderMaterialsRequest(
            Viewer = viewer,
            Id = "0199c0de-0000-7000-8000-0000000000f1",
            ExpectedVersion = 1L
        )

    request.MaterialIds.Add "not-an-id"
    let badId = Meetups.TestRpc.codeOf (fun () -> Api.handle stub request)
    request.MaterialIds.Clear()
    request.ExpectedVersion <- 0L
    let badVersion = Meetups.TestRpc.codeOf (fun () -> Api.handle stub request)

    test
        <@
            badId = Some Grpc.Core.StatusCode.InvalidArgument
            && badVersion = Some Grpc.Core.StatusCode.InvalidArgument
        @>
