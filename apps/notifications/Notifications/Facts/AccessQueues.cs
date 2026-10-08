using Notifications.Replica;

namespace Notifications.Facts;

/// <summary>
/// Что очередь заявки значит для адресных фактов: кто её модерирует, какое
/// право закрывает заявку в неё и каким кругом её называет факт.
/// </summary>
/// <remarks>
/// Соответствие задают ADR-064 (пункты 8, 12 и 14) и контракт <c>identity.v1</c>,
/// а не вывод прав из роли: право человека Notifications по-прежнему берёт из
/// реплики как есть, здесь только имя права, которое ищется в ней.
/// </remarks>
public static class AccessQueues
{
    /// <summary>
    /// Право, держателям которого уходит оповещение о заявке: очередь
    /// сообщества решает управление составом, очередь аукциона — модерация
    /// аукциона.
    /// </summary>
    public static string ModeratorRight(AccessQueue queue) => queue switch
    {
        AccessQueue.Community => "manage_membership",
        AccessQueue.Auction => "moderate_auction",
        _ => throw new ArgumentOutOfRangeException(nameof(queue), queue, "queue is not known"),
    };

    /// <summary>
    /// Право, которое выдаёт допуск в очередь. Кто его держит, тот уже не ждёт:
    /// заявку в сообщество закрывает право хаба, заявку в аукцион — право
    /// аукциона.
    /// </summary>
    public static string AdmissionRight(AccessQueue queue) => queue switch
    {
        AccessQueue.Community => "hub",
        AccessQueue.Auction => "auction",
        _ => throw new ArgumentOutOfRangeException(nameof(queue), queue, "queue is not known"),
    };

    /// <summary>
    /// Круг заявки в колонке <c>notification.access_circle</c> — прежнее имя,
    /// под которым схема помнит факт о заявке. Очередь сообщества — круг
    /// <c>member</c>, очередь аукциона — <c>public</c>.
    /// </summary>
    public static string Circle(AccessQueue queue) => queue switch
    {
        AccessQueue.Community => "member",
        AccessQueue.Auction => "public",
        _ => throw new ArgumentOutOfRangeException(nameof(queue), queue, "queue is not known"),
    };

    /// <summary>
    /// Круг заявки в адресном факте: контракт <c>notifications.v1</c> несёт
    /// только запрошенный круг (ADR-062, пункт 6).
    /// </summary>
    public static Identity.V1.GlobalRole ContractCircle(AccessQueue queue) => queue switch
    {
        AccessQueue.Community => Identity.V1.GlobalRole.Member,
        AccessQueue.Auction => Identity.V1.GlobalRole.Guest,
        _ => throw new ArgumentOutOfRangeException(nameof(queue), queue, "queue is not known"),
    };
}
