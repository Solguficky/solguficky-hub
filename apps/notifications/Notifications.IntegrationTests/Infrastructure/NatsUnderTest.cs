using Google.Protobuf;
using NATS.Client.Core;
using NATS.Client.JetStream;
using NATS.Client.JetStream.Models;
using Notifications.Facts;
using Notifications.Replica;
using Notifications.V1;
using Testcontainers.Nats;

namespace Notifications.IntegrationTests.Infrastructure;

/// <summary>
/// Свой сервер JetStream на тест, со streams и durable, которые сервис ждёт.
/// </summary>
/// <remarks>
/// Контейнер на тест, а не общий на прогон: позиция durable живёт на сервере,
/// и два теста на одном durable делили бы поток — сообщение одного теста
/// подтверждал бы силос другого.
///
/// Топология здесь повторена, а не взята из AppHost: <c>JetStreamTopology</c>
/// там <c>internal</c>, а сервис ссылки на AppHost не имеет. Совпадение держат
/// имена из <see cref="ReplicaFeeds" />, которые сервис и так обязан знать, и
/// настройки из раздела «JetStream» в docs/architecture/integration.md. Без
/// Docker тест падает, а не пропускается: пропуск здесь выглядел бы как
/// проверенное потребление.
/// </remarks>
public sealed class NatsUnderTest : IAsyncDisposable
{
    private readonly NatsContainer container;
    private readonly NatsConnection connection;

    private NatsUnderTest(NatsContainer container, NatsConnection connection)
    {
        this.container = container;
        this.connection = connection;
        JetStream = new NatsJSContext(connection);
    }

    public string Url => container.GetConnectionString();

    public INatsJSContext JetStream { get; }

    /// <param name="withDurables">
    /// <c>false</c> оставляет streams без durable: так проверяется, что сервис
    /// не заводит durable сам.
    /// </param>
    /// <param name="streamMaxAge">
    /// Окно хранения стримов; по умолчанию — то же, что у топологии AppHost.
    /// Другое значение проверяет, что сервис сверяет с ним срок жизни ключей.
    /// </param>
    public static async Task<NatsUnderTest> Start(bool withDurables = true, TimeSpan? streamMaxAge = null)
    {
        var container = new NatsBuilder("nats:2.10-alpine").Build();
        await container.StartAsync();

        var connection = new NatsConnection(new NatsOpts { Url = container.GetConnectionString() });
        var bus = new NatsUnderTest(container, connection);

        foreach (var feed in ReplicaFeeds.All)
        {
            await bus.JetStream.CreateStreamAsync(new StreamConfig(feed.Stream, [Subjects(feed)])
            {
                Retention = StreamConfigRetention.Limits,
                Storage = StreamConfigStorage.File,
                MaxAge = streamMaxAge ?? ReplicaFeeds.StreamMaxAge,
                DuplicateWindow = TimeSpan.FromMinutes(2),
            });

            if (withDurables)
            {
                await bus.JetStream.CreateOrUpdateConsumerAsync(feed.Stream, new ConsumerConfig(feed.Durable)
                {
                    FilterSubject = Subjects(feed),
                    AckPolicy = ConsumerConfigAckPolicy.Explicit,
                    DeliverPolicy = ConsumerConfigDeliverPolicy.All,
                });
            }
        }

        // Стрим адресных фактов, куда пишет релей. Durable на нём сервису не
        // нужен — свой выход он не читает, — а тест читает его упорядоченным
        // потребителем без позиции на сервере.
        await bus.JetStream.CreateStreamAsync(new StreamConfig(FactsStream, ["events.notifications.>"])
        {
            Retention = StreamConfigRetention.Limits,
            Storage = StreamConfigStorage.File,
            MaxAge = streamMaxAge ?? ReplicaFeeds.StreamMaxAge,
            DuplicateWindow = TimeSpan.FromMinutes(2),
        });

        return bus;
    }

    public const string FactsStream = "NOTIFICATIONS_EVENTS";

    /// <summary>
    /// Все адресные факты, опубликованные в шину к этому моменту, вместе с
    /// заголовком <c>Nats-Msg-Id</c> каждого.
    /// </summary>
    public async Task<IReadOnlyList<(Notification Fact, string? MessageId)>> PublishedFacts()
    {
        var stream = await JetStream.GetStreamAsync(FactsStream);
        var total = (int)stream.Info.State.Messages;
        if (total == 0)
        {
            return [];
        }

        var consumer = await JetStream.CreateOrderedConsumerAsync(FactsStream);
        var facts = new List<(Notification, string?)>(total);

        await foreach (var message in consumer.ConsumeAsync<byte[]>())
        {
            if (message.Subject != NotificationDispatcher.Subject)
            {
                throw new InvalidOperationException($"fact published to {message.Subject}, not {NotificationDispatcher.Subject}");
            }

            var messageId = message.Headers is { } headers && headers.TryGetValue("Nats-Msg-Id", out var id) ? id.ToString() : null;
            facts.Add((Notification.Parser.ParseFrom(message.Data), messageId));

            if (facts.Count == total)
            {
                break;
            }
        }

        return facts;
    }

    /// <summary>
    /// Публикует событие так, как это делает producer: subject повода и
    /// <c>Nats-Msg-Id</c>. Идентификатор публикации задаётся отдельно от
    /// <c>event_id</c>, потому что повтор с тем же заголовком внутри окна
    /// отсекает сервер, и тест на повтор проверял бы шину, а не потребителя.
    /// </summary>
    public async Task Publish(string subject, IMessage message, string? messageId = null)
    {
        var ack = await JetStream.PublishAsync(
            subject,
            message.ToByteArray(),
            opts: new NatsJSPubOpts { MsgId = messageId ?? Guid.NewGuid().ToString() });

        ack.EnsureSuccess();
    }

    /// <summary>Сколько сообщений durable ещё не подтверждено потребителем.</summary>
    public async Task<ulong> Unacknowledged(ReplicaFeed feed)
    {
        var consumer = await JetStream.GetConsumerAsync(feed.Stream, feed.Durable);
        await consumer.RefreshAsync();
        return consumer.Info.NumPending + (ulong)consumer.Info.NumAckPending;
    }

    private static string Subjects(ReplicaFeed feed) => $"events.{feed.Source}.>";

    public async ValueTask DisposeAsync()
    {
        await connection.DisposeAsync();
        await container.DisposeAsync();
    }
}
