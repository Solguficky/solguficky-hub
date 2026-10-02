using Notifications.V1;

namespace Notifications.Auction;

/// <summary>Форма адресного факта; текста, Telegram ID и нового лидера в ней нет.</summary>
public static class AuctionFacts
{
    public const string OutbidType = "lot_outbid";
    public const string CauseKind = "auction_lot_event";

    public static Notification Outbid(Guid notificationId, AuctionBid bid, DateTimeOffset now, DateTimeOffset notAfter) => new()
    {
        NotificationId = notificationId.ToString(),
        RecipientId = (bid.OutbidRecipient ?? throw new ArgumentException("bid has no outbid recipient", nameof(bid))).ToString(),
        CreatedAt = now.ToUniversalTime().ToString("O"),
        NotAfter = notAfter.ToUniversalTime().ToString("O"),
        Cause = new Cause { AuctionLotEventId = bid.EventId.ToString() },
        LotOutbid = new LotOutbid { LotId = bid.LotId.ToString(), CurrentPrice = bid.Price.Clone() },
    };
}
