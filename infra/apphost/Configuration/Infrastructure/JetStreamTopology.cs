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
    ];

    /// <summary>
    /// Потребители, для которых durable объявляется заранее. Durable
    /// принадлежит потребителю, а создаётся здесь: пришедшее до первого старта
    /// потребителя ждёт в нём, а не теряется. <c>nats-tester</c> держит свои
    /// durable, чтобы ручная проверка не сдвигала позицию продуктового.
    /// </summary>
    public static readonly IReadOnlyList<string> Consumers = ["notifications", "nats-tester"];

    public static IEnumerable<ConsumerSpec> Durables =>
        from consumer in Consumers
        from stream in Streams
        select new ConsumerSpec(DurableName(consumer, stream.Name), stream.Name, stream.Subject);

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
    /// которую JetStream на живом стриме не принимает (storage, retention),
    /// сервер отвергает, и старт падает — лечится удалением тома NATS.
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

internal sealed record ConsumerSpec(string Durable, string Stream, string FilterSubject);
