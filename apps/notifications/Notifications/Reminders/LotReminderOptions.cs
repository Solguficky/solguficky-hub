namespace Notifications.Reminders;

/// <summary>Настройки напоминания о лоте и его sweeper'а.</summary>
public sealed class LotReminderOptions
{
    public const string SectionName = "Notifications:LotReminders";

    /// <summary>
    /// За сколько до дедлайна лота напоминать. Продуктовое значение — час, и
    /// оно одно (ADR-063, п.3). Настройкой остаётся ради тестов, где ждать час
    /// нечем, и по той же причине, что у сходки: смена значения уже созданные
    /// задания не пересчитывает.
    /// </summary>
    public TimeSpan Lead { get; set; } = TimeSpan.FromHours(1);
}
