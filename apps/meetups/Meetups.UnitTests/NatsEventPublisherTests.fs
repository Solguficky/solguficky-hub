/// Адаптер публикации без брокера: раскладка записи журнала в конверт контракта и
/// перевод ответа JetStream в исход порта. Сеть здесь подменена функцией `Send`
/// намеренно — классы отказов решает код адаптера, а не сервер, и то, что сервер
/// действительно так отвечает, проверяет интеграционный набор с настоящим NATS.
module Meetups.NatsEventPublisherTests

open System
open System.Threading
open System.Threading.Tasks
open Google.Protobuf
open Meetups
open Meetups.Domain
open Meetups.Infrastructure
open Meetups.Slices
open Meetups.Slices.DispatchMeetupEvents
open Meetups.TestData
open Meetups.Transport
open Meetups.Transport.NatsEventPublisher
open NATS.Client.Core
open NATS.Client.JetStream
open NATS.Client.JetStream.Models
open Swensen.Unquote
open Xunit

let private eventId = Guid.Parse "0199c0de-0000-7000-8000-0000000000e1"

let private occurredAt = DateTimeOffset(2026, 9, 7, 18, 30, 0, TimeSpan.Zero)

let private pending (eventType: string) (meetup: Meetup) (materialId: Guid option) : PendingEvent =
    let snapshot = Meetup.toSnapshot meetup
    let (MeetupId meetupId) = snapshot.Id

    {
        EventId = eventId
        MeetupId = meetupId
        Version = snapshot.Version
        EventType = eventType
        Payload = MeetupEventPayload.ofSnapshot snapshot
        PerformedBy = Guid.Parse "0199c0de-0000-7000-8000-000000000001"
        OccurredAt = occurredAt
        RequestId = None
        MaterialId = materialId
    }

let private materialGuid =
    let (MaterialId id) = Sample.materialId
    id

/// Повод и ожидаемая ветка oneof для каждого имени словаря. Список полный намеренно:
/// повод, забытый в адаптере, упал бы исключением на первой же строке такого типа,
/// а не на тесте.
let private occasions =
    [
        "meetup_created", None, Meetups.V1.MeetupEvent.OccasionOneofCase.MeetupCreated
        "meetup_changed", None, Meetups.V1.MeetupEvent.OccasionOneofCase.MeetupChanged
        "meetup_published", None, Meetups.V1.MeetupEvent.OccasionOneofCase.MeetupPublished
        "meetup_unpublished", None, Meetups.V1.MeetupEvent.OccasionOneofCase.MeetupUnpublished
        "meetup_republished", None, Meetups.V1.MeetupEvent.OccasionOneofCase.MeetupRepublished
        "meetup_publication_scheduled", None, Meetups.V1.MeetupEvent.OccasionOneofCase.MeetupPublicationScheduled
        "meetup_publication_cancelled", None, Meetups.V1.MeetupEvent.OccasionOneofCase.MeetupPublicationCancelled
        "meetup_cancelled", None, Meetups.V1.MeetupEvent.OccasionOneofCase.MeetupCancelled
        "meetup_held", None, Meetups.V1.MeetupEvent.OccasionOneofCase.MeetupHeld
        "meetup_material_attached", Some materialGuid, Meetups.V1.MeetupEvent.OccasionOneofCase.MeetupMaterialAttached
        "meetup_material_removed", Some materialGuid, Meetups.V1.MeetupEvent.OccasionOneofCase.MeetupMaterialRemoved
    ]

[<Fact>]
let ``Every occasion of the dictionary becomes its own branch of the envelope`` () =
    let cases =
        occasions
        |> List.map (fun (eventType, materialId, _) ->
            (Envelope.ofPending (pending eventType Sample.withMaterial materialId)).OccasionCase
        )

    test
        <@
            cases = (occasions
                     |> List.map (fun (_, _, expected) -> expected))
        @>

[<Fact>]
let ``The subject is the occasion under the stream prefix`` () =
    test <@ Envelope.subject (pending "meetup_published" Sample.published None) = "events.meetups.meetup_published" @>

[<Fact>]
let ``The envelope carries the journal row identity, version and moment`` () =
    let message = Envelope.ofPending (pending "meetup_changed" Sample.titled None)

    test
        <@
            message.EventId = "0199c0de-0000-7000-8000-0000000000e1"
            && message.MeetupId = "0199c0de-0000-7000-8000-0000000000f1"
            && message.Version = 2L
            && message.OccurredAt = "2026-09-07T18:30:00.0000000Z"
        @>

[<Fact>]
let ``Both material occasions carry the id of the material`` () =
    let attached =
        Envelope.ofPending (pending "meetup_material_attached" Sample.withMaterial (Some materialGuid))

    let removed =
        Envelope.ofPending (pending "meetup_material_removed" Sample.titled (Some materialGuid))

    test
        <@
            attached.MeetupMaterialAttached.MaterialId = "0199c0de-0000-7000-8000-0000000000a1"
            && removed.MeetupMaterialRemoved.MaterialId = "0199c0de-0000-7000-8000-0000000000a1"
        @>

/// Оракул состояния — gRPC-снимок той же сходки. Номера полей у двух сообщений
/// совпадают по решению контракта, а версия у `MeetupState` зарезервирована, поэтому
/// снимок без версии обязан читаться тем же состоянием байт в байт.
[<Fact>]
let ``The state in the envelope is the service snapshot without the version`` () =
    let snapshot = Meetup.toSnapshot Sample.withMaterial

    let message =
        Envelope.ofPending (pending "meetup_material_attached" Sample.withMaterial (Some materialGuid))

    let service = Contract.Outbound.snapshot snapshot
    service.Version <- 0L

    let expected = Meetups.V1.MeetupState.Parser.ParseFrom(service.ToByteArray())

    test <@ message.State = expected @>

/// Сквозной id переносится из строки журнала как есть, а у строки без него поле
/// остаётся unset: пустая строка контрактом значением не считается.
[<Fact>]
let ``The request id of the row travels in the envelope and its absence stays unset`` () =
    let withId =
        Envelope.ofPending
            { pending "meetup_changed" Sample.titled None with
                RequestId = RequestId.create "req-42"
            }

    let withoutId = Envelope.ofPending (pending "meetup_changed" Sample.titled None)

    test
        <@
            withId.RequestId = "req-42"
            && not withoutId.HasRequestId
        @>

[<Fact>]
let ``A material occasion without a material id is refused as a defect`` () =
    let error =
        Assert.Throws<exn>(fun () ->
            Envelope.ofPending (pending "meetup_material_removed" Sample.titled None)
            |> ignore
        )

    test <@ error.Message.Contains "material_id" @>

[<Fact>]
let ``An occasion outside the dictionary is refused as a defect`` () =
    let error =
        Assert.Throws<exn>(fun () ->
            Envelope.ofPending (pending "meetup_renamed" Sample.titled None)
            |> ignore
        )

    test <@ error.Message.Contains "meetup_renamed" @>

/// Версия конверта и версия снимка — одно число из двух мест. Расхождение значит,
/// что строка и её тело описывают разные состояния, и публиковать такое нельзя.
[<Fact>]
let ``A payload of another version than the row is refused as a defect`` () =
    let event =
        { pending "meetup_changed" Sample.titled None with
            Version = 7L
        }

    let error = Assert.Throws<exn>(fun () -> Envelope.ofPending event |> ignore)

    test <@ error.Message.Contains "version" @>

/// Ответ сервера вместе с тем, что адаптер передал в отправку.
type private Sent =
    {
        mutable Subject: string
        mutable Opts: NatsJSPubOpts
        mutable Body: byte[]
    }

let private answering (answer: CancellationToken -> ValueTask<PubAckResponse>) =
    let sent =
        {
            Subject = null
            Opts = null
            Body = null
        }

    let send: NatsEventPublisher.Send =
        fun subject body opts token ->
            sent.Subject <- subject
            sent.Opts <- opts
            sent.Body <- body
            answer token

    send, sent

let private ack (configure: PubAckResponse -> PubAckResponse) =
    fun (_: CancellationToken) ->
        ValueTask<PubAckResponse>(configure (PubAckResponse(Stream = NatsEventPublisher.Stream, Seq = 1UL)))

let private failing (error: exn) =
    fun (_: CancellationToken) -> ValueTask<PubAckResponse>(Task.FromException<PubAckResponse> error)

let private publishWith (send: NatsEventPublisher.Send) (token: CancellationToken) =
    NatsEventPublisher.publish
        send
        (TimeSpan.FromMilliseconds 200.0)
        token
        (pending "meetup_changed" Sample.titled None)

[<Fact>]
let ``An acknowledged publication is confirmed and keyed by the event id`` () =
    task {
        let send, sent = answering (ack id)

        let! outcome = publishWith send CancellationToken.None

        let message = Meetups.V1.MeetupEvent.Parser.ParseFrom sent.Body

        test
            <@
                outcome = PublishOutcome.Confirmed
                && sent.Subject = "events.meetups.meetup_changed"
                && sent.Opts.MsgId = "0199c0de-0000-7000-8000-0000000000e1"
                && sent.Opts.ExpectedStream = "MEETUPS_EVENTS"
                && sent.Opts.RetryAttempts = 1
                && message.EventId = sent.Opts.MsgId
            @>
    }

/// Ack с пометкой повтора — это сервер, узнавший `Nats-Msg-Id` внутри окна: запись
/// уже в стриме, и строка обязана получить отметку, а не остаться pending навсегда.
[<Fact>]
let ``A duplicate acknowledgement still confirms the publication`` () =
    task {
        let send, _ =
            answering (ack (fun response -> PubAckResponse(Stream = response.Stream, Duplicate = true)))

        let! outcome = publishWith send CancellationToken.None

        test <@ outcome = PublishOutcome.Confirmed @>
    }

[<Fact>]
let ``An acknowledgement carrying an error declines the publication`` () =
    task {
        let send, _ =
            answering (
                ack (fun _ -> PubAckResponse(Error = ApiError(Code = 503, ErrCode = 10077, Description = "down")))
            )

        let! outcome = publishWith send CancellationToken.None

        test <@ outcome = PublishOutcome.Declined "nats: 503 10077 down" @>
    }

[<Fact>]
let ``An acknowledgement from another stream declines the publication`` () =
    task {
        let send, _ = answering (ack (fun _ -> PubAckResponse(Stream = "OTHER")))

        let! outcome = publishWith send CancellationToken.None

        test
            <@
                match outcome with
                | PublishOutcome.Declined reason -> reason.Contains "OTHER"
                | PublishOutcome.Confirmed -> false
            @>
    }

/// Сервер не ответил за предел попытки — строка остаётся pending, а тик не висит всё
/// время недоступности: ответ, которого нет, моделируется ожиданием одного токена.
[<Fact>]
let ``A publication without an acknowledgement in time is declined`` () =
    task {
        let send, _ =
            answering (fun token ->
                ValueTask<PubAckResponse>(
                    task {
                        do! Task.Delay(Timeout.Infinite, token)
                        return PubAckResponse()
                    }
                )
            )

        let! outcome = publishWith send CancellationToken.None

        test
            <@
                match outcome with
                | PublishOutcome.Declined reason -> reason.StartsWith "nats: no ack within"
                | PublishOutcome.Confirmed -> false
            @>
    }

[<Fact>]
let ``A publication nobody answers is declined`` () =
    task {
        let send, _ = answering (failing (NatsJSPublishNoResponseException()))

        let! outcome = publishWith send CancellationToken.None

        test
            <@
                match outcome with
                | PublishOutcome.Declined reason -> reason.StartsWith "nats: no responders"
                | PublishOutcome.Confirmed -> false
            @>
    }

[<Fact>]
let ``A connection failure declines the publication`` () =
    task {
        let send, _ = answering (failing (NatsException "connection refused"))

        let! outcome = publishWith send CancellationToken.None

        test <@ outcome = PublishOutcome.Declined "nats: connection refused" @>
    }

/// Отмена хоста — не отказ шины: адаптер обязан пропустить её насквозь, иначе
/// остановка сервиса записалась бы как `dependency_unavailable`.
[<Fact>]
let ``Host cancellation passes through instead of declining`` () =
    task {
        use cancelled = new CancellationTokenSource()
        cancelled.Cancel()

        let send, _ =
            answering (fun token -> ValueTask<PubAckResponse>(Task.FromCanceled<PubAckResponse> token))

        let! error =
            Assert.ThrowsAnyAsync<OperationCanceledException>(fun () -> publishWith send cancelled.Token :> Task)

        test <@ error.CancellationToken.IsCancellationRequested @>
    }
