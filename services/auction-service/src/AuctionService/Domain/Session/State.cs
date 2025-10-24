namespace AuctionService.Domain.Session;

using System.Collections.Immutable;

public enum AuctionPhase
{
    NotStarted,
    OpenBidding,
    Finished
}

public sealed record State(
    string EventId,
    AuctionPhase Phase,
    ImmutableList<int> LotIds
)
{
    public static State Empty() => new(string.Empty, AuctionPhase.NotStarted, ImmutableList<int>.Empty);
}
