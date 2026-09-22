using Notifications.Domain;
using Notifications.V1;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.DomainTests;

/// <summary>
/// Правило вывода действующего значения категории: переопределение сильнее
/// глобальной настройки, глобальная сильнее умолчания продукта.
/// </summary>
/// <remarks>
/// Правило проверяется здесь, без живой базы, именно потому что хранилище
/// отдаёт только заданные значения и ничего не выводит само. Уедь вывод в SQL —
/// эти утверждения пришлось бы писать против PostgreSQL и держать Docker ради
/// проверки продуктового правила.
/// </remarks>
public class EffectivePreferenceTests
{
    private static readonly IReadOnlyDictionary<NotificationCategory, bool> Nothing =
        new Dictionary<NotificationCategory, bool>();

    [Fact]
    public void Resolve_OverridePresent_WinsOverGlobal()
    {
        EffectivePreference.Resolve(NotificationCategory.MeetupChanged, global: true, @override: false)
            .ShouldBeFalse();

        EffectivePreference.Resolve(NotificationCategory.MeetupChanged, global: false, @override: true)
            .ShouldBeTrue();
    }

    [Fact]
    public void Resolve_NoOverride_UsesGlobal()
    {
        // Та же ветка, в которую попадает снятое переопределение: снятие удаляет
        // строку, и категория снова следует за глобальной настройкой.
        EffectivePreference.Resolve(NotificationCategory.MeetupChanged, global: false, @override: null)
            .ShouldBeFalse();
    }

    [Fact]
    public void Resolve_NeitherSet_UsesProductDefault()
    {
        EffectivePreference.Resolve(NotificationCategory.MeetupChanged, global: null, @override: null)
            .ShouldBeTrue();

        EffectivePreference.Resolve(NotificationCategory.MeetupReminder, global: null, @override: null)
            .ShouldBeFalse();
    }

    [Fact]
    public void Global_NothingConfigured_CarriesEveryCategoryWithItsProductDefault()
    {
        // Критерий «новый человек получает значения по умолчанию без отдельной
        // команды»: ни одной строки в базе нет, а снимок полон.
        var snapshot = EffectivePreference.Global(Guid.NewGuid(), Nothing);

        snapshot.Categories.Select(state => state.Category)
            .ShouldBe(NotificationCategories.All, ignoreOrder: true);

        snapshot.Categories.ShouldAllBe(
            state => state.Enabled == NotificationCategories.DefaultEnabled(state.Category));
    }

    [Fact]
    public void Global_CategoryConfigured_CarriesTheConfiguredValue()
    {
        var snapshot = EffectivePreference.Global(
            Guid.NewGuid(),
            new Dictionary<NotificationCategory, bool> { [NotificationCategory.MeetupPublished] = false });

        Enabled(snapshot.Categories, NotificationCategory.MeetupPublished).ShouldBeFalse();
        Enabled(snapshot.Categories, NotificationCategory.MeetupChanged).ShouldBeTrue();
    }

    [Fact]
    public void Meetup_AnySnapshot_CarriesOnlyCategoriesAMeetupCanHold()
    {
        // Глобальный снимок тотален по словарю, снимок сходки — нет: у «новой
        // опубликованной сходки» и «объявления сообществу» нет формы у сходки.
        var snapshot = EffectivePreference.Meetup(Guid.NewGuid(), Guid.NewGuid(), true, Nothing, Nothing);

        snapshot.Categories.Select(state => state.Category)
            .ShouldBe(NotificationCategories.MeetupScoped, ignoreOrder: true);
    }

    [Fact]
    public void Meetup_GlobalChangedAndNoOverride_FollowsTheGlobalValue()
    {
        // Ядро требования продукта: глобальное значение нигде не скопировано,
        // поэтому его правка видна у уже существующей подписки.
        var snapshot = EffectivePreference.Meetup(
            Guid.NewGuid(),
            Guid.NewGuid(),
            subscribed: true,
            global: new Dictionary<NotificationCategory, bool> { [NotificationCategory.MeetupChanged] = false },
            overrides: Nothing);

        Enabled(snapshot.Categories, NotificationCategory.MeetupChanged).ShouldBeFalse();
    }

    [Fact]
    public void Meetup_OverrideSet_DoesNotFollowTheGlobalValue()
    {
        var snapshot = EffectivePreference.Meetup(
            Guid.NewGuid(),
            Guid.NewGuid(),
            subscribed: true,
            global: new Dictionary<NotificationCategory, bool> { [NotificationCategory.MeetupChanged] = false },
            overrides: new Dictionary<NotificationCategory, bool> { [NotificationCategory.MeetupChanged] = true });

        Enabled(snapshot.Categories, NotificationCategory.MeetupChanged).ShouldBeTrue();
    }

    [Fact]
    public void Meetup_NotSubscribed_StillCarriesCategoryValues()
    {
        // Две плоскости независимы: значения категорий стоят независимо от того,
        // подписан ли человек сейчас, и одна не выводится из другой.
        var snapshot = EffectivePreference.Meetup(
            Guid.NewGuid(),
            Guid.NewGuid(),
            subscribed: false,
            global: Nothing,
            overrides: new Dictionary<NotificationCategory, bool> { [NotificationCategory.MeetupReminder] = true });

        snapshot.Subscribed.ShouldBeFalse();
        Enabled(snapshot.Categories, NotificationCategory.MeetupReminder).ShouldBeTrue();
    }

    private static bool Enabled(IReadOnlyList<CategoryState> categories, NotificationCategory category) =>
        categories.Single(state => state.Category == category).Enabled;
}
