namespace AuctionService.Domain.Session;

using System.Collections.Immutable;

public abstract record Response;

public sealed record AuctionStatusResponse(
    string EventId,
    AuctionPhase Phase,
    ImmutableList<int> LotIds
) : Response;

