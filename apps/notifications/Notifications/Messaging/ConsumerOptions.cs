namespace Notifications.Messaging;

/// <summary>Общая политика чтения шины и хранения ключей повтора.</summary>
public sealed class ConsumerOptions
{
    // Существующий ключ сохраняется: развёртывания и тесты уже задают его.
    public const string SectionName = "Notifications:Replica";
    public static readonly TimeSpan StreamMaxAge = TimeSpan.FromDays(7);
    public TimeSpan KeyRetention { get; set; } = StreamMaxAge + TimeSpan.FromDays(1);
    public TimeSpan PrunePeriod { get; set; } = TimeSpan.FromHours(1);
    public TimeSpan RetryDelay { get; set; } = TimeSpan.FromSeconds(5);
}
