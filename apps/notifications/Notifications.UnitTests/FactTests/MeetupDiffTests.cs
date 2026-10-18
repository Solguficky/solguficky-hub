using Notifications.Facts;
using Notifications.Replica;
using Notifications.V1;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.FactTests;

/// <summary>
/// Разница снимка с репликой. Из неё одна категория продукта «изменение
/// сведений или состояния» получает два вида факта, а пустая разница
/// поводом не становится.
/// </summary>
public class MeetupDiffTests
{
    private static readonly MeetupReplicaState Before = new(
        Guid.CreateVersion7(),
        "Сходка",
        "Описание",
        "Бар",
        "встреча",
        string.Empty,
        "planned",
        "visible",
        new DateTimeOffset(2026, 9, 1, 12, 0, 0, TimeSpan.Zero),
        new ScheduleColumns("fixed", "day_start", new DateOnly(2026, 10, 15), new TimeOnly(19, 30), null, null));

    [Fact]
    public void Between_SameSnapshot_IsEmpty() =>
        MeetupDiff.Between(Before, Before with { }).ShouldBeEmpty();

    /// <summary>
    /// Автор и отметка первой публикации людям как изменение не видны:
    /// возврат в публикацию меняет видимость, а не отметку.
    /// </summary>
    [Fact]
    public void Between_AuthorAndFirstPublicationMark_AreNotAspects() =>
        MeetupDiff.Between(Before, Before with { Author = Guid.CreateVersion7(), FirstPublishedAt = null })
            .ShouldBeEmpty();

    [Fact]
    public void Between_TitleEdited_IsInformationChange()
    {
        var changed = MeetupDiff.Between(Before, Before with { Title = "Пятничная" });

        changed.ShouldBe([MeetupAspect.Title]);
        changed.ShouldAllBe(aspect => MeetupDiff.Information.Contains(aspect));
    }

    [Fact]
    public void Between_Cancelled_IsStateChange()
    {
        var changed = MeetupDiff.Between(Before, Before with { Lifecycle = "cancelled" });

        changed.ShouldBe([MeetupAspect.Lifecycle]);
        changed.ShouldAllBe(aspect => MeetupDiff.State.Contains(aspect));
    }

    /// <summary>
    /// Перенос отдельного типа события не имеет: он узнаётся по расписанию в
    /// теле, и сдвиг одного лишь времени — тоже перенос.
    /// </summary>
    [Theory]
    [MemberData(nameof(Moves))]
    public void Between_ScheduleMoved_IsScheduleAspect(ScheduleColumns moved) =>
        MeetupDiff.Between(Before, Before with { Schedule = moved }).ShouldBe([MeetupAspect.Schedule]);

    public static TheoryData<ScheduleColumns> Moves() => new()
    {
        new ScheduleColumns("fixed", "day_start", new DateOnly(2026, 10, 16), new TimeOnly(19, 30), null, null),
        new ScheduleColumns("fixed", "day_start", new DateOnly(2026, 10, 15), new TimeOnly(20, 0), null, null),
        new ScheduleColumns("fixed", "day", new DateOnly(2026, 10, 15), null, null, null),
        new ScheduleColumns("tentative", "day_start", new DateOnly(2026, 10, 15), new TimeOnly(19, 30), null, null),
        ScheduleColumns.NoDate,
    };

    [Fact]
    public void Between_SeveralAspects_ListedInContractOrder()
    {
        var after = Before with { Visibility = "hidden", Venue = "Парк", Title = "Другая" };

        MeetupDiff.Between(Before, after)
            .ShouldBe([MeetupAspect.Title, MeetupAspect.Venue, MeetupAspect.Visibility], ignoreOrder: false);
    }

    /// <summary>
    /// Два множества делят все аспекты контракта без остатка: новый аспект,
    /// не отнесённый ни к сведениям, ни к состоянию, уронит этот тест.
    /// </summary>
    [Fact]
    public void InformationAndState_PartitionEveryAspect()
    {
        var all = Enum.GetValues<MeetupAspect>().Where(aspect => aspect != MeetupAspect.Unspecified).ToArray();

        MeetupDiff.Information.Intersect(MeetupDiff.State).ShouldBeEmpty();
        MeetupDiff.Information.Union(MeetupDiff.State).ShouldBe(all, ignoreOrder: true);
    }
}
