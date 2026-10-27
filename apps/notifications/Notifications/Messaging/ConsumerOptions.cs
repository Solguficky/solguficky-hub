namespace Notifications.Messaging;

/// <summary>Общая политика чтения шины и хранения ключей повтора.</summary>
public sealed class ConsumerOptions
{
    // Существующий ключ сохраняется: развёртывания и тесты уже задают его.
    public const string SectionName = "Notifications:Replica";

    /// <summary>Окно хранения стримов Meetups и Identity в топологии AppHost.</summary>
    public static readonly TimeSpan StreamMaxAge = TimeSpan.FromDays(7);

    /// <summary>Своё окно <c>AUCTION_EVENTS</c> в топологии AppHost (PER-758).</summary>
    public static readonly TimeSpan AuctionStreamMaxAge = TimeSpan.FromDays(90);

    /// <summary>
    /// Срок ключа повтора по имени стрима: окно стрима и день запаса (PER-761).
    /// Умолчания лежат здесь, а не в среде: чарт прода их не задаёт. Ключ
    /// конфигурации — <c>Notifications:Replica:KeyRetention:&lt;стрим&gt;</c>.
    /// </summary>
    public Dictionary<string, TimeSpan> KeyRetention { get; set; } = new(StringComparer.OrdinalIgnoreCase)
    {
        ["MEETUPS_EVENTS"] = StreamMaxAge + TimeSpan.FromDays(1),
        ["IDENTITY_EVENTS"] = StreamMaxAge + TimeSpan.FromDays(1),
        ["AUCTION_EVENTS"] = AuctionStreamMaxAge + TimeSpan.FromDays(1),
    };

    public TimeSpan PrunePeriod { get; set; } = TimeSpan.FromHours(1);
    public TimeSpan RetryDelay { get; set; } = TimeSpan.FromSeconds(5);

    /// <summary>
    /// Срок ключей стрима. Стрима без срока нет: потребитель без него не
    /// привязывается, а чистка не угадывает порог.
    /// </summary>
    public TimeSpan KeyRetentionFor(string stream) =>
        KeyRetention.TryGetValue(stream, out var retention)
            ? retention
            : throw new InvalidOperationException($"{SectionName}:KeyRetention has no entry for stream {stream}");

    /// <summary>Наибольший срок ключей: им меряется то, что свой поток не знает.</summary>
    public TimeSpan LongestKeyRetention => KeyRetention.Values.Max();
}
