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

    /// <summary>
    /// За сколько до дедлайна лота напоминать второй раз: ближе к дедлайну,
    /// когда часовое осталось без ответа (ADR-063, дополнение 2026-10-20).
    /// Настройкой остаётся по той же причине, что и у часового.
    /// </summary>
    public TimeSpan CloseLead { get; set; } = TimeSpan.FromMinutes(15);
}
