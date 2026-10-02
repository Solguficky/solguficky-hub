using Microsoft.Extensions.Options;
using Notifications.Facts;
using Notifications.Infrastructure;
using Notifications.Messaging;
using Npgsql;

namespace Notifications.Auction;

public enum AuctionOutcome { Outbid, FirstBid, LeaderUnchanged, Duplicate }
public sealed record AuctionApplication(AuctionOutcome Outcome, int FactsCreated);

/// <summary>Ключ события и адресный факт — одна транзакция, без чтения чужой реплики.</summary>
public sealed class AuctionStore(NpgsqlDataSource source, IOptions<FactOptions> options)
{
    public async Task<AuctionApplication> Apply(AuctionBid bid, DateTimeOffset now, CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        if (await ConsumedEventStore.Consume(work, AuctionFeed.Source, bid.EventId, now, cancellationToken) == 0)
        {
            return new AuctionApplication(AuctionOutcome.Duplicate, 0);
        }

        var created = 0;
        var outcome = bid.PreviousLeader is null ? AuctionOutcome.FirstBid : AuctionOutcome.LeaderUnchanged;
        if (bid.OutbidRecipient is not null)
        {
            var notAfter = now + options.Value.StaleAfter;
            var notification = AuctionFacts.Outbid(Guid.CreateVersion7(now), bid, now, notAfter);
            created = await NotificationStore.AddAddressed(work, notification, AuctionFacts.OutbidType,
                AuctionFacts.CauseKind, bid.EventId.ToString(), now, notAfter, cancellationToken);
            outcome = AuctionOutcome.Outbid;
        }
        await work.Commit(cancellationToken);
        return new AuctionApplication(outcome, created);
    }
}
