namespace AuctionService.Actors.Auction;

using System.Collections.Immutable;

public abstract record Response;

public sealed record AuctionStatusResponse(
    Guid AuctionId,
    AuctionPhase Phase,
    ImmutableList<int> LotIds
) : Response;

