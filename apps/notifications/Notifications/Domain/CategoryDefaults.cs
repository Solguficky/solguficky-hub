using Notifications.V1;

namespace Notifications.Domain;

/// <summary>
/// Умолчания категорий в этой среде: значение словаря, кроме «Нового в боте»,
/// чьё умолчание задаёт среда (ADR-069, п. 5).
/// </summary>
/// <remarks>
/// Отдельный тип, а не поле словаря: словарь — продукт и одинаков везде, а
/// умолчание сводки — свойство развёртывания. Формула
/// <c>override ?? global ?? default</c> не меняется, меняется только последнее
/// слагаемое, поэтому смена значения действует сразу на всех, кто переключатель
/// не трогал.
/// </remarks>
public sealed record CategoryDefaults(bool ReleaseNotes)
{
    /// <summary>
    /// Переменная среды: <c>true</c> включает категорию тем, кто её не трогал.
    /// Своё имя с префиксом сервиса, как у пояса сообщества: значение кладут
    /// values среды, и в чарте оно читается без знания разметки секций .NET.
    /// </summary>
    public const string ReleaseNotesVariable = "NOTIFICATIONS_RELEASE_NOTES_ENABLED_BY_DEFAULT";

    /// <summary>Умолчания словаря — значение прода.</summary>
    public static CategoryDefaults Product { get; } =
        new(NotificationCategories.DefaultEnabled(NotificationCategory.ReleaseNotes));

    /// <summary>Действующее умолчание категории.</summary>
    public bool Of(NotificationCategory category) =>
        category == NotificationCategory.ReleaseNotes ? ReleaseNotes : NotificationCategories.DefaultEnabled(category);

    /// <summary>
    /// Разбирает значение переменной. Отсутствие и пустая строка — умолчание
    /// словаря, то есть прод. Иное значение, кроме <c>true</c> и <c>false</c>,
    /// роняет старт, а не читается как «выключено» молча: опечатка в values
    /// stage иначе выключила бы сводки тестировщикам без единой строки в логе.
    /// </summary>
    /// <exception cref="InvalidOperationException">Значение не <c>true</c> и не <c>false</c>.</exception>
    public static CategoryDefaults Parse(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return Product;
        }

        return bool.TryParse(value.Trim(), out var enabled)
            ? new CategoryDefaults(enabled)
            : throw new InvalidOperationException($"{ReleaseNotesVariable} must be true or false: {value}");
    }
}
