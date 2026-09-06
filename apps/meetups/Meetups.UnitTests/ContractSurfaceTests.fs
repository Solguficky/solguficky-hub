module Meetups.ContractSurfaceTests

open Google.Protobuf.Reflection
open Meetups.V1
open Swensen.Unquote
open Xunit

let private schema = MeetupsServiceReflection.Descriptor

let private requestTypes =
    MeetupsService.Descriptor.Methods
    |> Seq.map (fun m -> m.InputType)
    |> List.ofSeq

/// Nested messages count: a failure type hidden inside another message must not escape the checks below.
let rec private withNested (message: MessageDescriptor) =
    seq {
        yield message
        yield! message.NestedTypes |> Seq.collect withNested
    }

let private messages = schema.MessageTypes |> Seq.collect withNested |> List.ofSeq

let private enums =
    Seq.append schema.EnumTypes (messages |> Seq.collect (fun m -> m.EnumTypes))
    |> List.ofSeq

let private fieldNames (message: MessageDescriptor) =
    message.Fields.InDeclarationOrder()
    |> Seq.map (fun f -> f.Name)
    |> Set.ofSeq

/// Field 1 rendered as "<name>: <type>", so a failing list names the offending request.
let private firstField (message: MessageDescriptor) =
    match message.FindFieldByNumber 1 with
    | null -> message.Name, "<no field 1>"
    | field when field.FieldType = FieldType.Message -> message.Name, $"{field.Name}: {field.MessageType.FullName}"
    | field -> message.Name, $"{field.Name}: {field.FieldType}"

[<Fact>]
let ``The F# library sees the generated service under the meetups v1 package`` () =
    test <@ ContractSurface.serviceFullName = "meetups.v1.MeetupsService" @>

[<Fact>]
let ``Service exposes exactly the six slice operations`` () =
    let actual =
        MeetupsService.Descriptor.Methods
        |> Seq.map (fun m -> m.Name)
        |> Set.ofSeq

    let expected =
        set
            [ "CreateMeetupDraft"
              "ChangeMeetupAttributes"
              "SetMeetupSchedule"
              "PublishMeetup"
              "ListVisibleMeetups"
              "GetMeetup" ]

    test <@ actual = expected @>

[<Fact>]
let ``Every operation carries the viewer as field one`` () =
    let actual = requestTypes |> List.map firstField
    let expected = requestTypes |> List.map (fun m -> m.Name, $"viewer: {Viewer.Descriptor.FullName}")

    test <@ actual = expected @>

[<Fact>]
let ``Create draft takes the caller-generated id as its idempotency key`` () =
    let actual = fieldNames CreateMeetupDraftRequest.Descriptor

    test <@ actual = set [ "viewer"; "id" ] @>

[<Fact>]
let ``Change attributes sends every informational field as target state`` () =
    let actual =
        ChangeMeetupAttributesRequest.Descriptor.Fields.InDeclarationOrder()
        |> Seq.filter (fun f -> f.Name <> "viewer" && f.Name <> "id")
        |> Seq.map (fun f -> f.Name, string f.FieldType, f.HasPresence)
        |> List.ofSeq

    // No presence: an omitted attribute is not a distinct "leave unchanged" state.
    let expected =
        [ "title"; "description"; "venue"; "kind"; "calendar_link" ]
        |> List.map (fun name -> name, "String", false)

    test <@ actual = expected @>

[<Fact>]
let ``Schema declares only the lifecycle and visibility enums`` () =
    let actual = enums |> List.map (fun e -> e.Name) |> Set.ofList

    test <@ actual = set [ "MeetupLifecycle"; "MeetupVisibility" ] @>

[<Fact>]
let ``Schema names no failure, so a hidden meetup is indistinguishable from a missing one`` () =
    let markers = [ "error"; "denied"; "forbidden"; "failure"; "reason"; "not_found"; "invisible" ]
    let names (text: string) = markers |> List.exists (text.ToLowerInvariant().Contains)

    let actual =
        [ for e in enums do
            if names e.Name then $"enum {e.FullName}"

            for value in e.Values do
                if names value.Name then $"enum value {e.FullName}.{value.Name}"

          for m in messages do
              for f in m.Fields.InDeclarationOrder() do
                  if names f.Name then $"field {m.FullName}.{f.Name}" ]

    test <@ actual = [] @>

[<Fact>]
let ``The schema has exactly one absent state and it is first_published_at`` () =
    let actual =
        [ for message in messages do
            for f in message.Fields.InDeclarationOrder() do
                // Message fields and oneofs always carry presence; the contract gives it no meaning.
                if f.FieldType <> FieldType.Message && f.HasPresence then
                    $"{message.Name}.{f.Name}" ]

    test <@ actual = [ "MeetupSnapshot.first_published_at" ] @>

[<Fact>]
let ``Schedule spells no date as a form rather than an absent field`` () =
    let actual =
        Schedule.Descriptor.Oneofs
        |> Seq.filter (fun o -> not o.IsSynthetic)
        |> Seq.collect (fun o -> o.Fields |> Seq.map (fun f -> $"{o.Name}.{f.Name}"))
        |> List.ofSeq

    test <@ actual = [ "form.no_date"; "form.tentative"; "form.fixed" ] @>

[<Fact>]
let ``Every attribute the change command sets is readable back from the snapshot`` () =
    let shape (message: MessageDescriptor) =
        message.Fields.InDeclarationOrder()
        |> Seq.map (fun f -> f.Name, string f.FieldType)
        |> List.ofSeq

    let sent =
        shape ChangeMeetupAttributesRequest.Descriptor
        |> List.filter (fun (name, _) -> name <> "viewer" && name <> "id")

    let snapshot = shape MeetupSnapshot.Descriptor
    let missing = sent |> List.filter (fun attribute -> not (List.contains attribute snapshot))

    test <@ missing = [] @>
