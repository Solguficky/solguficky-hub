/// Настоящий NATS с JetStream для сценариев публикации.
///
/// Контейнер один на процесс, как у PostgreSQL в `Testdb.fs`, и по той же причине:
/// старт брокера на каждый тест стоил бы дороже самих сценариев. Стрим же свой у
/// каждого сценария — он пересоздаётся перед тестом, поэтому ни одно сообщение
/// соседнего прогона в выборку не попадает.
module Meetups.IntegrationTests.Infrastructure.NatsBroker

open System
open System.Threading
open System.Threading.Tasks
open DotNet.Testcontainers.Builders
open DotNet.Testcontainers.Containers
open NATS.Client.Core
open NATS.Client.JetStream
open NATS.Client.JetStream.Models
open Testcontainers.Nats
open Xunit

/// Образ той же линии, что поднимает AppHost (`NatsSetup.cs`): сервер другой
/// версии мог бы отвечать на публикацию иначе, и сценарий проверял бы не тот NATS.
let private image = "nats:2.10-alpine"

let private container =
    lazy
        (try
            let nats =
                NatsBuilder(image)
                    // JetStream включается флагом сервера: без него публикация в
                    // стрим получает «нет ответчиков», и сценарии проверяли бы отказ
                    // вместо публикации.
                    .WithCommand("--jetstream")
                    .Build()

            nats.StartAsync().GetAwaiter().GetResult()

            AppDomain.CurrentDomain.ProcessExit.Add(fun _ -> nats.DisposeAsync().AsTask().GetAwaiter().GetResult())

            Ok nats
         with
         | :? DockerUnavailableException as ex -> Error $"docker unavailable: {ex.Message}"
         | ex -> Error $"testcontainers: {ex.GetType().Name}: {ex.Message}")

/// Брокер обязателен в CI и необязателен локально — то же правило, что у базы:
/// пропуск на CI прятал бы непроверенную публикацию за зелёным прогоном.
let private started () : NatsContainer =
    match container.Value with
    | Ok nats -> nats
    | Error reason when not (isNull (Environment.GetEnvironmentVariable "GITHUB_ACTIONS")) ->
        failwith $"testcontainers nats is required in CI: {reason}"
    | Error reason ->
        Assert.Skip $"nats not available: {reason}"
        failwith "unreachable: Assert.Skip throws"

let private run (work: Task<'a>) = work.GetAwaiter().GetResult()

/// Соединение сценария вместе со стримом `MEETUPS_EVENTS`, созданным заново.
///
/// Конфигурация стрима повторяет в тесте то, что держит `JetStreamTopology.cs`:
/// подмножество subject и окно дедупликации. Расхождение с AppHost этот набор не
/// поймает — это цена того, что L1 не поднимает Aspire.
type Broker() =
    let nats = started ()

    let connection =
        new NatsConnection(
            NatsOpts(
                Url = nats.GetConnectionString(),
                // Короткий таймаут запроса: сценарий паузы ждёт отказа, а не минуту
                // значения по умолчанию.
                RequestTimeout = TimeSpan.FromSeconds 2.0
            )
        )

    let context = NatsJSContext(connection)

    do
        task {
            try
                let! _ = context.DeleteStreamAsync Meetups.Transport.NatsEventPublisher.Stream
                ()
            with :? NatsJSApiException ->
                ()

            let! _ =
                context.CreateStreamAsync(
                    StreamConfig(
                        Meetups.Transport.NatsEventPublisher.Stream,
                        ResizeArray
                            [
                                Meetups.Transport.NatsEventPublisher.Envelope.SubjectPrefix
                                + ">"
                            ],
                        DuplicateWindow = TimeSpan.FromMinutes 2.0
                    )
                )

            ()
        }
        |> run

    member _.Context: INatsJSContext = context

    /// Стрим пропадает так, как пропадает при потерянной топологии: публикация
    /// после этого не находит ответчика.
    member _.DropStream() =
        context.DeleteStreamAsync(Meetups.Transport.NatsEventPublisher.Stream).AsTask()
        |> run
        |> ignore

    /// Брокер замирает целиком: соединение не рвётся, но ни один ack не приходит.
    /// Пауза, а не остановка: остановленный контейнер при старте получает новый
    /// порт хоста, и клиенту пришлось бы переподключаться по другому адресу.
    member _.Pause() = nats.PauseAsync().GetAwaiter().GetResult()

    member _.Unpause() = nats.UnpauseAsync().GetAwaiter().GetResult()

    /// Всё, что лежит в стриме, в порядке записи: тело и заголовок дедупликации.
    member _.Messages() : (byte[] * string) list =
        task {
            let! consumer = context.CreateOrderedConsumerAsync Meetups.Transport.NatsEventPublisher.Stream
            let result = ResizeArray<byte[] * string>()

            use timeout = new CancellationTokenSource(TimeSpan.FromSeconds 5.0)

            let fetched =
                consumer.FetchNoWaitAsync<byte[]>(
                    NatsJSFetchOpts(MaxMsgs = 100),
                    NatsRawSerializer<byte[]>.Default,
                    timeout.Token
                )

            let enumerator = fetched.GetAsyncEnumerator(timeout.Token)
            let mutable more = true

            while more do
                let! next = enumerator.MoveNextAsync()

                if next then
                    let message = enumerator.Current
                    result.Add(message.Data, string message.Headers["Nats-Msg-Id"])
                else
                    more <- false

            do! enumerator.DisposeAsync()
            return List.ofSeq result
        }
        |> run

    interface IDisposable with
        member _.Dispose() = connection.DisposeAsync().AsTask().GetAwaiter().GetResult()
