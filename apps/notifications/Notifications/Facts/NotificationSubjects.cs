namespace Notifications.Facts;

/// <summary>Маршрут адресного факта в NOTIFICATIONS_EVENTS.</summary>
public static class NotificationSubjects
{
    public const string Hub = "hub";
    public const string Auction = "auction";
    public const string Base = "events.notifications.notification_created";

    public static string For(string surface) => surface switch
    {
        Hub => $"{Base}.{Hub}",
        Auction => $"{Base}.{Auction}",
        _ => throw new ArgumentOutOfRangeException(nameof(surface), surface, "unknown notification surface"),
    };
}
