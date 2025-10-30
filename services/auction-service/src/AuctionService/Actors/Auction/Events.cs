namespace AuctionService.Actors.Auction;

public abstract record Event;

public sealed record AuctionStarted(string AuctionId, List<int> LotIds, long Timestamp) : Event;

public sealed record OpenBiddingStarted(long Timestamp) : Event;

public sealed record FinalPhaseStarted(long Timestamp) : Event;

public sealed record AuctionFinished(long Timestamp) : Event;

