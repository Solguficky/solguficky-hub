using Microsoft.Extensions.Options;
using Notifications.Facts;
using Notifications.Infrastructure;
using Notifications.Messaging;
using Npgsql;

namespace Notifications.Auction;

public enum AuctionOutcome { Outbid, FirstBid, LeaderUnchanged, Overtaken, Purchased, Duplicate }

/// <summary>Исход повода и созданные факты по типу: ставка даёт до двух — перебитому и лидеру автоставки.</summary>
public sealed record AuctionApplication(AuctionOutcome Outcome, IReadOnlyDictionary<string, int> Created)
{
    public int FactsCreated => Created.Values.Sum();
}

/// <summary>Ключ события и адресный факт — одна транзакция, без чтения чужой реплики.</summary>
public sealed class AuctionStore(NpgsqlDataSource source, IOptions<FactOptions> options)
{
    public async Task<AuctionApplication> Apply(AuctionBid bid, DateTimeOffset now, CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        if (await ConsumedEventStore.Consume(work, AuctionFeed.Source, bid.EventId, now, cancellationToken) == 0)
        {
            return new AuctionApplication(AuctionOutcome.Duplicate, new Dictionary<string, int>());
        }

        var created = new Dictionary<string, int>();
        var notAfter = now + options.Value.StaleAfter;
        var outcome = bid.PreviousLeader is null ? AuctionOutcome.FirstBid
            : bid.OvertakenByProxy ? AuctionOutcome.Overtaken
            : AuctionOutcome.LeaderUnchanged;
        if (bid.OutbidRecipient is not null)
        {
            var notification = AuctionFacts.Outbid(Guid.CreateVersion7(now), bid, now, notAfter);
            created[AuctionFacts.OutbidType] = await NotificationStore.AddAddressed(work, notification, AuctionFacts.OutbidType,
                AuctionFacts.CauseKind, bid.EventId.ToString(), now, notAfter, cancellationToken);
            outcome = AuctionOutcome.Outbid;
        }
        // Уникальность факта — (тип, повод, получатель), поэтому лидер и
        // перебитый получают по факту от одного события, а повтор — ни одного.
        if (bid.ProxyRaisedRecipient is not null)
        {
            var notification = AuctionFacts.ProxyRaised(Guid.CreateVersion7(now), bid, now, notAfter);
            created[AuctionFacts.ProxyRaisedType] = await NotificationStore.AddAddressed(work, notification,
                AuctionFacts.ProxyRaisedType, AuctionFacts.CauseKind, bid.EventId.ToString(), now, notAfter, cancellationToken);
        }
        await work.Commit(cancellationToken);
        return new AuctionApplication(outcome, created);
    }

    public async Task<AuctionApplication> Apply(AuctionSale sale, DateTimeOffset now, CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        if (await ConsumedEventStore.Consume(work, AuctionFeed.Source, sale.EventId, now, cancellationToken) == 0)
        {
            return new AuctionApplication(AuctionOutcome.Duplicate, new Dictionary<string, int>());
        }

        var notAfter = now + options.Value.StaleAfter;
        var notification = AuctionFacts.Purchased(Guid.CreateVersion7(now), sale, now, notAfter);
        var created = await NotificationStore.AddAddressed(work, notification, AuctionFacts.PurchasedType,
            AuctionFacts.CauseKind, sale.EventId.ToString(), now, notAfter, cancellationToken);
        await work.Commit(cancellationToken);
        return new AuctionApplication(AuctionOutcome.Purchased,
            new Dictionary<string, int> { [AuctionFacts.PurchasedType] = created });
    }
}
