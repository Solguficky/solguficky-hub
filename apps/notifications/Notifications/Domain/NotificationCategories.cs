using Notifications.V1;

namespace Notifications.Domain;

/// <summary>
/// Что продукт знает о категории: как она называется в схеме, включена ли по
/// умолчанию и можно ли переопределить её у конкретной сходки.
/// </summary>
/// <param name="Storage">
/// Ключ в таблице настроек. Отдельный от номера proto-enum намеренно: номер
/// уехал бы в базу значением провода, а ограничение схемы перестало бы
/// читаться без второго файла.
/// </param>
/// <param name="Audience">
/// Роли, которым категория видна. <c>null</c> — видна всем. Категория с
/// аудиторией не попадает в снимок настроек человека без этих ролей, и
/// поставить её он не может: она заведена для тех, кому положен её повод.
/// </param>
public sealed record CategoryDefinition(
    string Storage,
    bool DefaultEnabled,
    bool MeetupScoped,
    IReadOnlyList<string>? Audience = null);

/// <summary>
/// Словарь категорий уведомлений с умолчаниями из таблицы продукта
/// (<c>docs/product/overview.md</c>).
/// </summary>
/// <remarks>
/// Словарь живёт в коде, а не строками в схеме: значения по умолчанию
/// принадлежат продукту, а не данным человека. Из этого следует, как читается
/// пустота — отсутствие строки в таблице означает не «не задано», а значение
/// отсюда, поэтому новый человек получает умолчания без единой команды и без
/// засева шести строк при регистрации.
/// </remarks>
public static class NotificationCategories
{
    /// <summary>
    /// Роли администратора продукта. Только <c>admin</c>: <c>maintainer</c> —
    /// техническая роль, ортогональная продуктовым (docs/product/overview.md).
    /// Тот же круг принимает право на объявление сообществу.
    /// </summary>
    public static readonly IReadOnlyList<string> Administrators = ["admin"];

    // Порядок объявления — порядок словаря в контракте, и он же порядок
    // категорий в глобальном снимке: снимок тотален по словарю, поэтому
    // стабильный порядок дешевле сортировки на каждом чтении.
    private static readonly (NotificationCategory Category, CategoryDefinition Definition)[] Ordered =
    [
        // Подписаться на ещё не созданную сходку нельзя, поэтому настройка
        // существует только глобально. Включена по умолчанию: иначе продукт не
        // решает исходную проблему — новую сходку по-прежнему легко пропустить.
        (NotificationCategory.MeetupPublished, new CategoryDefinition("meetup_published", true, false)),

        (NotificationCategory.MeetupChanged, new CategoryDefinition("meetup_changed", true, true)),
        (NotificationCategory.MeetupMaterial, new CategoryDefinition("meetup_material", true, true)),

        // Единственная категория, выключенная по умолчанию.
        (NotificationCategory.MeetupReminder, new CategoryDefinition("meetup_reminder", false, true)),

        (NotificationCategory.OrganizerMessage, new CategoryDefinition("organizer_message", true, true)),

        // Объявление сообществу не привязано ни к какой сходке, поэтому
        // переопределять его негде. Неотключаемых категорий в продукте нет:
        // эта выключается глобально, как любая другая.
        (NotificationCategory.CommunityAnnouncement, new CategoryDefinition("community_announcement", true, false)),

        // Новая заявка на доступ. Видна только администратору: повод положен
        // ему одному, а остальным переключатель обещал бы то, чего не бывает.
        // Включена по умолчанию, иначе очередь копится незамеченной
        // (ADR-062).
        (NotificationCategory.AccessRequest, new CategoryDefinition("access_request", true, false, Administrators)),
    ];

    private static readonly IReadOnlyDictionary<NotificationCategory, CategoryDefinition> ByCategory =
        Ordered.ToDictionary(entry => entry.Category, entry => entry.Definition);

    private static readonly IReadOnlyDictionary<string, NotificationCategory> ByStorage =
        Ordered.ToDictionary(entry => entry.Definition.Storage, entry => entry.Category);

    /// <summary>Весь словарь в порядке контракта.</summary>
    public static IReadOnlyList<NotificationCategory> All { get; } =
        Ordered.Select(entry => entry.Category).ToArray();

    /// <summary>Категории, которые может нести сходка, в том же порядке.</summary>
    public static IReadOnlyList<NotificationCategory> MeetupScoped { get; } =
        Ordered.Where(entry => entry.Definition.MeetupScoped).Select(entry => entry.Category).ToArray();

    /// <summary>
    /// Известна ли категория. <c>UNSPECIFIED</c> и значение вне словаря
    /// неизвестны: контракт требует отвергать их, а не молча отбрасывать —
    /// категория здесь и есть цель команды.
    /// </summary>
    public static bool IsKnown(NotificationCategory category) => ByCategory.ContainsKey(category);

    /// <summary>Можно ли переопределить категорию у конкретной сходки.</summary>
    public static bool IsMeetupScoped(NotificationCategory category) => Definition(category).MeetupScoped;

    /// <summary>
    /// Видна ли категория человеку с этими активными ролями. Заблокированному
    /// передают пустой набор: блокировка отзывает роли.
    /// </summary>
    public static bool IsVisibleTo(NotificationCategory category, IReadOnlyCollection<string> roles) =>
        Definition(category).Audience is not { } audience || audience.Any(roles.Contains);

    /// <summary>Значение продукта по умолчанию.</summary>
    public static bool DefaultEnabled(NotificationCategory category) => Definition(category).DefaultEnabled;

    /// <summary>Ключ категории в таблице настроек.</summary>
    public static string Storage(NotificationCategory category) => Definition(category).Storage;

    /// <summary>
    /// Категория по ключу из схемы. Неизвестный ключ — это рассогласование
    /// словаря с данными, и оно роняет чтение, а не подставляет умолчание:
    /// ограничение схемы такую строку не пропускает, поэтому её появление
    /// означает, что кто-то обошёл и словарь, и ограничение.
    /// </summary>
    public static NotificationCategory FromStorage(string storage) =>
        ByStorage.TryGetValue(storage, out var category)
            ? category
            : throw new InvalidOperationException($"unknown notification category in storage: {storage}");

    private static CategoryDefinition Definition(NotificationCategory category) =>
        ByCategory.TryGetValue(category, out var definition)
            ? definition
            : throw new ArgumentOutOfRangeException(nameof(category), category, "category is not in the dictionary");
}
