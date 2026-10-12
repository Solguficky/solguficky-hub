using Notifications.Infrastructure;
using Notifications.V1;

namespace Notifications.Auction;

/// <summary>Форма адресного факта; текста, Telegram ID и нового лидера в ней нет.</summary>
public static class AuctionFacts
{
    public const string OutbidType = "lot_outbid";
    public const string PurchasedType = "lot_purchased";
    public const string ProxyRaisedType = "lot_proxy_raised";
    public const string CauseKind = "auction_lot_event";

    public const string DigestType = "lot_activity_digest";
    public const string DigestCauseKind = "outbid_digest";

    public static Notification Outbid(Guid notificationId, AuctionBid bid, DateTimeOffset now, DateTimeOffset notAfter) => new()
    {
        NotificationId = notificationId.ToString(),
        RecipientId = (bid.OutbidRecipient ?? throw new ArgumentException("bid has no outbid recipient", nameof(bid))).ToString(),
        CreatedAt = now.ToUniversalTime().ToString("O"),
        NotAfter = notAfter.ToUniversalTime().ToString("O"),
        Cause = new Cause { AuctionLotEventId = bid.EventId.ToString() },
        LotOutbid = new LotOutbid { LotId = bid.LotId.ToString(), CurrentPrice = bid.Price.Clone() },
    };

    /// <summary>
    /// Сводка закрытого окна (PER-596): повод — само окно, строки — в порядке
    /// появления, с ценой и лидерством лота на закрытии.
    /// </summary>
    public static Notification Digest(Guid notificationId, ClosedDigest digest, DateTimeOffset now,
        DateTimeOffset notAfter)
    {
        var body = new LotActivityDigest();
        body.Lines.AddRange(digest.Lines.Select(line => new LotActivityLine
        {
            LotId = line.LotId.ToString(),
            Kind = line.Kind,
            CurrentPrice = line.Price.Clone(),
            RecipientLeads = line.RecipientLeads,
        }));
        return new Notification
        {
            NotificationId = notificationId.ToString(),
            RecipientId = digest.RecipientId.ToString(),
            CreatedAt = now.ToUniversalTime().ToString("O"),
            NotAfter = notAfter.ToUniversalTime().ToString("O"),
            Cause = new Cause { OutbidDigestId = digest.DigestId.ToString() },
            LotActivityDigest = body,
        };
    }

    /// <summary>
    /// Окно, закрытое продажей лота: строки проданного лота несут цену продажи,
    /// и человек его не ведёт — окно победителя продажа не закрывает.
    /// </summary>
    public static ClosedDigest Sold(ClosedDigest digest, Guid lotId, global::Auction.V1.Money price) =>
        digest with
        {
            Lines = digest.Lines
                .Select(line => line.LotId == lotId ? line with { RecipientLeads = false, Price = price } : line)
                .ToArray(),
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
