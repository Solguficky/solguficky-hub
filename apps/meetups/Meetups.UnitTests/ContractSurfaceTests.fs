module Meetups.ContractSurfaceTests

open Google.Protobuf.Reflection
open Meetups.V1
open Swensen.Unquote
open Xunit

/// Поверхность контракта лежит в двух файлах: значения домена — в meetups.proto,
/// сам сервис и его запросы — в meetups_service.proto. Проверки ниже смотрят на
/// обе схемы, иначе вынос типа в соседний файл гасил бы утверждение молча.
let private valueTypes = MeetupsReflection.Descriptor

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

let private messages =
    Seq.append valueTypes.MessageTypes schema.MessageTypes
    |> Seq.collect withNested
    |> List.ofSeq

let private fileEnums = Seq.append valueTypes.EnumTypes schema.EnumTypes

let private enums =
    Seq.append fileEnums (messages |> Seq.collect (fun m -> m.EnumTypes))
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
let ``The generated service lives under the meetups v1 package`` () =
    test <@ MeetupsService.Descriptor.FullName = "meetups.v1.MeetupsService" @>

[<Fact>]
let ``Service exposes exactly the eleven slice operations`` () =
    let actual =
        MeetupsService.Descriptor.Methods
        |> Seq.map (fun m -> m.Name)
        |> Set.ofSeq

    let expected =
        [
            "CreateMeetupDraft"
            "ChangeMeetupAttributes"
            "SetMeetupSchedule"
            "PublishMeetup"
            "UnpublishMeetup"
            "CancelMeetup"
            "AttachMaterial"
            "RemoveMaterial"
            "ListVisibleMeetups"
            "GetMeetup"
            "ListMeetupStates"
        ]
        |> set

    test <@ actual = expected @>

/// Служебное перечисление состояния смотрящего не принимает намеренно (PER-211),
/// поэтому оно исключено здесь по имени, а его собственную форму проверяет тест
/// ниже: молчаливый пропуск был бы неотличим от забытого поля.
[<Fact>]
let ``Every human operation carries the viewer as field one`` () =
    let requests =
        requestTypes
        |> List.filter (fun request -> request.Name <> "ListMeetupStatesRequest")

    let actual = requests |> List.map firstField

    let expected =
        requests
        |> List.map (fun m -> m.Name, $"viewer: {Viewer.Descriptor.FullName}")

    test <@ actual = expected @>

[<Fact>]
let ``Create draft takes the caller-generated id as its idempotency key`` () =
    let actual = fieldNames CreateMeetupDraftRequest.Descriptor

    test <@ actual = set [ "viewer"; "id" ] @>

/// Запрос сверяется целиком, а не «содержит page_token»: равенство множеств и
/// есть утверждение о том, что viewer в служебной операции не появился.
[<Fact>]
let ``Service enumeration is paged and carries its consistency moment`` () =
    let request = fieldNames ListMeetupStatesRequest.Descriptor

    let response = fieldNames ListMeetupStatesResponse.Descriptor

    let expected =
        [
            "meetups"
            "next_page_token"
            "consistent_at"
        ]
        |> set

    test
        <@
            request = set [ "page_token"; "page_size" ]
            && response = expected
        @>

[<Fact>]
let ``Change attributes sends every informational field as target state`` () =
    let actual =
        ChangeMeetupAttributesRequest.Descriptor.Fields.InDeclarationOrder()
        |> Seq.filter (fun f -> f.Name <> "viewer" && f.Name <> "id")
        |> Seq.map (fun f -> f.Name, string f.FieldType, f.HasPresence)
        |> List.ofSeq

    // No presence: an omitted attribute is not a distinct "leave unchanged" state.
    let expected =
        [
            "title"
            "description"
            "venue"
            "kind"
            "calendar_link"
        ]
        |> List.map (fun name -> name, "String", false)

    test <@ actual = expected @>

/// Вынос значений — часть контракта, а не раскладка по вкусу: потребитель,
/// которому нужно расписание или ось состояния, не обязан тянуть в кодогенерацию
/// сам сервис с его запросами.
[<Fact>]
let ``The value types live apart from the service schema`` () =
    let messageNames (file: FileDescriptor) =
        file.MessageTypes
        |> Seq.map (fun m -> m.Name)
        |> Set.ofSeq

    let expected =
        [
            "Schedule"
            "NoDate"
            "DateValue"
            "CalendarDate"
            "LocalTime"
            "LocalDateTime"
            "LocalInterval"
            "MeetupMaterial"
            "MeetupMaterialSource"
        ]
        |> set

    test
        <@
            messageNames valueTypes = expected
            && Set.intersect (messageNames schema) expected = Set.empty
        @>

[<Fact>]
let ``Schema declares only the lifecycle and visibility enums`` () =
    let actual = enums |> List.map (fun e -> e.Name) |> Set.ofList

    let expected =
        [
            "MeetupLifecycle"
            "MeetupVisibility"
        ]
        |> set

    test <@ actual = expected @>

[<Fact>]
let ``Schema names no failure, so a hidden meetup is indistinguishable from a missing one`` () =
    let markers =
        [
            "error"
            "denied"
            "forbidden"
            "failure"
            "reason"
            "not_found"
            "invisible"
        ]

    let names (text: string) =
        markers
        |> List.exists (text.ToLowerInvariant().Contains)

    let actual =
        [
            for e in enums do
                if names e.Name then
                    $"enum {e.FullName}"

                for value in e.Values do
                    if names value.Name then
                        $"enum value {e.FullName}.{value.Name}"

            for m in messages do
                for f in m.Fields.InDeclarationOrder() do
                    if names f.Name then
                        $"field {m.FullName}.{f.Name}"
        ]

    test <@ actual = [] @>

[<Fact>]
let ``The schema has exactly one absent state and it is first_published_at`` () =
    let actual =
        [
            for message in messages do
                for f in message.Fields.InDeclarationOrder() do
                    // Message fields and real oneof members always carry presence;
                    // the contract gives it no meaning there. `optional` creates a
                    // synthetic oneof, so oneof membership is checked by IsSynthetic
                    // rather than by ContainingOneof alone.
                    let inOneof =
                        not (isNull (box f.ContainingOneof))
                        && not f.ContainingOneof.IsSynthetic

                    if
                        f.FieldType <> FieldType.Message
                        && f.HasPresence
                        && not inOneof
                    then
                        $"{message.Name}.{f.Name}"
        ]

    test <@ actual = [ "MeetupSnapshot.first_published_at" ] @>

[<Fact>]
let ``Schedule spells no date as a form rather than an absent field`` () =
    let actual =
        Schedule.Descriptor.Oneofs
        |> Seq.filter (fun o -> not o.IsSynthetic)
        |> Seq.collect (fun o ->
            o.Fields
            |> Seq.map (fun f -> $"{o.Name}.{f.Name}")
        )
        |> List.ofSeq

    test
        <@
            actual = [
                "form.no_date"
                "form.tentative"
                "form.fixed"
            ]
        @>

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

    let missing =
        sent
        |> List.filter (fun attribute -> not (List.contains attribute snapshot))

    test <@ missing = [] @>

/// Прикрепление принимает материал, а не готовую позицию: место в порядке
/// назначает сервер, и поля position в запросе нет. Идентификатор материала
/// приходит от вызывающей стороны — он же ключ идемпотентности.
[<Fact>]
let ``Attaching a material takes the caller-generated material id and no position`` () =
    let actual = fieldNames AttachMaterialRequest.Descriptor

    test
        <@
            actual = set
                [
                    "viewer"
                    "id"
                    "material_id"
                    "title"
                    "source"
                ]
        @>

[<Fact>]
let ``Removing a material names the material by the same caller-generated id`` () =
    let actual = fieldNames RemoveMaterialRequest.Descriptor

    test <@ actual = set [ "viewer"; "id"; "material_id" ] @>

/// Материал в снимке — элемент repeated-поля: порядок коллекции несёт порядок
/// поля, отдельного position в контракте нет, а авторство привязки остаётся
/// внутренним. Источник — одно определение на запрос и снимок, поэтому он живёт
/// отдельным сообщением, и пустой oneof значением не является.
[<Fact>]
let ``A material carries its id, its title and exactly one source`` () =
    let material =
        MeetupMaterial.Descriptor.Fields.InDeclarationOrder()
        |> Seq.map (fun f -> f.Name, string f.FieldType)
        |> List.ofSeq

    let source =
        MeetupMaterialSource.Descriptor.Oneofs
        |> Seq.filter (fun o -> not o.IsSynthetic)
        |> Seq.collect (fun o ->
            o.Fields
            |> Seq.map (fun f -> $"{o.Name}.{f.Name}")
        )
        |> List.ofSeq

    let snapshotMaterials =
        MeetupSnapshot.Descriptor.Fields.InDeclarationOrder()
        |> Seq.filter (fun f -> f.Name = "materials")
        |> Seq.map (fun f -> f.Name, f.FieldType, f.IsRepeated)
        |> List.ofSeq

    test
        <@
            material = [
                "id", "String"
                "title", "String"
                "source", "Message"
            ]
            && source = [
                "source.message_link"
                "source.file_id"
            ]
            && snapshotMaterials = [ "materials", FieldType.Message, true ]
        @>
