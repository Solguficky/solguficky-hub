namespace AuctionService.Actors.Auction;

using System.Collections.Immutable;

public abstract record Response;

public sealed record AuctionStatusResponse(
    string AuctionId,
    AuctionPhase Phase,
    ImmutableList<int> LotIds
) : Response;

