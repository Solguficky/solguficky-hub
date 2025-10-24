namespace AuctionService.Domain.Session;

public abstract record Event;

public sealed record AuctionStarted(string EventId, List<int> LotIds, long Timestamp) : Event;

public sealed record OpenBiddingStarted(long Timestamp) : Event;

public sealed record AuctionFinished(long Timestamp) : Event;
