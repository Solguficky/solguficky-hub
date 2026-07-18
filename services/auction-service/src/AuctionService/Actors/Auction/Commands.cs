namespace AuctionService.Actors.Auction;

using AuctionService.Actors.Lot;

public abstract record Command;

public sealed record StartAuction(Ulid AuctionId, List<int> LotIds, Dictionary<int, LotConfig> LotConfigs) : Command;

public sealed record ForwardToLot(int LotId, Lot.Command LotCommand) : Command;

public sealed record EndOpenBidding() : Command;

public sealed record StartFinalPhase() : Command;

public sealed record FinishAuction() : Command;

public sealed record GetAuctionStatus() : Command;

