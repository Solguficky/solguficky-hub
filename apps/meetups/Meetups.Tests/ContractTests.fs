module Meetups.ContractTests

open Google.Protobuf.Reflection
open Meetups.V1
open Xunit

let private methodNames =
    MeetupsService.Descriptor.Methods
    |> Seq.map (fun (m: MethodDescriptor) -> m.Name)
    |> Set.ofSeq

let private fieldNames (message: MessageDescriptor) =
    message.Fields.InDeclarationOrder()
    |> Seq.map (fun f -> f.Name)
    |> Set.ofSeq

let private assertSetEquals expected actual =
    Assert.True((expected = actual), sprintf "expected %A, got %A" expected actual)

[<Fact>]
let ``service exposes exactly the six slice operations`` () =
    assertSetEquals
        (set
            [ "CreateMeetupDraft"
              "ChangeMeetupAttributes"
              "SetMeetupSchedule"
              "PublishMeetup"
              "ListVisibleMeetups"
              "GetMeetup" ])
        methodNames

[<Fact>]
let ``every operation carries a viewer`` () =
    let requests =
        MeetupsService.Descriptor.Methods
        |> Seq.map (fun m -> m.InputType)
    Assert.All(
        requests,
        fun message ->
            let viewer = message.FindFieldByNumber(1)
            Assert.NotNull(viewer)
            Assert.Equal("viewer", viewer.Name)
            Assert.Equal(Viewer.Descriptor, viewer.MessageType))

[<Fact>]
let ``create draft takes caller-generated id as the idempotency key`` () =
    assertSetEquals (set [ "viewer"; "id" ]) (fieldNames CreateMeetupDraftRequest.Descriptor)
    Assert.Null(CreateMeetupDraftRequest.Descriptor.FindFieldByName("idempotency_key"))

[<Fact>]
let ``change attributes sends the five informational fields as target state`` () =
    assertSetEquals
        (set
            [ "viewer"
              "id"
              "title"
              "description"
              "venue"
              "kind"
              "calendar_link" ])
        (fieldNames ChangeMeetupAttributesRequest.Descriptor)
    Assert.Empty(ChangeMeetupAttributesRequest.Descriptor.NestedTypes)

[<Fact>]
let ``file has no distinct visibility-denied failure`` () =
    let enumNames =
        MeetupsServiceReflection.Descriptor.EnumTypes
        |> Seq.map (fun e -> e.Name)
        |> Set.ofSeq
    assertSetEquals (set [ "MeetupLifecycle"; "MeetupVisibility" ]) enumNames
