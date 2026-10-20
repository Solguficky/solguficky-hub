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
/// Права, с любым из которых категория видна. <c>null</c> — видна всем.
/// Категория с аудиторией не попадает в снимок настроек человека без этих прав,
/// и поставить её он не может: она заведена для тех, кому положен её повод.
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
    /// Право модерации очереди: управление составом решает очередь сообщества,
    /// допуск к торгам — очередь аукциона (ADR-064, пункт 12; RFC-016). Своя
    /// категория у каждой очереди, и видит она только своего держателя:
    /// выключение одной не гасит заявки другой (PER-635, ADR-062).
    /// </summary>
    public const string CommunityQueueModerator = "manage_members";

    /// <inheritdoc cref="CommunityQueueModerator"/>
    public const string AuctionQueueModerator = "admit_bidders";

    /// <summary>Аудитория категории: одна очередь — одно право.</summary>
    public static readonly IReadOnlyList<string> CommunityQueueModerators = [CommunityQueueModerator];

    /// <inheritdoc cref="CommunityQueueModerators"/>
    public static readonly IReadOnlyList<string> AuctionQueueModerators = [AuctionQueueModerator];

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

        // Единственная категория с постоянным умолчанием, выключенная по
        // умолчанию; у «Нового в боте» умолчание задаёт среда (ADR-069, п. 5).
        (NotificationCategory.MeetupReminder, new CategoryDefinition("meetup_reminder", false, true)),

        (NotificationCategory.OrganizerMessage, new CategoryDefinition("organizer_message", true, true)),

        // Объявление сообществу не привязано ни к какой сходке, поэтому
        // переопределять его негде. Неотключаемых категорий в продукте нет:
        // эта выключается глобально, как любая другая.
        (NotificationCategory.CommunityAnnouncement, new CategoryDefinition("community_announcement", true, false)),

        // Сводка выпуска: «Новое в боте». Только глобальная — сводка
        // принадлежит поверхности бота, а не сходке, и переопределять её у
        // сходки негде. Умолчание этого словаря — прод: для сообщества
        // категория выключена, пока человек не включит её сам, а stage
        // включает её параметром среды (ADR-069, п. 5; таблица продукта —
        // docs/product/overview.md). Параметр читает CategoryDefaults, а
        // здесь остаётся значение, которое действует без него.
        //
        // Аудитории нет намеренно: в хабе весь бот доступен только держателю
        // `access_hub`, а в боте аукциона — держателю его права, поэтому
        // переключатель видит лишь тот, кому сводка и положена. Одна строка
        // на две поверхности не выразила бы оба права, а сузила бы одно.
        (NotificationCategory.ReleaseNotes, new CategoryDefinition("release_notes", false, false)),

        // Новая заявка в очередь сообщества. Видна держателю права управления
        // составом: кто получает факт, тот видит переключатель, а остальным он
        // обещал бы то, чего не бывает (ADR-064). Включена по умолчанию, иначе
        // очередь копится незамеченной (ADR-062).
        (NotificationCategory.AccessRequestCommunity,
            new CategoryDefinition("access_request_community", true, false, CommunityQueueModerators)),

        // Новая заявка в очередь аукциона — своя категория с тех пор, как
        // выключение общей подписи не называло, какую очередь оно гасит
        // (PER-635): держатель права модерировать аукцион видит только эту.
        (NotificationCategory.AccessRequestAuction,
            new CategoryDefinition("access_request_auction", true, false, AuctionQueueModerators)),
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
    /// Видна ли категория человеку с этими правами. Заблокированному передают
    /// пустой набор: блокировка отзывает права.
    /// </summary>
    public static bool IsVisibleTo(NotificationCategory category, IReadOnlyCollection<string> rights) =>
        Definition(category).Audience is not { } audience || audience.Any(rights.Contains);

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
