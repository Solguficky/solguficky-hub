namespace Notifications.Reminders;

/// <summary>
/// Вид напоминания о неоплаченном счёте: после победы и перед сроком оплаты.
/// </summary>
/// <remarks>
/// Вид, а не два разных повода: получатель у них один и тот же — победитель
/// продажи, — различаются они только моментом. Разные типы фактов нужны
/// потому, что ключ повода держит одно напоминание на счёт, и два момента не
/// должны совпасть на одном ключе.
/// </remarks>
public enum InvoiceReminderKind
{
    /// <summary>Примерно через 12 часов после победы.</summary>
    AfterWin,

    /// <summary>За сутки до срока оплаты.</summary>
    BeforeDue,
}

/// <summary>Вид задания в строке таблицы: вид в базе и вид в коде.</summary>
public static class InvoiceReminderKinds
{
    public static string Text(InvoiceReminderKind kind) => kind switch
    {
        InvoiceReminderKind.AfterWin => "after_win",
        InvoiceReminderKind.BeforeDue => "before_due",
        _ => throw new ArgumentOutOfRangeException(nameof(kind)),
    };

    /// <summary>Вид строки таблицы; неизвестный вид — нарушение схемы.</summary>
    public static InvoiceReminderKind Parse(string text) => text switch
    {
        "after_win" => InvoiceReminderKind.AfterWin,
        "before_due" => InvoiceReminderKind.BeforeDue,
        _ => throw new ArgumentOutOfRangeException(nameof(text)),
    };
}
