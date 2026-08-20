namespace AuctionService.Actors.Auction;

using System.Collections.Immutable;

public enum AuctionPhase
{
    NotStarted,
    Idle,
    OpenBidding,
    Final,
    Finished
}

public sealed record State(
    Guid AuctionId,
    AuctionPhase Phase,
    ImmutableList<(int LotId, int DisplayOrder)> Lots
)
{
    public static State Empty() => new(Guid.Empty, AuctionPhase.NotStarted, []);
}

