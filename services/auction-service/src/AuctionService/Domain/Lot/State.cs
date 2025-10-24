namespace AuctionService.Domain.Lot;

using System.Collections.Immutable;

public sealed record State(
    int LotId,
    double StartingPrice,
    double MinBidStep,
    double? CurrentPrice,
    long? CurrentLeaderId,
    ImmutableList<BidPlaced> Bids,
    DateTimeOffset? EndTime,
    bool IsFinished,
    ImmutableDictionary<long, double> ProxyBids
)
{
    public static State Empty(int lotId, double startingPrice, double minBidStep) =>
        new(lotId, startingPrice, minBidStep, null, null, [], null, false, ImmutableDictionary<long, double>.Empty);
}

