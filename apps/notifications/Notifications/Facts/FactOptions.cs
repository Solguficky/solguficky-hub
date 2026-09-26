namespace Notifications.Facts;

/// <summary>Настройки порождения адресных фактов.</summary>
public sealed class FactOptions
{
    public const string SectionName = "Notifications:Facts";

    /// <summary>
    /// Срок годности факта от его порождения: <c>not_after = created_at +
    /// StaleAfter</c>. Срок описывает свежесть вести, а не сходку: материал и
    /// «состоялась» приходят после дня сходки, и срок по её дате родил бы их
    /// уже истёкшими. Начало сходки к тому же — местное время без зоны.
    /// </summary>
    /// <remarks>
    /// Истёкший факт релей в шину не выносит, а канал по тому же полю
    /// отбрасывает то, что застряло уже у него.
    /// </remarks>
    public TimeSpan StaleAfter { get; set; } = TimeSpan.FromHours(24);

    /// <summary>Верхняя граница срока: дольше года весть не лежит нигде.</summary>
    public static readonly TimeSpan MaxStaleAfter = TimeSpan.FromDays(365);

    public const string ValidationMessage = "Notifications:Facts:StaleAfter must be between 00:00:00 and 365 days";

    /// <summary>
    /// Нулевой срок допустим — факт истекает при рождении, так его и
    /// проверяют тесты; отрицательный и больше года — нет.
    /// </summary>
    public static bool IsValid(FactOptions options) =>
        options.StaleAfter >= TimeSpan.Zero && options.StaleAfter <= MaxStaleAfter;
}
