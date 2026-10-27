namespace Notifications.Reminders;

/// <summary>Настройки напоминания о счёте и его sweeper'а.</summary>
public sealed class InvoiceReminderOptions
{
    public const string SectionName = "Notifications:InvoiceReminders";

    /// <summary>
    /// Сколько после выставления счёта проходит, прежде чем напоминание
    /// становится уместным. Момент раньше — совпадает с вестью о покупке:
    /// счёт выставляется сразу за продажей, и напоминание рядом с ней — дубль
    /// (PER-726). Тот же допуск записан в миграции 044. Настройкой остаётся
    /// по той же причине, что у сходки: смена значения уже созданные задания
    /// не пересчитывает.
    /// </summary>
    public TimeSpan IssueGap { get; set; } = TimeSpan.FromHours(1);
}
