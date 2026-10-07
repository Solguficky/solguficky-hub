using Notifications.V1;

namespace Notifications.Auction;

/// <summary>Форма адресного факта; текста, Telegram ID и нового лидера в ней нет.</summary>
public static class AuctionFacts
{
    public const string OutbidType = "lot_outbid";
    public const string PurchasedType = "lot_purchased";
    public const string ProxyRaisedType = "lot_proxy_raised";
    public const string CauseKind = "auction_lot_event";

    public static Notification Outbid(Guid notificationId, AuctionBid bid, DateTimeOffset now, DateTimeOffset notAfter) =>
        Outbid(notificationId, bid.OutbidRecipient ?? throw new ArgumentException("bid has no outbid recipient", nameof(bid)),
            bid.LotId, bid.EventId, bid.Price, now, notAfter);

    /// <summary>
    /// Перебитие, свёрнутое окном частоты (PER-514): повод — событие, которым
    /// окно закрылось по существу, цена — цена этого события.
    /// </summary>
    public static Notification Outbid(Guid notificationId, Guid recipientId, Guid lotId, Guid causeEventId,
        global::Auction.V1.Money price, DateTimeOffset now, DateTimeOffset notAfter) => new()
    {
        NotificationId = notificationId.ToString(),
        RecipientId = recipientId.ToString(),
        CreatedAt = now.ToUniversalTime().ToString("O"),
        NotAfter = notAfter.ToUniversalTime().ToString("O"),
        Cause = new Cause { AuctionLotEventId = causeEventId.ToString() },
        LotOutbid = new LotOutbid { LotId = lotId.ToString(), CurrentPrice = price.Clone() },
    };

    public static Notification ProxyRaised(Guid notificationId, AuctionBid bid, DateTimeOffset now, DateTimeOffset notAfter) => new()
    {
        NotificationId = notificationId.ToString(),
        RecipientId = (bid.ProxyRaisedRecipient ?? throw new ArgumentException("bid did not answer another bidder", nameof(bid))).ToString(),
        CreatedAt = now.ToUniversalTime().ToString("O"),
        NotAfter = notAfter.ToUniversalTime().ToString("O"),
        Cause = new Cause { AuctionLotEventId = bid.EventId.ToString() },
        LotProxyRaised = new LotProxyRaised { LotId = bid.LotId.ToString(), CurrentPrice = bid.Price.Clone() },
    };

    public static Notification Purchased(Guid notificationId, AuctionSale sale, DateTimeOffset now, DateTimeOffset notAfter) => new()
    {
        NotificationId = notificationId.ToString(),
        RecipientId = sale.Winner.ToString(),
        CreatedAt = now.ToUniversalTime().ToString("O"),
        NotAfter = notAfter.ToUniversalTime().ToString("O"),
        Cause = new Cause { AuctionLotEventId = sale.EventId.ToString() },
        LotPurchased = new LotPurchased { LotId = sale.LotId.ToString(), Price = sale.Price.Clone() },
    };
}
