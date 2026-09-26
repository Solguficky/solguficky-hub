using Grpc.Core;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.V1;
using Shouldly;
using Xunit;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Критерии приёмки PER-213, проверенные через настоящую границу сервиса:
/// Kestrel, h2c, маршрутизация gRPC, сериализация Protobuf и живой PostgreSQL.
/// </summary>
/// <remarks>
/// Команды идут клиентом по каналу, а не вызовом C#-метода: коды отказов
/// контракта — свойство границы, и проверять их в обход транспорта значило бы
/// проверять не то. Исключение одно и названо на месте — снятие переопределения,
/// у которого пути через контракт нет.
/// </remarks>
public class NotificationPreferencesTests
{
    [Fact]
    public async Task When_GlobalSettingChangedAfterSubscribing_Expect_ExistingSubscriptionFollowsIt()
    {
        await using var service = await PreferencesUnderTest.Start();

        var identityId = Guid.CreateVersion7();
        var meetupId = Guid.CreateVersion7();

        await service.Client.SubscribeToMeetupAsync(new SubscribeToMeetupRequest
        {
            IdentityId = identityId.ToString("D"),
            MeetupId = meetupId.ToString("D"),
        });

        // Настройка меняется после того, как подписка уже существует. Значение
        // нигде не скопировано в момент подписки, поэтому догонять нечего.
        await service.Client.SetGlobalCategoryPreferenceAsync(new SetGlobalCategoryPreferenceRequest
        {
            IdentityId = identityId.ToString("D"),
            Category = NotificationCategory.MeetupChanged,
            Enabled = false,
        });

        var snapshot = await service.Client.GetMeetupNotificationPreferencesAsync(
            new GetMeetupNotificationPreferencesRequest
            {
                IdentityId = identityId.ToString("D"),
                MeetupId = meetupId.ToString("D"),
            });

        snapshot.Subscribed.ShouldBeTrue();
        Enabled(snapshot.Categories, NotificationCategory.MeetupChanged).ShouldBeFalse();
    }

    [Fact]
    public async Task When_MeetupOverrideSet_Expect_ItWinsOverTheGlobalSetting()
    {
        await using var service = await PreferencesUnderTest.Start();

        var identityId = Guid.CreateVersion7();
        var meetupId = Guid.CreateVersion7();

        await service.Client.SetGlobalCategoryPreferenceAsync(new SetGlobalCategoryPreferenceRequest
        {
            IdentityId = identityId.ToString("D"),
            Category = NotificationCategory.MeetupMaterial,
            Enabled = false,
        });

        var snapshot = await service.Client.SetMeetupCategoryPreferenceAsync(
            new SetMeetupCategoryPreferenceRequest
            {
                IdentityId = identityId.ToString("D"),
                MeetupId = meetupId.ToString("D"),
                Category = NotificationCategory.MeetupMaterial,
                Enabled = true,
            });

        Enabled(snapshot.Categories, NotificationCategory.MeetupMaterial).ShouldBeTrue();

        // Глобальная настройка при этом не тронута: переопределение перекрывает
        // её у одной сходки, а не подменяет собой.
        var global = await service.Client.GetGlobalNotificationPreferencesAsync(
            new GetGlobalNotificationPreferencesRequest { IdentityId = identityId.ToString("D") });

        Enabled(global.Categories, NotificationCategory.MeetupMaterial).ShouldBeFalse();
    }

    [Fact]
    public async Task When_MeetupOverrideCleared_Expect_TheGlobalSettingAppliesAgain()
    {
        await using var service = await PreferencesUnderTest.Start();

        var identityId = Guid.CreateVersion7();
        var meetupId = Guid.CreateVersion7();

        await service.Client.SetGlobalCategoryPreferenceAsync(new SetGlobalCategoryPreferenceRequest
        {
            IdentityId = identityId.ToString("D"),
            Category = NotificationCategory.MeetupMaterial,
            Enabled = false,
        });

        await service.Client.SetMeetupCategoryPreferenceAsync(new SetMeetupCategoryPreferenceRequest
        {
            IdentityId = identityId.ToString("D"),
            MeetupId = meetupId.ToString("D"),
            Category = NotificationCategory.MeetupMaterial,
            Enabled = true,
        });

        // Единственная операция набора, которая идёт мимо контракта, и это не
        // недосмотр: PER-38 отказал в операции снятия сознательно, а наследование
        // через отсутствие строки — свойство модели, которое надо уметь проверить.
        // Продуктового пути сюда сегодня нет, и утверждение ниже не доказывает,
        // что он есть.
        var snapshot = await service.Operations.ClearMeetupCategoryOverride(
            identityId,
            meetupId,
            NotificationCategory.MeetupMaterial,
            TestContext.Current.CancellationToken);

        snapshot.Categories
            .Single(state => state.Category == NotificationCategory.MeetupMaterial)
            .Enabled
            .ShouldBeFalse();
    }

    [Fact]
    public async Task When_GlobalOnlyCategoryOverriddenAtMeetup_Expect_InvalidArgument()
    {
        await using var service = await PreferencesUnderTest.Start();

        var request = new SetMeetupCategoryPreferenceRequest
        {
            IdentityId = Guid.CreateVersion7().ToString("D"),
            MeetupId = Guid.CreateVersion7().ToString("D"),
            Category = NotificationCategory.MeetupPublished,
            Enabled = false,
        };

        var code = await Code(() => service.Client.SetMeetupCategoryPreferenceAsync(request).ResponseAsync);

        code.ShouldBe(StatusCode.InvalidArgument);
    }

    [Fact]
    public async Task When_PersonTouchedNothing_Expect_ProductDefaultsInTheGlobalSnapshot()
    {
        await using var service = await PreferencesUnderTest.Start();

        // Ни одной строки в базе у этого человека нет, и отдельной команды
        // создания не существует: умолчания принадлежат продукту, а не данным.
        var snapshot = await service.Client.GetGlobalNotificationPreferencesAsync(
            new GetGlobalNotificationPreferencesRequest
            {
                IdentityId = Guid.CreateVersion7().ToString("D"),
            });

        snapshot.Categories.Count.ShouldBe(6);
        Enabled(snapshot.Categories, NotificationCategory.MeetupPublished).ShouldBeTrue();
        Enabled(snapshot.Categories, NotificationCategory.MeetupChanged).ShouldBeTrue();
        Enabled(snapshot.Categories, NotificationCategory.MeetupMaterial).ShouldBeTrue();
        Enabled(snapshot.Categories, NotificationCategory.OrganizerMessage).ShouldBeTrue();
        Enabled(snapshot.Categories, NotificationCategory.CommunityAnnouncement).ShouldBeTrue();

        // Напоминание — единственная выключенная по умолчанию категория.
        Enabled(snapshot.Categories, NotificationCategory.MeetupReminder).ShouldBeFalse();
    }

    [Fact]
    public async Task When_EveryCategoryIsSetGlobally_Expect_TheSchemaAcceptsEveryKey()
    {
        await using var service = await PreferencesUnderTest.Start();

        var identityId = Guid.CreateVersion7().ToString("D");

        // Словарь категорий живёт в коде, а ограничение схемы перечисляет те же
        // шесть ключей литералами. Связывает их только этот тест: он прогоняет
        // через базу каждый ключ, который умеет выдать словарь. Переименуй
        // ключ в одном месте и не переименуй в другом — падает здесь, а не у
        // человека, который первым тронет редкую категорию.
        foreach (var category in Enum.GetValues<NotificationCategory>()
                     .Where(category => category != NotificationCategory.Unspecified))
        {
            var snapshot = await service.Client.SetGlobalCategoryPreferenceAsync(
                new SetGlobalCategoryPreferenceRequest
                {
                    IdentityId = identityId,
                    Category = category,
                    Enabled = false,
                });

            Enabled(snapshot.Categories, category).ShouldBeFalse();
        }
    }

    [Fact]
    public async Task When_MeetupSnapshotRequested_Expect_OnlyCategoriesAMeetupCanHold()
    {
        await using var service = await PreferencesUnderTest.Start();

        var snapshot = await service.Client.GetMeetupNotificationPreferencesAsync(
            new GetMeetupNotificationPreferencesRequest
            {
                IdentityId = Guid.CreateVersion7().ToString("D"),
                MeetupId = Guid.CreateVersion7().ToString("D"),
            });

        snapshot.Subscribed.ShouldBeFalse();
        snapshot.Categories.Select(preference => preference.Category).ShouldBe(
            [
                NotificationCategory.MeetupChanged,
                NotificationCategory.MeetupMaterial,
                NotificationCategory.MeetupReminder,
                NotificationCategory.OrganizerMessage,
            ],
            ignoreOrder: true);
    }

    [Fact]
    public async Task When_UnsubscribedAndSubscribedAgain_Expect_CategorySettingsSurvive()
    {
        await using var service = await PreferencesUnderTest.Start();

        var identityId = Guid.CreateVersion7();
        var meetupId = Guid.CreateVersion7();

        await service.Client.SubscribeToMeetupAsync(new SubscribeToMeetupRequest
        {
            IdentityId = identityId.ToString("D"),
            MeetupId = meetupId.ToString("D"),
        });

        await service.Client.SetMeetupCategoryPreferenceAsync(new SetMeetupCategoryPreferenceRequest
        {
            IdentityId = identityId.ToString("D"),
            MeetupId = meetupId.ToString("D"),
            Category = NotificationCategory.MeetupReminder,
            Enabled = true,
        });

        var afterUnsubscribe = await service.Client.UnsubscribeFromMeetupAsync(
            new UnsubscribeFromMeetupRequest
            {
                IdentityId = identityId.ToString("D"),
                MeetupId = meetupId.ToString("D"),
            });

        // Отписка не трогает настройки: подписка и категории — две независимые
        // плоскости, и человек, вернувшийся к сходке, получает прежний выбор.
        afterUnsubscribe.Subscribed.ShouldBeFalse();
        Enabled(afterUnsubscribe.Categories, NotificationCategory.MeetupReminder).ShouldBeTrue();

        var afterResubscribe = await service.Client.SubscribeToMeetupAsync(new SubscribeToMeetupRequest
        {
            IdentityId = identityId.ToString("D"),
            MeetupId = meetupId.ToString("D"),
        });

        afterResubscribe.Subscribed.ShouldBeTrue();
        Enabled(afterResubscribe.Categories, NotificationCategory.MeetupReminder).ShouldBeTrue();
    }

    [Fact]
    public async Task When_SameCommandRepeated_Expect_TheSameState()
    {
        await using var service = await PreferencesUnderTest.Start();

        var request = new SubscribeToMeetupRequest
        {
            IdentityId = Guid.CreateVersion7().ToString("D"),
            MeetupId = Guid.CreateVersion7().ToString("D"),
        };

        var first = await service.Client.SubscribeToMeetupAsync(request);
        var second = await service.Client.SubscribeToMeetupAsync(request);

        first.Subscribed.ShouldBeTrue();
        second.Subscribed.ShouldBeTrue();

        var unsubscribe = new UnsubscribeFromMeetupRequest
        {
            IdentityId = request.IdentityId,
            MeetupId = request.MeetupId,
        };

        await service.Client.UnsubscribeFromMeetupAsync(unsubscribe);
        var repeated = await service.Client.UnsubscribeFromMeetupAsync(unsubscribe);

        repeated.Subscribed.ShouldBeFalse();
    }

    [Fact]
    public async Task When_IdentityIdIsNotCanonical_Expect_InvalidArgument()
    {
        await using var service = await PreferencesUnderTest.Start();

        var code = await Code(() => service.Client.GetGlobalNotificationPreferencesAsync(
            new GetGlobalNotificationPreferencesRequest { IdentityId = "not-a-uuid" }).ResponseAsync);

        code.ShouldBe(StatusCode.InvalidArgument);
    }

    private static bool Enabled(IEnumerable<CategoryPreference> categories, NotificationCategory category) =>
        categories.Single(preference => preference.Category == category).Enabled;

    /// <summary>
    /// Код объявленного отказа. Неожиданное исключение наружу не глотается:
    /// тест, поймавший всё подряд, зеленел бы и на сломанной границе.
    /// </summary>
    private static async Task<StatusCode> Code(Func<Task> call)
    {
        try
        {
            await call();
        }
        catch (RpcException declined)
        {
            return declined.StatusCode;
        }

        throw new InvalidOperationException("call was expected to be declined");
    }
}
