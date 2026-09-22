using Grpc.Core;
using Notifications.Domain;
using Notifications.Preferences;
using Notifications.V1;

namespace Notifications.Transport;

/// <summary>
/// gRPC-граница подписок и настроек категорий.
/// </summary>
/// <remarks>
/// Команда предъявляет внутренний идентификатор человека, и больше ничего:
/// сообщения с ролями в контракте нет намеренно, потому что Notifications
/// решения о доступе по ролям не принимает — свои подписки и настройки человек
/// меняет себе. Из какого интерфейса пришла команда, сервис не знает.
/// </remarks>
public sealed class NotificationsGrpcService(PreferenceOperations operations)
    : NotificationsService.NotificationsServiceBase
{
    public override async Task<MeetupNotificationPreferences> SubscribeToMeetup(
        SubscribeToMeetupRequest request,
        ServerCallContext context)
    {
        var identityId = RequestValidation.IdentityId(request.IdentityId);
        var meetupId = RequestValidation.MeetupId(request.MeetupId);

        // Подписка на сходку, которой сервис ещё не знает, отказом не является:
        // ссылочной целостности между базами нет, и висящая подписка —
        // ожидаемое состояние, которое разрешается событием (PER-215).
        var preferences = await operations.SubscribeToMeetup(identityId, meetupId, context.CancellationToken);

        return Map(preferences);
    }

    public override async Task<MeetupNotificationPreferences> UnsubscribeFromMeetup(
        UnsubscribeFromMeetupRequest request,
        ServerCallContext context)
    {
        var identityId = RequestValidation.IdentityId(request.IdentityId);
        var meetupId = RequestValidation.MeetupId(request.MeetupId);

        var preferences = await operations.UnsubscribeFromMeetup(identityId, meetupId, context.CancellationToken);

        return Map(preferences);
    }

    public override async Task<GlobalNotificationPreferences> SetGlobalCategoryPreference(
        SetGlobalCategoryPreferenceRequest request,
        ServerCallContext context)
    {
        var identityId = RequestValidation.IdentityId(request.IdentityId);
        var category = RequestValidation.Category(request.Category);

        // enabled не проверяется на присутствие: presence у поля нет, и false —
        // тотальное значение «выключено», а не пропущенное поле.
        var preferences = await operations.SetGlobalCategory(
            identityId,
            category,
            request.Enabled,
            context.CancellationToken);

        return Map(preferences);
    }

    public override async Task<MeetupNotificationPreferences> SetMeetupCategoryPreference(
        SetMeetupCategoryPreferenceRequest request,
        ServerCallContext context)
    {
        var identityId = RequestValidation.IdentityId(request.IdentityId);
        var meetupId = RequestValidation.MeetupId(request.MeetupId);
        var category = RequestValidation.MeetupScopedCategory(request.Category);

        // Запись всегда создаёт переопределение: третьего положения «как везде»
        // на проводе нет, и снятие переопределения этой командой невыразимо.
        var preferences = await operations.SetMeetupCategory(
            identityId,
            meetupId,
            category,
            request.Enabled,
            context.CancellationToken);

        return Map(preferences);
    }

    public override async Task<GlobalNotificationPreferences> GetGlobalNotificationPreferences(
        GetGlobalNotificationPreferencesRequest request,
        ServerCallContext context)
    {
        var identityId = RequestValidation.IdentityId(request.IdentityId);

        var preferences = await operations.ReadGlobal(identityId, context.CancellationToken);

        return Map(preferences);
    }

    public override async Task<MeetupNotificationPreferences> GetMeetupNotificationPreferences(
        GetMeetupNotificationPreferencesRequest request,
        ServerCallContext context)
    {
        var identityId = RequestValidation.IdentityId(request.IdentityId);
        var meetupId = RequestValidation.MeetupId(request.MeetupId);

        var preferences = await operations.ReadMeetup(identityId, meetupId, context.CancellationToken);

        return Map(preferences);
    }

    /// <summary>
    /// Ручная рассылка подписчикам сходки. В этом срезе не реализована.
    /// </summary>
    /// <remarks>
    /// Отказ, а не заглушка-«принято»: рассылка необратима, а поле <c>id</c>
    /// запроса — одновременно идентификатор и ключ идемпотентности. Приняв
    /// команду, которую никто не исполнит, сервис зафиксировал бы ключ и на
    /// настоящем повторе ответил бы <c>created = false</c>, то есть соврал бы,
    /// что сообщение уже ушло. Право действовать от имени сходки проверяется
    /// синхронным вызовом Meetups, которого здесь ещё нет.
    /// </remarks>
    public override Task<BroadcastAccepted> BroadcastToMeetupSubscribers(
        BroadcastToMeetupSubscribersRequest request,
        ServerCallContext context) =>
        throw NotInThisSlice();

    /// <inheritdoc cref="BroadcastToMeetupSubscribers" />
    public override Task<BroadcastAccepted> BroadcastToCommunity(
        BroadcastToCommunityRequest request,
        ServerCallContext context) =>
        throw NotInThisSlice();

    private static RpcException NotInThisSlice() =>
        new(new Status(
            StatusCode.Unimplemented,
            "manual broadcasts are not implemented yet: they belong to the outreach block"));

    private static GlobalNotificationPreferences Map(GlobalPreferences preferences) =>
        new()
        {
            IdentityId = preferences.IdentityId.ToString("D"),
            Categories = { preferences.Categories.Select(Map) },
        };

    private static MeetupNotificationPreferences Map(MeetupPreferences preferences) =>
        new()
        {
            IdentityId = preferences.IdentityId.ToString("D"),
            MeetupId = preferences.MeetupId.ToString("D"),
            Subscribed = preferences.Subscribed,
            Categories = { preferences.Categories.Select(Map) },
        };

    private static CategoryPreference Map(CategoryState state) =>
        new() { Category = state.Category, Enabled = state.Enabled };
}
