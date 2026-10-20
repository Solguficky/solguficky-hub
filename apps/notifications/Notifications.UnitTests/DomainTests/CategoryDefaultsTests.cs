using Notifications.Domain;
using Notifications.V1;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.DomainTests;

/// <summary>
/// Умолчание «Нового в боте» от среды (ADR-069, п. 5): параметр выключен по
/// умолчанию, stage включает его своими values.
/// </summary>
public class CategoryDefaultsTests
{
    private static readonly IReadOnlyDictionary<NotificationCategory, bool> Nothing =
        new Dictionary<NotificationCategory, bool>();

    private static readonly string[] HubRights = ["access_hub", "place_bids"];

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("  ")]
    public void Parse_Unset_IsProductOff(string? value)
    {
        CategoryDefaults.Parse(value).Of(NotificationCategory.ReleaseNotes).ShouldBeFalse();
    }

    [Theory]
    [InlineData("true", true)]
    [InlineData("True", true)]
    [InlineData("false", false)]
    public void Parse_Boolean_IsTaken(string value, bool expected)
    {
        CategoryDefaults.Parse(value).Of(NotificationCategory.ReleaseNotes).ShouldBe(expected);
    }

    /// <summary>Опечатка в values не выключает сводки молча, а роняет старт.</summary>
    [Fact]
    public void Parse_NotBoolean_Throws()
    {
        Should.Throw<InvalidOperationException>(() => CategoryDefaults.Parse("yes"))
            .Message.ShouldContain(CategoryDefaults.ReleaseNotesVariable);
    }

    [Fact]
    public void Of_OtherCategory_IsDictionaryValue()
    {
        var stage = new CategoryDefaults(ReleaseNotes: true);

        NotificationCategories.All.Where(category => category != NotificationCategory.ReleaseNotes)
            .ShouldAllBe(category => stage.Of(category) == NotificationCategories.DefaultEnabled(category));
    }

    [Fact]
    public void Global_StageDefaultOn_ShowsReleaseNotesEnabledToUntouched()
    {
        var snapshot = EffectivePreference.Global(Guid.NewGuid(), Nothing, HubRights, new CategoryDefaults(true));

        snapshot.Categories.Single(state => state.Category == NotificationCategory.ReleaseNotes).Enabled.ShouldBeTrue();
    }

    /// <summary>Сохранённое значение сильнее умолчания среды.</summary>
    [Fact]
    public void Global_StageDefaultOn_KeepsStoredOff()
    {
        var stored = new Dictionary<NotificationCategory, bool> { [NotificationCategory.ReleaseNotes] = false };

        var snapshot = EffectivePreference.Global(Guid.NewGuid(), stored, HubRights, new CategoryDefaults(true));

        snapshot.Categories.Single(state => state.Category == NotificationCategory.ReleaseNotes).Enabled.ShouldBeFalse();
    }
}
