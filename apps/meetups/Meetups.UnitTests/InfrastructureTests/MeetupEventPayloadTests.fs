/// Тело строки журнала. Форма закрепляется тестом намеренно: апкаст старых событий
/// по ADR-024 не предусмотрен, и записанное сегодня останется в журнале навсегда.
/// Тест — единственное место, где эта форма объявлена явно, а не выведена из
/// реализации. Читатель — адаптер публикации — проверяется здесь же обратным ходом:
/// писатель и читатель обязаны согласоваться на каждом снимке.
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

let private minute hours minutes =
    LocalTime.create (TimeOnly(hours, minutes))
    |> Result.defaultWith (fun _ -> failwith "the sample time must have minute precision")

let private interval =
    LocalInterval.create
        {
            Date = DateOnly(2026, 10, 3)
            Time = minute 18 30
        }
        {
            Date = DateOnly(2026, 10, 4)
            Time = minute 1 15
        }
    |> Result.defaultWith (fun _ -> failwith "the sample interval must be ordered")

let private eventId = Guid.Parse "0199c0de-0000-7000-8000-0000000000e1"

let private roundTrip (snapshot: MeetupSnapshot) : MeetupSnapshot =
    MeetupEventPayload.toSnapshot eventId (MeetupEventPayload.ofSnapshot snapshot)

/// Каждая ветка формы: пустое и датированное расписание трёх точностей, обе
/// необязательные метки времени, материалы и конечные оси жизненного цикла. Снимок,
/// потерявший что-то на обратном пути, ушёл бы в шину правдоподобным, но не тем.
[<Fact>]
let ``Reading the payload back yields the snapshot it was written from`` () =
    let snapshots =
        [
            Meetup.toSnapshot Sample.draft
            Meetup.toSnapshot Sample.published
            Meetup.toSnapshot Sample.scheduled
            Meetup.toSnapshot Sample.cancelledVisible
            Meetup.toSnapshot Sample.held
            Meetup.toSnapshot Sample.withMaterial
            { Meetup.toSnapshot Sample.titled with
                Schedule = Tentative Sample.day
            }
            { Meetup.toSnapshot Sample.titled with
                Schedule =
                    Fixed(
                        DayStart
                            {
                                Date = DateOnly(2026, 10, 3)
                                Time = minute 18 30
                            }
                    )
            }
            { Meetup.toSnapshot Sample.titled with
                Schedule = Fixed(Interval interval)
            }
        ]

    test <@ snapshots |> List.map roundTrip = snapshots @>

/// Момент читается той же точностью, что пишется: микросекунды целиком, без
/// округления до секунды.
[<Fact>]
let ``Reading the payload back keeps the microseconds of a moment`` () =
    let snapshot =
        { Meetup.toSnapshot Sample.published with
            FirstPublishedAt = Some(Sample.fixedNow.AddTicks 12340L)
        }

    test <@ (roundTrip snapshot).FirstPublishedAt = Some(Sample.fixedNow.AddTicks 12340L) @>

/// Payload, который читатель не понимает, — дефект, а не отказ: исключение называет
/// событие, чтобы запись о нём вела к строке журнала.
[<Fact>]
let ``A payload without a required field is rejected naming the event`` () =
    let payload =
        (parse (Meetup.toSnapshot Sample.titled)
         |> fun node ->
             node.Remove "venue" |> ignore
             node.ToJsonString())

    let error =
        Assert.Throws<exn>(fun () ->
            MeetupEventPayload.toSnapshot eventId payload
            |> ignore
        )

    test
        <@
            error.Message.Contains(eventId.ToString "D")
            && error.Message.Contains "venue"
        @>

[<Fact>]
let ``Only the material occasions carry a material id`` () =
    let (MaterialId attached) = Sample.material.Id
    let (MaterialId removed) = Sample.materialId

    test
        <@
            MeetupEventPayload.materialId (MeetupMaterialAttached Sample.material) = Nullable attached
            && MeetupEventPayload.materialId (MeetupMaterialRemoved Sample.materialId) = Nullable removed
            && MeetupEventPayload.materialId MeetupCancelled = Nullable()
            && MeetupEventPayload.materialId (MeetupCreated(Sample.meetupId, Sample.authorId)) = Nullable()
        @>
