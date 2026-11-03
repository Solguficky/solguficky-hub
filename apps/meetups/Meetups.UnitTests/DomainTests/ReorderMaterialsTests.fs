module Meetups.DomainTests.ReorderMaterialsTests

open Meetups.Domain
open Meetups.Infrastructure
open Meetups.TestData
open Swensen.Unquote
open Xunit

let private second =
    { Sample.material with
        Id = Sample.otherMaterialId
        Position = 3
        Title = "Photo"
        Source = FileId("photo", Photo)
    }

let private two =
    Meetup.apply (Existing Sample.withMaterial) (MeetupMaterialAttached second)

let private ids =
    [
        Sample.otherMaterialId
        Sample.materialId
    ]

[<Fact>]
let ``Reordering preserves materials and compacts positions through storage and event snapshots`` () =
    let decision = Meetup.decideReorderMaterials ids (Existing two)

    let reordered =
        Meetup.apply (Existing two) (MaterialsReordered ids)
        |> Meetup.toSnapshot

    let expected =
        [
            { second with
                Position = 1
            }
            { Sample.material with
                Position = 2
            }
        ]

    let restored =
        reordered
        |> MeetupRow.ofSnapshot
        |> MeetupRow.toSnapshot

    let payload = MeetupEventPayload.ofEvent (MaterialsReordered ids) reordered
    let fromEvent = MeetupEventPayload.toSnapshot System.Guid.Empty payload

    test
        <@
            decision = Ok(Some(MaterialsReordered ids))
            && reordered.Materials = expected
            && reordered.Version = (Meetup.toSnapshot two).Version + 1L
            && restored = reordered
            && fromEvent = reordered
        @>

[<Fact>]
let ``A repeated target order is successful without another event even after cancellation`` () =
    let reordered = Meetup.apply (Existing two) (MaterialsReordered ids)
    let cancelled = Meetup.apply (Existing reordered) MeetupCancelled

    test
        <@
            Meetup.decideReorderMaterials ids (Existing reordered) = Ok None
            && Meetup.decideReorderMaterials ids (Existing cancelled) = Ok None
        @>

[<Fact>]
let ``An unchanged order still compacts gaps before becoming a safe repeat`` () =
    let original =
        [
            Sample.materialId
            Sample.otherMaterialId
        ]

    test <@ Meetup.decideReorderMaterials original (Existing two) = Ok(Some(MaterialsReordered original)) @>

[<Fact>]
let ``Reordering after removal compacts the remaining position`` () =
    let removed = Meetup.apply (Existing two) (MeetupMaterialRemoved Sample.materialId)

    let reordered =
        Meetup.apply (Existing removed) (MaterialsReordered [ Sample.otherMaterialId ])
        |> Meetup.toSnapshot

    test
        <@
            reordered.Materials = [
                { second with
                    Position = 1
                }
            ]
        @>

[<Fact>]
let ``Missing foreign and duplicate material ids are rejected`` () =
    let invalid =
        [
            []
            [ Sample.materialId ]
            [ Sample.materialId; Sample.materialId ]
            [
                Sample.materialId
                MaterialId System.Guid.Empty
            ]
        ]

    test
        <@
            invalid
            |> List.forall (fun order ->
                Meetup.decideReorderMaterials order (Existing two) = Error MaterialOrderError.MaterialSetMismatch
            )
        @>

[<Fact>]
let ``An empty existing collection is already ordered`` () =
    test <@ Meetup.decideReorderMaterials [] (Existing Sample.draft) = Ok None @>

[<Fact>]
let ``A missing meetup is rejected`` () =
    test <@ Meetup.decideReorderMaterials [] Initial = Error MaterialOrderError.MeetupNotFound @>

[<Fact>]
let ``Cancellation refuses a changed order`` () =
    let cancelled = Meetup.apply (Existing two) MeetupCancelled
    test <@ Meetup.decideReorderMaterials ids (Existing cancelled) = Error MaterialOrderError.TransitionNotAllowed @>
