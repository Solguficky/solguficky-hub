using Notifications.Messaging;

namespace Notifications.Auction;

public static class AuctionFeed
{
    public const string Source = "auction";
    public const string BidPlacedSubject = "events.auction.bid_placed";
    public static readonly EventFeed Feed = new(Source, "AUCTION_EVENTS", "notifications-auction-events");
}
