using Notifications.Facts;
using Notifications.Transport;

namespace Notifications.ReleaseNotes;

/// <summary>
/// Поверхность бота, чьи записи «Что нового» помнит сервис (ADR-069, п. 2):
/// имя в схеме, право, держателям которого уходит её сводка, и бот, который
/// её доставляет.
/// </summary>
/// <remarks>
/// Поверхность называет токен вызывающего, а не поле запроса: бот читает и
/// пишет только своё. Поверхность аукциона появится вместе с категорией в
/// «Настройках» его бота (ADR-069, п. 7) — до этого её строки здесь нет, и
/// вызов бота аукциона не доходит сюда уже в <see cref="MethodAccess" />.
/// </remarks>
public sealed record ReleaseSurface(string Name, string Right, string DeliverySurface)
{
    /// <summary>Поверхность хаба: сводку получают держатели права хаба, доставляет бот хаба.</summary>
    public static readonly ReleaseSurface Hub = new(NotificationSubjects.Hub, NotificationFacts.HubRight, NotificationSubjects.Hub);

    /// <summary>Поверхность вызывающего; <c>null</c> — у вызывающего её нет.</summary>
    public static ReleaseSurface? Of(Caller caller) => caller == Caller.HubBot ? Hub : null;

    /// <summary>Поверхность по имени из схемы.</summary>
    /// <exception cref="InvalidOperationException">Имя не названо ни одной поверхностью.</exception>
    public static ReleaseSurface FromStorage(string name) =>
        name == Hub.Name ? Hub : throw new InvalidOperationException($"unknown release surface in storage: {name}");
}
