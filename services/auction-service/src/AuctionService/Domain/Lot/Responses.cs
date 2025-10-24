namespace AuctionService.Domain.Lot;

public abstract record Response;

public sealed record BidAccepted(double Amount) : Response;

public sealed record BidRejected(string Reason) : Response;

public sealed record StatusResponse(
    double CurrentPrice,
    long? LeaderId,
    DateTimeOffset? EndTime
) : Response;
