using Notifications.ReleaseNotes;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.ReleaseNotesTests;

/// <summary>Настройки суточной сводки: проверка, которая роняет старт на неверном значении.</summary>
public class ReleaseNotesOptionsTests
{
    [Fact]
    public void IsValid_SummaryTimeOutsideDay_IsFalse()
    {
        ReleaseNotesOptions.IsValid(new ReleaseNotesOptions { SummaryTime = TimeSpan.FromHours(24) }).ShouldBeFalse();
    }

    [Fact]
    public void IsValid_ZeroSweepPeriod_IsFalse()
    {
        ReleaseNotesOptions.IsValid(new ReleaseNotesOptions { SweepPeriod = TimeSpan.Zero }).ShouldBeFalse();
    }

    [Fact]
    public void IsValid_Defaults_IsTrueAtNoon()
    {
        var defaults = new ReleaseNotesOptions();

        ReleaseNotesOptions.IsValid(defaults).ShouldBeTrue();
        defaults.SummaryTime.ShouldBe(TimeSpan.FromHours(12));
    }
}
