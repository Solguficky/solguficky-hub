/// Тело строки журнала. Форма закрепляется тестом намеренно: читателя у payload не
/// будет до появления релея, апкаст старых событий по ADR-024 не предусмотрен, и
/// записанное сегодня останется в журнале навсегда. Тест — единственное место, где
/// эта форма объявлена явно, а не выведена из реализации.
module Meetups.InfrastructureTests.MeetupEventPayloadTests

open System
open System.Text.Json.Nodes
open Swensen.Unquote
open Xunit
open Meetups.Domain
open Meetups.Infrastructure
open Meetups.TestData

let private parse (snapshot: MeetupSnapshot) : JsonObject =
    MeetupEventPayload.ofSnapshot snapshot
    |> JsonNode.Parse
    :?> JsonObject

[<Fact>]
let ``The event type names the occasion the schema accepts`` () =
    let created =
        MeetupEventPayload.eventType (MeetupCreated(Sample.meetupId, Sample.authorId))

    let changed =
        MeetupEventPayload.eventType (MeetupChanged(AttributesChanged Sample.attributes))

    let published = MeetupEventPayload.eventType (MeetupPublished Sample.fixedNow)
    let unpublished = MeetupEventPayload.eventType MeetupUnpublished
    let republished = MeetupEventPayload.eventType MeetupRepublished

    let scheduled =
        MeetupEventPayload.eventType (MeetupPublicationScheduled Sample.later)

    let unscheduled = MeetupEventPayload.eventType MeetupPublicationCancelled
    let cancelled = MeetupEventPayload.eventType MeetupCancelled
    let held = MeetupEventPayload.eventType MeetupHeld

    let materialAttached =
        MeetupEventPayload.eventType (MeetupMaterialAttached Sample.material)

    let materialRemoved =
        MeetupEventPayload.eventType (MeetupMaterialRemoved Sample.materialId)

    test
        <@
            created = "meetup_created"
            && changed = "meetup_changed"
            && published = "meetup_published"
            && unpublished = "meetup_unpublished"
            && republished = "meetup_republished"
            && scheduled = "meetup_publication_scheduled"
            && unscheduled = "meetup_publication_cancelled"
            && cancelled = "meetup_cancelled"
            && materialAttached = "meetup_material_attached"
            && materialRemoved = "meetup_material_removed"
            && held = "meetup_held"
        @>

[<Fact>]
let ``The payload carries the snapshot as a JSON object`` () =
    let payload = parse (Meetup.toSnapshot Sample.titled)

    test
        <@
            payload["title"].GetValue<string>() = Sample.attributes.Title
            && payload["venue"].GetValue<string>() = Sample.attributes.Venue
            && payload["lifecycle"].GetValue<string>() = "planned"
            && payload["visibility"].GetValue<string>() = "hidden"
            && payload["version"].GetValue<int64>() = 2L
        @>

/// Отсутствие первой публикации выражается отсутствием поля, а не пустой строкой:
/// presence у этого поля настоящая, и «никогда не публиковалась» обязано отличаться
/// от «опубликована в неизвестный момент».
[<Fact>]
let ``A meetup that was never published omits the first publication field`` () =
    let payload = parse (Meetup.toSnapshot Sample.draft)

    test <@ not (payload.ContainsKey "first_published_at") @>

[<Fact>]
let ``A published meetup carries the first publication moment in UTC`` () =
    let payload = parse (Meetup.toSnapshot Sample.published)

    test <@ payload["first_published_at"].GetValue<string>() = "2026-09-07T18:30:00.000000Z" @>

/// Payload и колонка состояния описывают один момент. Точность у них общая —
/// микросекунда, которую держит TIMESTAMPTZ, — и запись журнала не может оказаться
/// грубее состояния, из которого сделана: восстанавливать отброшенный хвост релею
/// будет неоткуда.
[<Fact>]
let ``The first publication moment is written at the precision the state keeps`` () =
    let snapshot =
        { Meetup.toSnapshot Sample.published with
            FirstPublishedAt = Some(Sample.fixedNow.AddTicks 12345L)
        }

    let payload = parse snapshot
    let row = MeetupRow.ofSnapshot snapshot

    test
        <@
            payload["first_published_at"].GetValue<string>() = "2026-09-07T18:30:00.001234Z"
            && row.FirstPublishedAt = Nullable(Sample.fixedNow.AddTicks 12340L)
        @>

[<Fact>]
let ``A meetup without a scheduled publication omits the moment field`` () =
    let payload = parse (Meetup.toSnapshot Sample.titled)

    test <@ not (payload.ContainsKey "scheduled_publish_at") @>

[<Fact>]
let ``A scheduled publication carries the moment in UTC`` () =
    let payload = parse (Meetup.toSnapshot Sample.scheduled)

    test <@ payload["scheduled_publish_at"].GetValue<string>() = "2026-09-08T18:30:00.000000Z" @>

[<Fact>]
let ``A meetup without a date carries the form and no boundaries`` () =
    let payload = parse (Meetup.toSnapshot Sample.draft)
    let schedule = payload["schedule"].AsObject()

    test
        <@
            schedule["form"].GetValue<string>() = "no_date"
            && not (schedule.ContainsKey "precision")
            && not (schedule.ContainsKey "start_date")
        @>

[<Fact>]
let ``A dated schedule carries its form, precision and boundaries`` () =
    let snapshot =
        { Meetup.toSnapshot Sample.titled with
            Schedule = Fixed Sample.day
        }

    let payload = parse snapshot
    let schedule = payload["schedule"].AsObject()

    test
        <@
            schedule["form"].GetValue<string>() = "fixed"
            && schedule["precision"].GetValue<string>() = "day"
            && schedule["start_date"].GetValue<string>() = "2026-10-03"
        @>

/// Материалы входят в снимок события: потребитель выводит «материал добавлен»
/// сравнением с собственной репликой (ADR-031), поэтому тело обязано нести
/// коллекцию целиком, а не факт изменения.
[<Fact>]
let ``The payload carries the materials of the collection in order`` () =
    let payload = parse (Meetup.toSnapshot Sample.withMaterial)
    let materials = payload["materials"].AsArray()

    test <@ materials.Count = 1 @>

    let material = materials[0].AsObject()
    let source = material["source"].AsObject()

    test
        <@
            material["id"].GetValue<string>() = "0199c0de-0000-7000-8000-0000000000a1"
            && material["position"].GetValue<int>() = 1
            && material["title"].GetValue<string>() = Sample.material.Title
            && source["kind"].GetValue<string>() = "message_link"
            && source["value"].GetValue<string>() = "https://t.me/solguficky/42"
            && material["bound_by"].GetValue<string>() = "0199c0de-0000-7000-8000-000000000001"
        @>

/// Пустая коллекция — пустой массив, а не отсутствующее поле: «материалов нет» и
/// «поле не заполнено» обязаны читаться одинаково.
[<Fact>]
let ``A meetup without materials carries an empty array`` () =
    let payload = parse (Meetup.toSnapshot Sample.titled)

    test <@ payload["materials"].AsArray().Count = 0 @>
