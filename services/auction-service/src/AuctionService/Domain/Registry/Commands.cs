namespace AuctionService.Domain.Registry;

public abstract record RegistryCommand;

public sealed record RouteLotCommand(string EventId, int LotId, Lot.Command Command) : RegistryCommand;

public sealed record GetAuctionSession(string EventId) : RegistryCommand;

public sealed record RouteSessionCommand(string EventId, Session.Command Command) : RegistryCommand;
