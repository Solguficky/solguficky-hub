using Notifications.ReleaseNotes;
using Notifications.Reminders;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.ReleaseNotesTests;

/// <summary>
/// Час суточной сводки по времени сообщества (ADR-069, п. 4). Чистая функция:
/// пояс и «сейчас» приходят значениями.
/// </summary>
public class ReleaseScheduleTests
{
    private static readonly CommunityTime Moscow = CommunityTime.Parse("Europe/Moscow");
    private static readonly TimeSpan Noon = TimeSpan.FromHours(12);

    // Полдень в Москве — 09:00 UTC.
    private static readonly DateTimeOffset TodayNoon = new(2026, 10, 20, 9, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Next_BeforeSummaryTime_IsTodayInCommunityZone()
    {
        ReleaseSchedule.Next(Moscow, Noon, TodayNoon.AddHours(-3)).ShouldBe(TodayNoon);
    }

    /// <summary>Закрытие в свой час назначает следующую сводку на завтра, а не на тот же момент.</summary>
    [Fact]
    public void Next_AtSummaryTime_IsTomorrow()
    {
        ReleaseSchedule.Next(Moscow, Noon, TodayNoon).ShouldBe(TodayNoon.AddDays(1));
    }

    [Fact]
    public void Next_AfterSummaryTime_IsTomorrow()
    {
        ReleaseSchedule.Next(Moscow, Noon, TodayNoon.AddHours(5)).ShouldBe(TodayNoon.AddDays(1));
    }

    /// <summary>
    /// День считается по поясу сообщества: 22:30 UTC — уже следующие сутки в
    /// Москве, и сводка у них — полдень этих суток, а не завтрашних по UTC.
    /// </summary>
    [Fact]
    public void Next_LateUtcEvening_CountsCommunityDay()
    {
        var lateUtc = new DateTimeOffset(2026, 10, 20, 22, 30, 0, TimeSpan.Zero);

        ReleaseSchedule.Next(Moscow, Noon, lateUtc).ShouldBe(TodayNoon.AddDays(1));
    }

    /// <summary>Пролежавший сутками сервис назначает одну ближайшую сводку, а не догоняет каждые пропущенные сутки.</summary>
    [Fact]
    public void Next_AfterMissedDays_IsNearestFromNow()
    {
        var resumed = TodayNoon.AddDays(3).AddHours(2);

        ReleaseSchedule.Next(Moscow, Noon, resumed).ShouldBe(TodayNoon.AddDays(4));
    }
}
