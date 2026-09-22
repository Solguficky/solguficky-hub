using Notifications.Domain;
using Notifications.V1;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.DomainTests;

/// <summary>
/// Словарь категорий против таблицы продукта и против контракта.
/// </summary>
/// <remarks>
/// Словарь живёт в коде, поэтому единственное, что удерживает его от расхождения
/// с <c>contracts/proto/notifications/v1</c>, — первый тест этого файла. Новая
/// категория в контракте роняет его, а не проходит незамеченной до рантайма.
/// </remarks>
public class NotificationCategoriesTests
{
    [Fact]
    public void All_Dictionary_CoversEveryContractCategoryExceptUnspecified()
    {
        var fromContract = Enum.GetValues<NotificationCategory>()
            .Where(category => category != NotificationCategory.Unspecified)
            .ToArray();

        NotificationCategories.All.ShouldBe(fromContract, ignoreOrder: true);
    }

    [Fact]
    public void All_Dictionary_FollowsContractOrder()
    {
        // Порядок словаря — порядок глобального снимка. Он не косметика: снимок
        // тотален по словарю, и стабильный порядок избавляет и читателя, и тест
        // от сортировки на каждом чтении.
        NotificationCategories.All.ShouldBe(NotificationCategories.All.Order().ToArray());
    }

    [Fact]
    public void IsKnown_Unspecified_IsFalse()
    {
        // UNSPECIFIED приходит и от старого клиента, и от несланного поля.
        // Контракт требует отвергать его, а не толковать.
        NotificationCategories.IsKnown(NotificationCategory.Unspecified).ShouldBeFalse();
    }

    [Fact]
    public void IsKnown_ValueOutsideDictionary_IsFalse()
    {
        NotificationCategories.IsKnown((NotificationCategory)42).ShouldBeFalse();
    }

    [Fact]
    public void DefaultEnabled_Reminder_IsDisabled()
    {
        // Единственная выключенная по умолчанию категория таблицы продукта.
        NotificationCategories.DefaultEnabled(NotificationCategory.MeetupReminder).ShouldBeFalse();
    }

    [Fact]
    public void DefaultEnabled_EveryCategoryButReminder_IsEnabled()
    {
        var enabled = NotificationCategories.All
            .Where(category => category != NotificationCategory.MeetupReminder);

        enabled.ShouldAllBe(category => NotificationCategories.DefaultEnabled(category));
    }

    [Fact]
    public void MeetupScoped_PublishedAndAnnouncement_AreGlobalOnly()
    {
        // Подписаться на ещё не созданную сходку нельзя, а объявление не
        // привязано ни к одной: подписки, к которой их привязать, не существует.
        NotificationCategories.MeetupScoped.ShouldNotContain(NotificationCategory.MeetupPublished);
        NotificationCategories.MeetupScoped.ShouldNotContain(NotificationCategory.CommunityAnnouncement);
    }

    [Fact]
    public void MeetupScoped_EveryOtherCategory_CanBeOverridden()
    {
        NotificationCategories.MeetupScoped.ShouldBe(
            [
                NotificationCategory.MeetupChanged,
                NotificationCategory.MeetupMaterial,
                NotificationCategory.MeetupReminder,
                NotificationCategory.OrganizerMessage,
            ],
            ignoreOrder: true);
    }

    [Fact]
    public void Storage_EveryCategory_CarriesADistinctKey()
    {
        // Совпавший ключ склеил бы две категории в одной строке таблицы, и
        // частичный уникальный индекс молча принял бы это за повтор.
        var keys = NotificationCategories.All.Select(NotificationCategories.Storage).ToArray();

        keys.Distinct().Count().ShouldBe(keys.Length);
    }

    [Fact]
    public void FromStorage_KeyOfEveryCategory_RoundTrips()
    {
        foreach (var category in NotificationCategories.All)
        {
            NotificationCategories.FromStorage(NotificationCategories.Storage(category)).ShouldBe(category);
        }
    }

    [Fact]
    public void FromStorage_UnknownKey_Throws()
    {
        // Строку с таким ключом не пропускает ограничение схемы, поэтому её
        // появление означает, что кто-то обошёл и словарь, и ограничение.
        // Подставить умолчание здесь значило бы скрыть это.
        Should.Throw<InvalidOperationException>(() => NotificationCategories.FromStorage("meetup_cancelled"));
    }
}
