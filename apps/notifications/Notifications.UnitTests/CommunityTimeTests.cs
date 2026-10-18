using Notifications.Reminders;
using Notifications.Replica;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests;

/// <summary>
/// Перевод расписания реплики в момент начала, от которого считается
/// напоминание. Чистая функция: пояс приходит значением, часов нет.
/// </summary>
public class CommunityTimeTests
{
    private static readonly CommunityTime Moscow = CommunityTime.Parse("Europe/Moscow");

    private static readonly ScheduleColumns FixedStart =
        new("fixed", "day_start", new DateOnly(2026, 10, 15), new TimeOnly(19, 30), null, null);

    [Fact]
    public void StartsAt_FixedStartTime_IsLocalTimeInCommunityZone()
    {
        Moscow.StartsAt(Meetup(FixedStart)).ShouldBe(new DateTimeOffset(2026, 10, 15, 16, 30, 0, TimeSpan.Zero));
    }

    /// <summary>У интервала напоминают о его начале, а не о конце.</summary>
    [Fact]
    public void StartsAt_FixedInterval_IsStartOfInterval()
    {
        var interval = new ScheduleColumns(
            "fixed",
            "interval",
            new DateOnly(2026, 10, 15),
            new TimeOnly(19, 0),
            new DateOnly(2026, 10, 16),
            new TimeOnly(2, 0));

        Moscow.StartsAt(Meetup(interval)).ShouldBe(new DateTimeOffset(2026, 10, 15, 16, 0, 0, TimeSpan.Zero));
    }

    /// <summary>
    /// Задание рождается только у видимой планируемой сходки с зафиксированным
    /// временем. Каждый случай ниже снимает живое задание, поэтому снятие,
    /// отмена и потеря времени не требуют разбора повода.
    /// </summary>
    [Theory]
    [MemberData(nameof(NoMoment))]
    public void StartsAt_NothingToRemindAbout_IsNull(string reason, MeetupReplicaState state)
    {
        Moscow.StartsAt(state).ShouldBeNull(reason);
    }

    public static TheoryData<string, MeetupReplicaState> NoMoment() => new()
    {
        { "day without time", Meetup(FixedStart with { Precision = "day", StartTime = null }) },
        { "tentative date", Meetup(FixedStart with { Form = "tentative" }) },
        { "no date", Meetup(ScheduleColumns.NoDate) },
        { "unpublished", Meetup(FixedStart, visibility: "hidden") },
        { "cancelled", Meetup(FixedStart, lifecycle: "cancelled") },
        { "held", Meetup(FixedStart, lifecycle: "held") },
    };

    /// <summary>
    /// Несуществующий час перевода вперёд сдвигается на величину скачка, а не
    /// теряет напоминание: 02:30 в ночь перехода в Берлине — это 03:30 CEST.
    /// </summary>
    [Fact]
    public void Instant_SkippedLocalHour_ShiftsForwardByTheGap()
    {
        var berlin = CommunityTime.Parse("Europe/Berlin");

        berlin.Instant(new DateTime(2026, 3, 29, 2, 30, 0)).ShouldBe(new DateTimeOffset(2026, 3, 29, 1, 30, 0, TimeSpan.Zero));
    }

    /// <summary>Двойной час перевода назад читается по стандартному смещению.</summary>
    [Fact]
    public void Instant_RepeatedLocalHour_ReadsStandardOffset()
    {
        var berlin = CommunityTime.Parse("Europe/Berlin");

        berlin.Instant(new DateTime(2026, 10, 25, 2, 30, 0)).ShouldBe(new DateTimeOffset(2026, 10, 25, 1, 30, 0, TimeSpan.Zero));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("Mars/Olympus")]
    public void Parse_MissingOrUnknownZone_FailsInsteadOfFallingBackToUtc(string? value)
    {
        Should.Throw<InvalidOperationException>(() => CommunityTime.Parse(value))
            .Message.ShouldContain(CommunityTime.TimeZoneVariable);
    }

    private static MeetupReplicaState Meetup(
        ScheduleColumns schedule,
        string lifecycle = "planned",
        string visibility = "visible") =>
        new(Guid.Empty, "Сходка", "", "Бар", "встреча", "", lifecycle, visibility, null, schedule);
}
