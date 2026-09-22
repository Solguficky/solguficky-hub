using Notifications.Domain;
using Notifications.Infrastructure;
using Notifications.V1;
using Npgsql;

namespace Notifications.Preferences;

/// <summary>
/// Операции подписок и настроек категорий: хранилища плюс вывод действующего
/// значения. Транспорт сюда не заходит — класс ничего не знает ни про gRPC, ни
/// про то, из какого интерфейса пришла команда.
/// </summary>
/// <remarks>
/// Каждая операция идёт одной транзакцией, включая снимок, который она
/// возвращает: ответ обязан описывать состояние после этой команды, а не
/// состояние, доставшееся от чужого коммита между записью и чтением.
///
/// Слой существует ещё и ради одной проверяемой вещи: снятие переопределения
/// вызывается отсюда, а не через gRPC, и тест умеет его выполнить. Контракт
/// PER-38 такой операции не содержит сознательно.
/// </remarks>
public sealed class PreferenceOperations(
    NpgsqlDataSource source,
    SubscriptionStore subscriptions,
    PreferenceStore preferences)
{
    /// <summary>Подписывает человека на сходку и отдаёт снимок у этой сходки.</summary>
    public Task<MeetupPreferences> SubscribeToMeetup(
        Guid identityId,
        Guid meetupId,
        CancellationToken cancellationToken) =>
        InMeetupScope(
            identityId,
            meetupId,
            (work, token) => subscriptions.Subscribe(work, identityId, meetupId, token),
            cancellationToken);

    /// <summary>
    /// Снимает подписку и отдаёт снимок. Настройки категорий при этом не
    /// трогаются: человек, вернувшийся к сходке, получает прежние значения.
    /// </summary>
    public Task<MeetupPreferences> UnsubscribeFromMeetup(
        Guid identityId,
        Guid meetupId,
        CancellationToken cancellationToken) =>
        InMeetupScope(
            identityId,
            meetupId,
            (work, token) => subscriptions.Unsubscribe(work, identityId, meetupId, token),
            cancellationToken);

    /// <summary>
    /// Ставит глобальное значение категории. Значение не копируется ни в одну
    /// подписку, поэтому действует и на уже существующие, и на будущие сходки.
    /// </summary>
    public async Task<GlobalPreferences> SetGlobalCategory(
        Guid identityId,
        NotificationCategory category,
        bool enabled,
        CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);

        await preferences.SetGlobal(work, identityId, category, enabled, cancellationToken);
        var snapshot = await GlobalSnapshot(work, identityId, cancellationToken);

        await work.Commit(cancellationToken);

        return snapshot;
    }

    /// <summary>Ставит переопределение категории у конкретной сходки.</summary>
    public Task<MeetupPreferences> SetMeetupCategory(
        Guid identityId,
        Guid meetupId,
        NotificationCategory category,
        bool enabled,
        CancellationToken cancellationToken) =>
        InMeetupScope(
            identityId,
            meetupId,
            (work, token) => preferences.SetMeetupOverride(work, identityId, meetupId, category, enabled, token),
            cancellationToken);

    /// <summary>
    /// Снимает переопределение: категория снова следует за глобальной настройкой.
    /// </summary>
    /// <remarks>
    /// Наружу не выставлено. Макет P-07 знает у тумблера два положения, а не
    /// три, и контракт отражает именно его; операция живёт здесь, потому что
    /// наследование через отсутствие строки — свойство модели, и его надо уметь
    /// проверить. Когда продукт захочет состояние «как везде» отдельно от
    /// «включено», RPC добавляется аддитивно поверх этого метода.
    /// </remarks>
    public Task<MeetupPreferences> ClearMeetupCategoryOverride(
        Guid identityId,
        Guid meetupId,
        NotificationCategory category,
        CancellationToken cancellationToken) =>
        InMeetupScope(
            identityId,
            meetupId,
            (work, token) => preferences.ClearMeetupOverride(work, identityId, meetupId, category, token),
            cancellationToken);

    /// <summary>Глобальный снимок, тотальный по словарю категорий.</summary>
    public async Task<GlobalPreferences> ReadGlobal(Guid identityId, CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);

        var snapshot = await GlobalSnapshot(work, identityId, cancellationToken);

        await work.Commit(cancellationToken);

        return snapshot;
    }

    /// <summary>Снимок у сходки: подписка и действующие значения её категорий.</summary>
    public Task<MeetupPreferences> ReadMeetup(
        Guid identityId,
        Guid meetupId,
        CancellationToken cancellationToken) =>
        InMeetupScope(identityId, meetupId, static (_, _) => Task.CompletedTask, cancellationToken);

    /// <summary>
    /// Общая форма всех операций у сходки: команда и снимок после неё одной
    /// транзакцией. Чистое чтение передаёт пустую команду.
    /// </summary>
    private async Task<MeetupPreferences> InMeetupScope(
        Guid identityId,
        Guid meetupId,
        Func<UnitOfWork, CancellationToken, Task> command,
        CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);

        await command(work, cancellationToken);

        // Два запроса, а не три: обе области настроек читаются одним. Подписка
        // остаётся отдельным запросом, потому что лежит в своей таблице.
        var subscribed = await subscriptions.IsSubscribed(work, identityId, meetupId, cancellationToken);
        var rows = await preferences.ReadForMeetup(work, identityId, meetupId, cancellationToken);

        await work.Commit(cancellationToken);

        return EffectivePreference.Meetup(identityId, meetupId, subscribed, rows.Global, rows.Overrides);
    }

    private async Task<GlobalPreferences> GlobalSnapshot(
        UnitOfWork work,
        Guid identityId,
        CancellationToken cancellationToken)
    {
        var global = await preferences.ReadGlobal(work, identityId, cancellationToken);

        return EffectivePreference.Global(identityId, global);
    }
}
