using Auction.V1;
using Notifications.Messaging;

namespace Notifications.Auction;

public static class AuctionFeed
{
    public const string Source = "auction";
    public const string BidPlacedSubject = "events.auction.bid_placed";
    public const string LotSoldSubject = "events.auction.lot_sold";
    public static readonly EventFeed Feed = new(Source, "AUCTION_EVENTS", "notifications-auction-events");

    /// <summary>
    /// Subjects фактов лота и ветка, которую каждый обязан нести. Имя subject'а
    /// — <c>events.auction.</c> плюс имя ветки (integration.md, «Auction NATS»);
    /// всё вне таблицы — факты аукциона и счёта, их этот модуль не разбирает.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, LotEvent.OccasionOneofCase> LotSubjects =
        new Dictionary<string, LotEvent.OccasionOneofCase>(StringComparer.Ordinal)
        {
            ["events.auction.lot_drafted"] = LotEvent.OccasionOneofCase.LotDrafted,
            ["events.auction.lot_scheduled"] = LotEvent.OccasionOneofCase.LotScheduled,
            ["events.auction.lot_opened"] = LotEvent.OccasionOneofCase.LotOpened,
            [BidPlacedSubject] = LotEvent.OccasionOneofCase.BidPlaced,
            ["events.auction.ask_advanced"] = LotEvent.OccasionOneofCase.AskAdvanced,
            ["events.auction.deadline_extended"] = LotEvent.OccasionOneofCase.DeadlineExtended,
            [LotSoldSubject] = LotEvent.OccasionOneofCase.LotSold,
            ["events.auction.lot_unsold"] = LotEvent.OccasionOneofCase.LotUnsold,
            ["events.auction.lot_withdrawn"] = LotEvent.OccasionOneofCase.LotWithdrawn,
            ["events.auction.lot_held_for_final"] = LotEvent.OccasionOneofCase.LotHeldForFinal,
            ["events.auction.lot_resumed"] = LotEvent.OccasionOneofCase.LotResumed,
        };
}
