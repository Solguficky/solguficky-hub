using Notifications.Reminders;

namespace Notifications.ReleaseNotes;

/// <summary>Расписание суточной сводки: ближайший час сводки по времени сообщества.</summary>
public static class ReleaseSchedule
{
    /// <summary>
    /// Ближайший час сводки строго после <paramref name="now" />.
    /// </summary>
    /// <remarks>
    /// Строго после, а не «не раньше»: закрытие сводки в её же час назначает
    /// следующую на завтра, а не на тот же момент. Отсчёт от <paramref name="now" />,
    /// а не от пропущенного часа: сервис, пролежавший трое суток, отправляет одну
    /// сводку, а не три подряд, — сводка раз в сутки, а не за каждые сутки.
    /// </remarks>
    public static DateTimeOffset Next(CommunityTime community, TimeSpan summaryTime, DateTimeOffset now)
    {
        var local = TimeZoneInfo.ConvertTime(now, community.Zone).DateTime;
        var today = community.Instant(local.Date + summaryTime);

        return today > now ? today : community.Instant(local.Date.AddDays(1) + summaryTime);
    }
}
