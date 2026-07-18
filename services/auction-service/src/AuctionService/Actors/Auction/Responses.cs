namespace AuctionService.Actors.Auction;

using System.Collections.Immutable;

public abstract record Response;

public sealed record AuctionStatusResponse(
    Ulid AuctionId,
    AuctionPhase Phase,
    ImmutableList<int> LotIds
) : Response;

