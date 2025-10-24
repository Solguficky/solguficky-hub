namespace AuctionService.Domain.Session;

using AuctionService.Domain.Lot;

public abstract record Command;

public sealed record StartAuction(string EventId, List<int> LotIds, Dictionary<int, LotConfig> LotConfigs) : Command;

public sealed record RouteToLot(int LotId, Lot.Command Command) : Command;

public sealed record FinishAuction() : Command;

public sealed record GetAuctionStatus() : Command;

public sealed record LotConfig(double StartingPrice, double MinBidStep);
