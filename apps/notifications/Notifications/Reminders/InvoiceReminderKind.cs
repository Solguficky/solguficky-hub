namespace Notifications.Reminders;

/// <summary>
/// Вид напоминания о неоплаченном счёте: за сутки, за 12 часов и за час до
/// срока оплаты (PER-726).
/// </summary>
/// <remarks>
/// Вид, а не разные поводы: получатель у них один и тот же — победитель
/// продажи, — различаются они только моментом. Повод факта — сработавшее
/// задание, поэтому у каждого момента свой ключ повода, даже когда тип факта
/// у двух видов общий.
///
/// <see cref="AfterWin" /> и <see cref="BeforeDue" /> — виды схемы PER-330:
/// живые строки этих видов миграция 044 пересчитала в новые, а новые задания
/// их не получают. Разбор их остаётся, чтобы строка старого вида, заведённая
/// прежним образом в окне выката, сработала как раньше, а не уронила проход.
/// </remarks>
public enum InvoiceReminderKind
{
    /// <summary>Схема PER-330: примерно через 12 часов после выставления.</summary>
    AfterWin,

    /// <summary>Схема PER-330: за сутки до срока оплаты.</summary>
    BeforeDue,

    /// <summary>За 24 часа до срока оплаты.</summary>
    DayBefore,

    /// <summary>За 12 часов до срока оплаты.</summary>
    HalfDayBefore,

    /// <summary>За час до срока оплаты.</summary>
    HourBefore,
}

/// <summary>Вид задания в строке таблицы: вид в базе и вид в коде.</summary>
public static class InvoiceReminderKinds
{
    /// <summary>Виды, которые заводит грин, — по порядку моментов.</summary>
    public static readonly InvoiceReminderKind[] Scheduled =
        [InvoiceReminderKind.DayBefore, InvoiceReminderKind.HalfDayBefore, InvoiceReminderKind.HourBefore];

    public static string Text(InvoiceReminderKind kind) => kind switch
    {
        InvoiceReminderKind.AfterWin => "after_win",
        InvoiceReminderKind.BeforeDue => "before_due",
        InvoiceReminderKind.DayBefore => "before_24h",
        InvoiceReminderKind.HalfDayBefore => "before_12h",
        InvoiceReminderKind.HourBefore => "before_1h",
        _ => throw new ArgumentOutOfRangeException(nameof(kind)),
    };

    /// <summary>Вид строки таблицы; неизвестный вид — нарушение схемы.</summary>
    public static InvoiceReminderKind Parse(string text) => text switch
    {
        "after_win" => InvoiceReminderKind.AfterWin,
        "before_due" => InvoiceReminderKind.BeforeDue,
        "before_24h" => InvoiceReminderKind.DayBefore,
        "before_12h" => InvoiceReminderKind.HalfDayBefore,
        "before_1h" => InvoiceReminderKind.HourBefore,
        _ => throw new ArgumentOutOfRangeException(nameof(text)),
    };

    /// <summary>
    /// За сколько до срока оплаты срабатывает вид. Продуктовые значения —
    /// решение владельца от 24.10.2026 (PER-726); те же значения записаны в
    /// миграции 044, которая пересчитала задания старой схемы.
    /// </summary>
    public static TimeSpan Lead(InvoiceReminderKind kind) => kind switch
    {
        InvoiceReminderKind.DayBefore => TimeSpan.FromHours(24),
        InvoiceReminderKind.HalfDayBefore => TimeSpan.FromHours(12),
        InvoiceReminderKind.HourBefore => TimeSpan.FromHours(1),
        _ => throw new ArgumentOutOfRangeException(nameof(kind)),
    };
}
