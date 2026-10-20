namespace Notifications.Reminders;

/// <summary>
/// Вид напоминания о дедлайне избранного лота: за час и ближе к дедлайну.
/// </summary>
/// <remarks>
/// Вид, а не два разных повода: получатель у них один и тот же, различаются
/// они только моментом. Разные типы фактов нужны потому, что ключ повода
/// держит одно напоминание на лот на человека, — два момента не должны
/// совпасть на одном ключе (ADR-063, дополнение 2026-10-20).
/// </remarks>
public enum LotReminderKind
{
    /// <summary>За час до дедлайна (ADR-063, п. 3).</summary>
    Hour,

    /// <summary>
    /// За 15 минут до дедлайна (ADR-063, дополнение 2026-10-20): второе
    /// напоминание, когда часовое осталось без ответа.
    /// </summary>
    Close,
}

/// <summary>Вид задания в строке таблицы: вид в базе и вид в коде.</summary>
public static class LotReminderKinds
{
    public static string Text(LotReminderKind kind) => kind switch
    {
        LotReminderKind.Hour => "hour",
        LotReminderKind.Close => "close",
        _ => throw new ArgumentOutOfRangeException(nameof(kind)),
    };

    /// <summary>Вид строки таблицы; неизвестный вид — нарушение схемы.</summary>
    public static LotReminderKind Parse(string text) => text switch
    {
        "hour" => LotReminderKind.Hour,
        "close" => LotReminderKind.Close,
        _ => throw new ArgumentOutOfRangeException(nameof(text)),
    };
}
