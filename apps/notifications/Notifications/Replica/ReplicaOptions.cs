namespace Notifications.Replica;

/// <summary>Настройки реплики чужих фактов.</summary>
public sealed class ReplicaOptions
{
    public const string SectionName = "Notifications:Replica";

    /// <summary>
    /// Сколько держится ключ дедупликации. Не меньше окна хранения стрима
    /// (<see cref="ReplicaFeeds.StreamMaxAge" />): повтор, который стрим ещё
    /// способен доставить, должен находить свой ключ. Сутки сверху — запас на
    /// то, что стрим снимает сообщение не в ту же секунду.
    /// </summary>
    public TimeSpan KeyRetention { get; set; } = ReplicaFeeds.StreamMaxAge + TimeSpan.FromDays(1);

    /// <summary>Период прохода чистки ключей.</summary>
    public TimeSpan PrunePeriod { get; set; } = TimeSpan.FromHours(1);

    /// <summary>
    /// Через сколько шина вернёт сообщение, которое не удалось применить из-за
    /// отказа базы. Политика повторов целиком и dead-letter — PER-72.
    /// </summary>
    public TimeSpan RetryDelay { get; set; } = TimeSpan.FromSeconds(5);
}
