namespace Notifications.ReleaseNotes;

/// <summary>Настройки суточной сводки «Что нового» (ADR-069, п. 4).</summary>
public sealed class ReleaseNotesOptions
{
    public const string SectionName = "Notifications:ReleaseNotes";

    /// <summary>
    /// Час сводки по времени сообщества. Полдень выбрал владелец 2026-10-20 на
    /// чекпоинте PER-628: вечерние мержи stage попадают в сводку следующего
    /// дня, а бот не пишет ни рано утром, ни поздно вечером.
    /// </summary>
    public TimeSpan SummaryTime { get; set; } = TimeSpan.FromHours(12);

    /// <summary>
    /// Период прохода. Задаёт, насколько позже своего часа может уйти сводка:
    /// при часе в сутки минута незаметна.
    /// </summary>
    public TimeSpan SweepPeriod { get; set; } = TimeSpan.FromMinutes(1);

    public const string ValidationMessage =
        "Notifications:ReleaseNotes:SummaryTime must be within a day and SweepPeriod positive";

    /// <summary>
    /// Час вне суток назвал бы момент, которого в расписании нет, а нулевой
    /// период уронил бы таймер прохода: оба ловятся на старте.
    /// </summary>
    public static bool IsValid(ReleaseNotesOptions options) =>
        options.SummaryTime >= TimeSpan.Zero && options.SummaryTime < TimeSpan.FromDays(1)
        && options.SweepPeriod > TimeSpan.Zero;
}
