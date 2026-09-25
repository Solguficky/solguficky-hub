using NATS.Client.JetStream;
using NATS.Client.JetStream.Models;

namespace AppHost.Configuration.Infrastructure;

/// <summary>
/// Streams и durable consumers шины как данные. Сервер JetStream объявлять их
/// в конфиге не умеет, поэтому AppHost применяет эту таблицу сам, когда узел
/// NATS готов. Каталог с обоснованием — docs/architecture/integration.md,
/// раздел «JetStream».
/// </summary>
internal static class JetStreamTopology
{
    /// <summary>
    /// Стрим не источник истины: потерявший позицию потребитель собирает
    /// состояние с нуля (PER-70). Окно хранения задаёт только, сколько простоя
    /// потребитель переживает без пересборки.
    /// </summary>
    public static readonly TimeSpan MaxAge = TimeSpan.FromDays(7);

    /// <summary>
    /// Окно серверной дедупликации по заголовку <c>Nats-Msg-Id</c>. Это
    /// оптимизация publisher'а, а не гарантия: повтор после окна и redelivery
    /// потребителю она не ловит, их ловит потребитель по <c>event_id</c>.
    /// </summary>
    public static readonly TimeSpan DuplicateWindow = TimeSpan.FromMinutes(2);

    public static readonly IReadOnlyList<StreamSpec> Streams =
    [
        new("MEETUPS_EVENTS", "events.meetups.>"),
        new("IDENTITY_EVENTS", "events.identity.>"),

        // Адресные факты Notifications (PER-216). Стрим заведён раньше
        // первого канала: retention limits держит опубликованное до появления
        // его durable, и факты, вынесенные релеем до того, не теряются.
        new("NOTIFICATIONS_EVENTS", "events.notifications.>"),
    ];

    /// <summary>
    /// Потребители, для которых durable объявляется заранее, и стримы, которые
    /// каждый из них читает. Durable принадлежит потребителю, а создаётся здесь:
    /// пришедшее до первого старта потребителя ждёт в нём, а не теряется.
    /// </summary>
    /// <remarks>
    /// Список пар, а не произведение всех потребителей на все стримы: сервис не
    /// читает собственный выход, и durable <c>notifications-notifications-events</c>
    /// копил бы сообщения, которые никто не подтверждает. <c>nats-tester</c>
    /// читает всё: у него свои durable, чтобы ручная проверка не сдвигала
    /// позицию продуктового.
    /// </remarks>
    public static readonly IReadOnlyList<ConsumerStreams> Consumers =
    [
        new("notifications", ["MEETUPS_EVENTS", "IDENTITY_EVENTS"]),
        new("nats-tester", ["MEETUPS_EVENTS", "IDENTITY_EVENTS", "NOTIFICATIONS_EVENTS"]),
    ];

    public static IEnumerable<ConsumerSpec> Durables =>
        from consumer in Consumers
        from streamName in consumer.Streams
        let stream = Streams.Single(candidate => candidate.Name == streamName)
        select new ConsumerSpec(DurableName(consumer.Consumer, stream.Name), stream.Name, stream.Subject);

    /// <summary>
    /// <c>&lt;потребитель&gt;-&lt;стрим в нижнем регистре через дефис&gt;</c>:
    /// <c>notifications</c> и <c>MEETUPS_EVENTS</c> дают
    /// <c>notifications-meetups-events</c>. Имя постоянно, поэтому рестарт
    /// потребителя продолжает с последнего подтверждённого сообщения.
    /// </summary>
    public static string DurableName(string consumer, string stream) =>
        $"{consumer}-{stream.ToLowerInvariant().Replace('_', '-')}";

    public static StreamConfig ToConfig(StreamSpec spec) =>
        new(spec.Name, [spec.Subject])
        {
            Retention = StreamConfigRetention.Limits,
            Storage = StreamConfigStorage.File,
            Discard = StreamConfigDiscard.Old,
            MaxAge = MaxAge,
            DuplicateWindow = DuplicateWindow,
            NumReplicas = 1,
        };

    public static ConsumerConfig ToConfig(ConsumerSpec spec) =>
        new(spec.Durable)
        {
            FilterSubject = spec.FilterSubject,
            AckPolicy = ConsumerConfigAckPolicy.Explicit,
            DeliverPolicy = ConsumerConfigDeliverPolicy.All,
        };

    /// <summary>
    /// Идемпотентно: повторный старт на том же томе не меняет ничего. Правку,
    /// которую JetStream на живом объекте не принимает — storage стрима, переход
    /// retention в workqueue или из него, deliver policy durable, — сервер
    /// отвергает, и применение падает;
    /// лечится удалением тома NATS.
    /// </summary>
    public static async Task ApplyAsync(INatsJSContext js, CancellationToken cancellationToken)
    {
        foreach (var stream in Streams)
        {
            await js.CreateOrUpdateStreamAsync(ToConfig(stream), cancellationToken);
        }

        foreach (var durable in Durables)
        {
            await js.CreateOrUpdateConsumerAsync(durable.Stream, ToConfig(durable), cancellationToken);
        }
    }
}

internal sealed record StreamSpec(string Name, string Subject);

internal sealed record ConsumerStreams(string Consumer, IReadOnlyList<string> Streams);

internal sealed record ConsumerSpec(string Durable, string Stream, string FilterSubject);
