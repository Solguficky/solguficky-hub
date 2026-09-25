module Meetups.ContractSurfaceTests

open FSharp.Reflection
open Google.Protobuf.Reflection
open Meetups.Infrastructure
open Meetups.TestData
open Meetups.V1
open Swensen.Unquote
open Xunit

// `Meetups.Domain` намеренно не открыт: ветки повода на проводе названы именами
// случаев доменного юниона, поэтому `MeetupCreated` и ещё десять имён есть в обоих
// пространствах. Совпадение имён и есть то, что проверяют два последних теста, а
// разрешать его молча последним `open` — значит проверять не то, что написано.

/// Поверхность контракта лежит в трёх файлах: значения домена — в meetups.proto,
/// сам сервис и его запросы — в meetups_service.proto, исходящие факты журнала — в
/// meetups_events.proto. Проверки ниже смотрят на все три схемы, иначе вынос типа в
/// соседний файл гасил бы утверждение молча.
let private valueTypes = MeetupsReflection.Descriptor

let private schema = MeetupsServiceReflection.Descriptor

let private events = MeetupsEventsReflection.Descriptor

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
    [
        valueTypes.MessageTypes
        schema.MessageTypes
        events.MessageTypes
    ]
    |> Seq.concat
    |> Seq.collect withNested
    |> List.ofSeq

let private fileEnums =
    [
        valueTypes.EnumTypes
        schema.EnumTypes
        events.EnumTypes
    ]
    |> Seq.concat

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
let ``Service exposes exactly the sixteen slice operations`` () =
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
            "ScheduleMeetupPublication"
            "CancelMeetupPublication"
            "UnpublishMeetup"
            "CancelMeetup"
            "AttachMaterial"
            "RemoveMaterial"
            "MarkMeetupHeld"
            "ListVisibleMeetups"
            "ListArchivedMeetups"
            "GetMeetup"
            "ListMeetupStates"
            "CheckMeetupAuthority"
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

/// Момент отложенной публикации приходит локальной парой «дата и время»: часовой
/// пояс применяется при интерпретации, а не при разборе (ADR-031), поэтому в
/// запросе его нет, а в состоянии и ответе лежит мгновение.
[<Fact>]
let ``Scheduling a publication sends the moment as a local date and time`` () =
    let fields =
        ScheduleMeetupPublicationRequest.Descriptor.Fields.InDeclarationOrder()
        |> Seq.map (fun f -> f.Name, f.FieldType)
        |> List.ofSeq

    test
        <@
            fields = [
                "viewer", FieldType.Message
                "id", FieldType.String
                "moment", FieldType.Message
                "expected_version", FieldType.Int64
            ]
        @>

[<Fact>]
let ``Cancelling a scheduled publication takes only the viewer and the id`` () =
    let actual = fieldNames CancelMeetupPublicationRequest.Descriptor

    test <@ actual = set [ "viewer"; "id"; "expected_version" ] @>

/// Вопрос о праве не несёт сценария вызывающей стороны, а ответ — готового
/// разрешения для кэша: решение передаёт статус, тело пустое (PER-224).
[<Fact>]
let ``The authority check asks about a meetup and answers with the status alone`` () =
    let request = fieldNames CheckMeetupAuthorityRequest.Descriptor
    let response = fieldNames MeetupAuthority.Descriptor

    test
        <@
            request = set [ "viewer"; "id" ]
            && response = Set.empty
        @>

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
        |> Seq.filter (fun f ->
            f.Name <> "viewer"
            && f.Name <> "id"
            && f.Name <> "expected_version"
        )
        |> Seq.map (fun f -> f.Name, string f.FieldType, f.HasPresence)
        |> List.ofSeq

    // No presence: an omitted attribute is not a distinct "leave unchanged" state.
    // The expected version stays out of this set: it is not an attribute but the
    // write predicate's input (PER-78).
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

/// Показанная версия есть в каждой команде изменения и перехода и везде скаляром:
/// у int64 presence нет, поэтому отсутствие поля и ноль — одни и те же байты, и
/// разбор отвергает оба одинаково (PER-78).
[<Fact>]
let ``Every command decided from a snapshot carries the expected version`` () =
    let shape =
        [
            ChangeMeetupAttributesRequest.Descriptor
            SetMeetupScheduleRequest.Descriptor
            PublishMeetupRequest.Descriptor
            UnpublishMeetupRequest.Descriptor
            CancelMeetupRequest.Descriptor
        ]
        |> List.map (fun message ->
            let field = message.FindFieldByName "expected_version"
            message.Name, field.FieldType = FieldType.Int64, field.HasPresence
        )

    test
        <@
            shape = [
                "ChangeMeetupAttributesRequest", true, false
                "SetMeetupScheduleRequest", true, false
                "PublishMeetupRequest", true, false
                "UnpublishMeetupRequest", true, false
                "CancelMeetupRequest", true, false
            ]
        @>

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

                // Имя самого oneof полем не является, поэтому обход выше его не
                // видит. Повод события — первый oneof, который мог бы назваться
                // `reason`, и здесь это слово означало бы отказ.
                for o in m.Oneofs do
                    if not o.IsSynthetic && names o.Name then
                        $"oneof {m.FullName}.{o.Name}"
        ]

    test <@ actual = [] @>

/// Обе схемы состояния объявляют одни и те же два отсутствия, и утверждение
/// перечисляет их вместе: расхождение между снимком чтения и снимком события —
/// ровно то, что раздельные определения обязаны делать заметным.
[<Fact>]
let ``The schema has exactly four absent states and they are the publication moments`` () =
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

    test
        <@
            actual = [
                "MeetupSnapshot.first_published_at"
                "MeetupSnapshot.scheduled_publish_at"
                "MeetupState.first_published_at"
                "MeetupState.scheduled_publish_at"
            ]
        @>

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
        |> List.filter (fun (name, _) ->
            name <> "viewer"
            && name <> "id"
            && name <> "expected_version"
        )

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
                    "expected_version"
                ]
        @>

[<Fact>]
let ``Removing a material names the material by the same caller-generated id`` () =
    let actual = fieldNames RemoveMaterialRequest.Descriptor

    test
        <@
            actual = set
                [
                    "viewer"
                    "id"
                    "material_id"
                    "expected_version"
                ]
        @>

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

/// Словарь поводов живёт в четырёх местах: юнион `MeetupEvent` в домене, строки
/// `MeetupEventPayload.eventType`, CHECK-ограничение миграции 007 и ветки повода на
/// проводе. Два теста ниже связывают из них три; четвёртое держит сама база, потому
/// что `eventType` пишет в колонку под ограничением.
///
/// Без этой пары «каждое событие словаря имеет сообщение» проверялось бы сверкой
/// списков глазами, а новый повод доезжал бы до шины молча — юнион исчерпывается
/// компилятором, а схема о нём не знает.
///
/// Сравниваются множества, а не списки: номера полей заставляют дописывать новую
/// ветку в конец схемы, а случай юниона вставляется где угодно, и порядок разошёлся
/// бы на первом же верном изменении. Утверждается состав словаря, а не его порядок.
let private occasionOneof =
    MeetupEvent.Descriptor.Oneofs
    |> Seq.filter (fun o -> not o.IsSynthetic)
    |> Seq.exactlyOne

[<Fact>]
let ``Every occasion of the domain dictionary has its own message on the wire`` () =
    let domain =
        FSharpType.GetUnionCases typeof<Meetups.Domain.MeetupEvent>
        |> Seq.map (fun case -> case.Name)
        |> Set.ofSeq

    let wire =
        occasionOneof.Fields
        |> Seq.map (fun field -> field.MessageType.Name)
        |> Set.ofSeq

    test <@ wire = domain @>

/// Имя ветки на проводе — то же имя, которое уходит в колонку `event_type`, поэтому
/// subject публикации получается приписыванием домена к нему, а не второй таблицей
/// соответствия (integration.md).
[<Fact>]
let ``The name of each occasion on the wire is the name the journal writes`` () =
    let journal =
        [
            Meetups.Domain.MeetupCreated(Sample.meetupId, Sample.authorId)
            Meetups.Domain.MeetupChanged(Meetups.Domain.AttributesChanged Sample.attributes)
            Meetups.Domain.MeetupPublished Sample.fixedNow
            Meetups.Domain.MeetupUnpublished
            Meetups.Domain.MeetupRepublished
            Meetups.Domain.MeetupPublicationScheduled Sample.later
            Meetups.Domain.MeetupPublicationCancelled
            Meetups.Domain.MeetupCancelled
            Meetups.Domain.MeetupMaterialAttached Sample.material
            Meetups.Domain.MeetupMaterialRemoved Sample.materialId
            Meetups.Domain.MeetupHeld
        ]
        |> List.map MeetupEventPayload.eventType
        |> Set.ofList

    let wire =
        occasionOneof.Fields
        |> Seq.map (fun field -> field.Name)
        |> Set.ofSeq

    test <@ wire = journal @>
