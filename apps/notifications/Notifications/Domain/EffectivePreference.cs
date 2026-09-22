using Notifications.V1;

namespace Notifications.Domain;

/// <summary>Категория и её действующее значение.</summary>
public sealed record CategoryState(NotificationCategory Category, bool Enabled);

/// <summary>
/// Глобальный снимок. Тотален по словарю: категория, которой человек не
/// касался, приезжает со значением продукта, а не отсутствующей записью.
/// </summary>
public sealed record GlobalPreferences(Guid IdentityId, IReadOnlyList<CategoryState> Categories);

/// <summary>
/// Снимок у сходки. Несёт только те категории, которые сходка может нести, и
/// признак подписки рядом со списком, а не вместо него: подписка, у которой
/// выключены все категории, — законное состояние, а не отписка.
/// </summary>
public sealed record MeetupPreferences(
    Guid IdentityId,
    Guid MeetupId,
    bool Subscribed,
    IReadOnlyList<CategoryState> Categories);

/// <summary>
/// Вывод действующего значения категории. Чистые функции без доступа к базе:
/// правило продукта проверяется юнит-тестом, а не прогоном на живом PostgreSQL.
/// </summary>
public static class EffectivePreference
{
    /// <summary>
    /// Переопределение сильнее глобальной настройки, глобальная сильнее
    /// умолчания продукта.
    /// </summary>
    /// <remarks>
    /// Значение выводится здесь, при чтении, и нигде не материализуется в
    /// момент подписки. Из-за этого правка глобальной настройки действует на
    /// все сходки, включая будущие: копия, которую пришлось бы догонять, не
    /// создаётся вовсе. Отсутствие переопределения — наследование, поэтому
    /// удаление строки переопределения возвращает глобальное значение.
    /// </remarks>
    public static bool Resolve(NotificationCategory category, bool? global, bool? @override) =>
        @override ?? global ?? NotificationCategories.DefaultEnabled(category);

    /// <summary>Глобальный снимок по всем категориям словаря.</summary>
    public static GlobalPreferences Global(
        Guid identityId,
        IReadOnlyDictionary<NotificationCategory, bool> global) =>
        new(
            identityId,
            NotificationCategories.All
                .Select(category => new CategoryState(category, Resolve(category, Lookup(global, category), null)))
                .ToArray());

    /// <summary>Снимок у сходки по категориям, которые сходка может нести.</summary>
    public static MeetupPreferences Meetup(
        Guid identityId,
        Guid meetupId,
        bool subscribed,
        IReadOnlyDictionary<NotificationCategory, bool> global,
        IReadOnlyDictionary<NotificationCategory, bool> overrides) =>
        new(
            identityId,
            meetupId,
            subscribed,
            NotificationCategories.MeetupScoped
                .Select(category => new CategoryState(
                    category,
                    Resolve(category, Lookup(global, category), Lookup(overrides, category))))
                .ToArray());

    private static bool? Lookup(
        IReadOnlyDictionary<NotificationCategory, bool> values,
        NotificationCategory category) =>
        values.TryGetValue(category, out var value) ? value : null;
}
