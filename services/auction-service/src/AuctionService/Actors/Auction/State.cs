namespace AuctionService.Actors.Auction;

using System.Collections.Immutable;

public enum AuctionPhase
{
    NotStarted,
    OpenBidding,
    Final,
    Finished
}

public sealed record State(
    string AuctionId,
    AuctionPhase Phase,
    ImmutableList<int> LotIds
)
{
    public static State Empty() => new(string.Empty, AuctionPhase.NotStarted, ImmutableList<int>.Empty);
}

