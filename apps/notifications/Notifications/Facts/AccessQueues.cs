using Notifications.Domain;
using Notifications.Replica;
using Notifications.V1;

namespace Notifications.Facts;

/// <summary>
/// Что очередь заявки значит для адресных фактов: кто её модерирует, какое
/// право закрывает заявку в неё и под каким ключом схема помнит факт о ней.
/// </summary>
/// <remarks>
/// Соответствие задают ADR о круге без ранга и наборах (RFC-016) и контракт
/// <c>identity.v1</c>, а не вывод прав из круга или набора: право человека
/// Notifications берёт из реплики как есть, здесь только имя права, которое
/// ищется в ней.
/// </remarks>
public static class AccessQueues
{
    /// <summary>
    /// Право, держателям которого уходит оповещение о заявке: очередь
    /// сообщества решает <c>manage_members</c>, очередь аукциона —
    /// <c>admit_bidders</c>.
    /// </summary>
    public static string ModeratorRight(AccessQueue queue) => queue switch
    {
        AccessQueue.Community => NotificationCategories.CommunityQueueModerator,
        AccessQueue.Auction => NotificationCategories.AuctionQueueModerator,
        _ => throw new ArgumentOutOfRangeException(nameof(queue), queue, "queue is not known"),
    };

    /// <summary>
    /// Категория настроек, которой человек отказывается от оповещений об
    /// очередях: у каждой очереди своя, потому что одно выключение на обе
    /// гасило и ту, о которой человек не думал (PER-635).
    /// </summary>
    public static NotificationCategory RequestCategory(AccessQueue queue) => queue switch
    {
        AccessQueue.Community => NotificationCategory.AccessRequestCommunity,
        AccessQueue.Auction => NotificationCategory.AccessRequestAuction,
        _ => throw new ArgumentOutOfRangeException(nameof(queue), queue, "queue is not known"),
    };

    /// <summary>
    /// Право, которое выдаёт допуск в очередь. Кто его держит, тот уже не ждёт:
    /// заявку в сообщество закрывает право хаба, заявку в аукцион — право
    /// ставок.
    /// </summary>
    public static string AdmissionRight(AccessQueue queue) => queue switch
    {
        AccessQueue.Community => "access_hub",
        AccessQueue.Auction => "place_bids",
        _ => throw new ArgumentOutOfRangeException(nameof(queue), queue, "queue is not known"),
    };

    /// <summary>
    /// Ключ очереди в колонке <c>notification.access_circle</c> — прежнее имя,
    /// под которым схема помнит факт о заявке. Очередь сообщества — <c>member</c>,
    /// очередь аукциона — <c>public</c>. Наружу ключ не выходит.
    /// </summary>
    public static string Circle(AccessQueue queue) => queue switch
    {
        AccessQueue.Community => "member",
        AccessQueue.Auction => "public",
        _ => throw new ArgumentOutOfRangeException(nameof(queue), queue, "queue is not known"),
    };

    /// <summary>Очередь заявки в адресном факте контракта <c>notifications.v1</c>.</summary>
    public static Identity.V1.ApplicationQueue ContractQueue(AccessQueue queue) => queue switch
    {
        AccessQueue.Community => Identity.V1.ApplicationQueue.Community,
        AccessQueue.Auction => Identity.V1.ApplicationQueue.Auction,
        _ => throw new ArgumentOutOfRangeException(nameof(queue), queue, "queue is not known"),
    };
}
