namespace AuctionService.Actors.Lot;

public abstract record Command;

public sealed record PlaceBid(long UserId, double Amount) : Command;

public sealed record GetStatus() : Command;

public sealed record StartLotTimer() : Command;

public sealed record SetProxyBid(long UserId, double MaxAmount) : Command;

internal sealed record AuctionTimerTick() : Command;

