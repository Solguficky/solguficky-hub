/// Адаптер порта публикации (PER-209): запись журнала в конверт
/// `meetups.v1.MeetupEvent` и в JetStream. Решений очереди он не принимает — что
/// публиковать, в каком порядке и когда отмечать, решает срез
/// `DispatchMeetupEvents`; здесь только «отправить одну запись и сказать, принял ли
/// её сервер».
module Meetups.Transport.NatsEventPublisher

open System
open System.Diagnostics
open System.Threading
open System.Threading.Tasks
open Google.Protobuf
open Meetups
open Meetups.Infrastructure
open Meetups.Observability
open Meetups.Slices
open Meetups.Slices.DispatchMeetupEvents
open NATS.Client.Core
open NATS.Client.JetStream
open NATS.Client.JetStream.Models

/// Запись журнала в сообщение контракта. Чистое: ни сети, ни часов, поэтому все
/// одиннадцать поводов проверяются unit-тестами без брокера.
module Envelope =

    /// Subject — повод под общим префиксом стрима `MEETUPS_EVENTS`. Имя повода в
    /// журнале и в subject одно и то же, это закрепил PER-206; отдельной таблицы
    /// соответствия нет намеренно — её пришлось бы держать в согласии с
    /// `meetup_events_type_check` третьим местом.
    [<Literal>]
    let SubjectPrefix = "events.meetups."

    let subject (event: PendingEvent) : string = SubjectPrefix + event.EventType

    /// Строка, которую схема приняла, а адаптер разложить не может, — дефект пары
    /// «писатель журнала и адаптер», а не недоступность шины. Поэтому исключение, а
    /// не `Declined`: отказ соседа записался бы как `dependency_unavailable` и
    /// выдал бы наш дефект за чужой сбой. Тик запишет его как `unexpected`, очередь
    /// встанет на этой записи и будет видна по возрасту старейшей.
    let private malformed (event: PendingEvent) (what: string) : 'a =
        failwith $"meetup event {event.EventId} cannot be published: {what}"

    let private materialId (event: PendingEvent) : string =
        match event.MaterialId with
        | Some id -> id.ToString "D"
        | None -> malformed event $"{event.EventType} carries no material_id"

    let private setOccasion (event: PendingEvent) (message: Meetups.V1.MeetupEvent) : unit =
        match event.EventType with
        | "meetup_created" -> message.MeetupCreated <- Meetups.V1.MeetupCreated()
        | "meetup_changed" -> message.MeetupChanged <- Meetups.V1.MeetupChanged()
        | "meetup_published" -> message.MeetupPublished <- Meetups.V1.MeetupPublished()
        | "meetup_unpublished" -> message.MeetupUnpublished <- Meetups.V1.MeetupUnpublished()
        | "meetup_republished" -> message.MeetupRepublished <- Meetups.V1.MeetupRepublished()
        | "meetup_publication_scheduled" ->
            message.MeetupPublicationScheduled <- Meetups.V1.MeetupPublicationScheduled()
        | "meetup_publication_cancelled" ->
            message.MeetupPublicationCancelled <- Meetups.V1.MeetupPublicationCancelled()
        | "meetup_cancelled" -> message.MeetupCancelled <- Meetups.V1.MeetupCancelled()
        | "meetup_held" -> message.MeetupHeld <- Meetups.V1.MeetupHeld()
        | "meetup_material_attached" ->
            message.MeetupMaterialAttached <- Meetups.V1.MeetupMaterialAttached(MaterialId = materialId event)
        | "meetup_material_removed" ->
            message.MeetupMaterialRemoved <- Meetups.V1.MeetupMaterialRemoved(MaterialId = materialId event)
        // Повод, которого нет в словаре контракта: пустой oneof значением не
        // является, и отправить его значило бы отдать потребителю сообщение, которое
        // тот обязан отвергнуть.
        | other -> malformed event $"unknown event type {other}"

    let ofPending (event: PendingEvent) : Meetups.V1.MeetupEvent =
        let snapshot = MeetupEventPayload.toSnapshot event.EventId event.Payload

        // Снимок несёт свою версию, и конверт несёт её же. Расхождение — порча
        // журнала: публиковать версию из одного места и состояние из другого значит
        // дать потребителю применить не тот снимок.
        if snapshot.Version <> event.Version then
            malformed event $"payload version {snapshot.Version} differs from the row version {event.Version}"

        let message =
            Meetups.V1.MeetupEvent(
                EventId = event.EventId.ToString "D",
                MeetupId = event.MeetupId.ToString "D",
                Version = event.Version,
                // UtcDateTime и "o", как у моментов снимка в Contract.Outbound:
                // контракт требует RFC 3339 UTC с Z, а не смещение +00:00.
                OccurredAt = event.OccurredAt.ToUniversalTime().UtcDateTime.ToString "o",
                State = Contract.Outbound.state snapshot
            )

        setOccasion event message

        // Сквозной id переносится из строки и не рождается здесь (PER-227): у строки
        // без него поле остаётся unset, и это «Meetups id не получил», а не пустое
        // значение — пустую строку контракт значением не считает.
        match event.RequestId with
        | Some requestId -> message.RequestId <- RequestId.value requestId
        | None -> ()

        message

/// Стрим, в который адаптер обязан попасть. Заводит его платформа (ADR-050), а
/// адаптер только называет: заголовок `Nats-Expected-Stream` превращает публикацию
/// мимо него — опечатку в subject или чужой стрим на том же префиксе — в отказ
/// сервера, а не в тихо принятое сообщение, которое не увидит ни один durable.
[<Literal>]
let Stream = "MEETUPS_EVENTS"

/// Адрес NATS. Отсутствие значения — не ошибка конфигурации, а состояние сервиса:
/// порт остаётся `Unconfigured`, и хост поднимается так же, как без адаптера.
/// Имя стоит рядом с потребителем по образцу `Migrations.DatabaseUrlVariable`.
[<Literal>]
let UrlVariable = "MEETUPS_NATS_URL"

/// Сколько ждать ack одной попытки. Предел нужен потому, что клиент, потерявший
/// соединение, держит публикацию до переподключения: без него один тик висел бы
/// всё время недоступности NATS, а ход публикации оставался бы занятым.
///
/// Четыре секунды — строго меньше `RequestTimeout` клиента (пять по умолчанию).
/// При равных пределах замерший брокер гонял бы два таймера, и проигравший свой
/// клиент отвечал бы «нет ответчиков» — отказом, который читается как пропавший
/// стрим, а не как молчащий сервер.
let defaultAckTimeout = TimeSpan.FromSeconds 4.0

/// Отправка одной публикации JetStream — единственное, что адаптер берёт у клиента.
/// Функция, а не `INatsJSContext`: классы отказов проверяются подменой ответа, а не
/// мок-объектом интерфейса на полтора десятка методов.
type Send = string -> byte[] -> NatsJSPubOpts -> CancellationToken -> ValueTask<PubAckResponse>

let ofContext (context: INatsJSContext) : Send =
    fun subject body opts token ->
        context.PublishAsync<byte[]>(subject, body, NatsRawSerializer<byte[]>.Default, opts, null, token)

/// Исход попытки с классом для метрики. Причина отказа начинается с `nats:`: она
/// уходит в поле `error` записи тика, и по префиксу отказ адаптера отличается от
/// всего, что пишет reader.
let private classify (ack: PubAckResponse) : string * PublishOutcome =
    match ack.Error with
    | null when ack.Stream <> Stream ->
        "rejected", PublishOutcome.Declined $"nats: acknowledged by stream {ack.Stream}, expected {Stream}"
    | null when ack.Duplicate -> "duplicate", PublishOutcome.Confirmed
    | null -> "confirmed", PublishOutcome.Confirmed
    | error -> "rejected", PublishOutcome.Declined $"nats: {error.Code} {error.ErrCode} {error.Description}"

/// Одна попытка публикации. Повтора внутри нет: `RetryAttempts = 1` отключает
/// собственные повторы клиента, и следующая попытка — это следующий тик. Так частота
/// повторов при недоступном NATS ограничена интервалом воркера по построению, а не
/// счётчиком, которому можно протухнуть.
///
/// Отмена хоста проходит насквозь: это не отказ шины, и тик обязан узнать её как
/// отмену. Истёкший собственный предел — отказ: сервер не подтвердил, строка
/// остаётся pending.
let publish
    (send: Send)
    (ackTimeout: TimeSpan)
    (token: CancellationToken)
    (event: PendingEvent)
    : Task<PublishOutcome> =
    task {
        let body = (Envelope.ofPending event).ToByteArray()

        let opts =
            NatsJSPubOpts(
                // Ключ серверной дедупликации: повтор той же записи внутри окна
                // стрима сервер отбросит и ответит ack с пометкой повтора.
                MsgId = event.EventId.ToString "D",
                ExpectedStream = Stream,
                RetryAttempts = 1
            )

        use attempt = CancellationTokenSource.CreateLinkedTokenSource token
        attempt.CancelAfter ackTimeout
        let started = Stopwatch.GetTimestamp()

        let! result, outcome =
            task {
                try
                    let! ack = send (Envelope.subject event) body opts attempt.Token
                    return classify ack
                with
                | :? OperationCanceledException when not token.IsCancellationRequested ->
                    return "timeout", PublishOutcome.Declined $"nats: no ack within {ackTimeout.TotalSeconds} s"
                | :? NatsJSPublishNoResponseException
                | :? NatsNoRespondersException ->
                    return
                        "no_responders",
                        PublishOutcome.Declined "nats: no responders, the stream is missing or JetStream is down"
                | :? NatsJSApiException as rejected ->
                    return
                        "rejected",
                        PublishOutcome.Declined
                            $"nats: {rejected.Error.Code} {rejected.Error.ErrCode} {rejected.Error.Description}"
                | :? NatsException as unavailable ->
                    return "unavailable", PublishOutcome.Declined $"nats: {unavailable.Message}"
            }

        PublisherTelemetry.observe result (Stopwatch.GetElapsedTime started)
        return outcome
    }
