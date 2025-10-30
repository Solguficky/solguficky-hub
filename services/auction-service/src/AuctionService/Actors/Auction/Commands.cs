namespace AuctionService.Actors.Auction;

using AuctionService.Actors.Lot;

public abstract record Command;

public sealed record StartAuction(string AuctionId, List<int> LotIds, Dictionary<int, LotConfig> LotConfigs) : Command;

public sealed record RouteToLot(int LotId, Lot.Command Command) : Command;

public sealed record TransitionToFinalPhase() : Command;

public sealed record FinishAuction() : Command;

public sealed record GetAuctionStatus() : Command;

public sealed record LotConfig(double StartingPrice, double MinBidStep);

