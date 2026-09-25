namespace Notifications.Replica;

/// <summary>
/// Один поток чужих фактов: откуда читать и как разбирать сообщение.
/// </summary>
public sealed record ReplicaFeed(string Source, string Stream, string Durable, Func<ReadOnlyMemory<byte>, Decoded> Decode);

/// <summary>
/// Потоки, из которых собирается реплика. Имена streams и durable повторяют
/// топологию AppHost (<c>infra/apphost/Configuration/Infrastructure/JetStreamTopology.cs</c>):
/// durable создаёт она, а сервис только привязывается к нему по имени и падает,
/// если его нет (docs/architecture/integration.md, раздел «JetStream»).
/// </summary>
public static class ReplicaFeeds
{
    public const string MeetupsSource = "meetups";
    public const string IdentitySource = "identity";

    /// <summary>
    /// Окно хранения стримов. Ключ дедупликации держится не меньше: иначе
    /// повтор, который стрим ещё способен доставить, прошёл бы как новое
    /// событие.
    /// </summary>
    public static readonly TimeSpan StreamMaxAge = TimeSpan.FromDays(7);

    public static readonly ReplicaFeed Meetups = new(
        MeetupsSource,
        "MEETUPS_EVENTS",
        "notifications-meetups-events",
        ReplicaMapping.Meetup);

    public static readonly ReplicaFeed Identity = new(
        IdentitySource,
        "IDENTITY_EVENTS",
        "notifications-identity-events",
        ReplicaMapping.Identity);

    public static readonly IReadOnlyList<ReplicaFeed> All = [Meetups, Identity];
}
