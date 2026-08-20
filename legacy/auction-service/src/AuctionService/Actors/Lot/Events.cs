namespace AuctionService.Actors.Lot;

public abstract record Event;

public sealed record BidPlaced(
    long UserId,
    double Amount,
    long? PreviousLeaderId,
    long Timestamp
) : Event;

public sealed record LotSold(long WinnerId, double FinalPrice, long Timestamp) : Event;

public sealed record AuctionFinished(long? WinnerId, double? FinalPrice, long Timestamp) : Event;

public sealed record ProxyBidSet(long UserId, double MaxAmount, long Timestamp) : Event;

