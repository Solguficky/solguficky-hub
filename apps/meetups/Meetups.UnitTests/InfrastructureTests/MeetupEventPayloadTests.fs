/// Тело строки журнала. Форма закрепляется тестом намеренно: читателя у payload не
/// будет до появления релея, апкаст старых событий по ADR-024 не предусмотрен, и
/// записанное сегодня останется в журнале навсегда. Тест — единственное место, где
/// эта форма объявлена явно, а не выведена из реализации.
module Meetups.InfrastructureTests.MeetupEventPayloadTests

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

    test
        <@
            created = "meetup_created"
            && changed = "meetup_changed"
            && published = "meetup_published"
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

    test <@ payload["first_published_at"].GetValue<string>() = "2026-09-07T18:30:00Z" @>

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
