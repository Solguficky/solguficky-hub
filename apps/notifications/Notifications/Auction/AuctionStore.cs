using Microsoft.Extensions.Options;
using Notifications.Domain;
using Notifications.Facts;
using Notifications.Infrastructure;
using Notifications.Messaging;
using Notifications.V1;
using Npgsql;

namespace Notifications.Auction;

public enum AuctionOutcome { Outbid, FirstBid, LeaderUnchanged, Overtaken, Purchased, Duplicate, Suppressed, Collected, LotReplicated }

/// <summary>Исход повода и созданные факты по типу: ставка даёт до двух — перебитому и лидеру автоставки.</summary>
public sealed record AuctionApplication(AuctionOutcome Outcome, IReadOnlyDictionary<string, int> Created)
{
    public int FactsCreated => Created.Values.Sum();
}

/// <summary>Ключ события, реплика лота и адресный факт — одна транзакция, без чтения чужой реплики.</summary>
/// <remarks>
/// «Перебили» фильтрует настройка получателя (PER-514), и читается она той же
/// транзакцией, что и ключ события: повтор, пришедший после смены настройки,
/// уже отсечён ключом и решения не меняет. Остальные факты аукциона настройка
/// не трогает.
/// </remarks>
public sealed class AuctionStore(NpgsqlDataSource source, IOptions<FactOptions> options)
{
    public async Task<AuctionApplication> Apply(AuctionBid bid, DateTimeOffset now, CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        if (await ConsumedEventStore.Consume(work, AuctionFeed.Source, bid.EventId, now, cancellationToken) == 0)
        {
            return new AuctionApplication(AuctionOutcome.Duplicate, new Dictionary<string, int>());
        }

        // Реплика и отметка — той же транзакцией, что ключ: повтор события до
        // них не доходит, а дошедший после чистки ключа гаснет на версии
        // реплики и первичном ключе отметки. Отметку получает лидер ставки
        // (state.trading.leader_id), ручной и автоставки одинаково, если на этом
        // лоте у него не было ни отметки, ни снятия (ADR-063, п. 2).
        if (bid.Snapshot is { } snapshot)
        {
            await LotReplicaStore.Apply(work, snapshot, now, cancellationToken);
        }
        await FavoriteStore.AutoFollow(work, bid.Leader, bid.LotId, now, cancellationToken);

        var created = new Dictionary<string, int>();
        var notAfter = now + options.Value.StaleAfter;
        var outcome = bid.PreviousLeader is null ? AuctionOutcome.FirstBid
            : bid.OvertakenByProxy ? AuctionOutcome.Overtaken
            : AuctionOutcome.LeaderUnchanged;

        // Ставка обновляет все открытые окна лота: отметку «перебит» по её
        // лидеру, повод и цену. Ручная ставка, перебитая той же командой,
        // лидерства не дала, и её снимок окна не трогает — их догонит
        // следующее событие той же команды.
        if (!bid.OvertakenByProxy)
        {
            await OutbidStore.FollowLot(work, bid.LotId, bid.Leader, bid.EventId, bid.Version, bid.Price,
                cancellationToken);
        }

        if (bid.OutbidRecipient is { } recipient)
        {
            var preference = await OutbidStore.ReadPreference(work, recipient, cancellationToken);
            switch (OutbidFrequencies.Decide(preference))
            {
                case OutbidDecision.Send:
                    var notification = AuctionFacts.Outbid(Guid.CreateVersion7(now), bid, now, notAfter);
                    created[AuctionFacts.OutbidType] = await NotificationStore.AddAddressed(work, notification,
                        AuctionFacts.OutbidType, AuctionFacts.CauseKind, bid.EventId.ToString(), now, notAfter,
                        cancellationToken,
                        await NotificationStore.DeliverySurface(work, recipient, cancellationToken));
                    outcome = AuctionOutcome.Outbid;
                    break;
                case OutbidDecision.Collect collect:
                    await OutbidStore.Open(work, bid.LotId, recipient, bid.EventId, bid.Version, bid.Price, now,
                        now + collect.Window, cancellationToken);
                    outcome = AuctionOutcome.Collected;
                    break;
                case OutbidDecision.Suppress:
                    outcome = AuctionOutcome.Suppressed;
                    break;
            }
        }
        // Уникальность факта — (тип, повод, получатель), поэтому лидер и
        // перебитый получают по факту от одного события, а повтор — ни одного.
        if (bid.ProxyRaisedRecipient is not null)
        {
            var notification = AuctionFacts.ProxyRaised(Guid.CreateVersion7(now), bid, now, notAfter);
            created[AuctionFacts.ProxyRaisedType] = await NotificationStore.AddAddressed(work, notification,
                AuctionFacts.ProxyRaisedType, AuctionFacts.CauseKind, bid.EventId.ToString(), now, notAfter,
                cancellationToken,
                await NotificationStore.DeliverySurface(work, bid.ProxyRaisedRecipient.Value, cancellationToken));
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

        if (sale.Snapshot is { } snapshot)
        {
            await LotReplicaStore.Apply(work, snapshot, now, cancellationToken);
        }

        var notAfter = now + options.Value.StaleAfter;
        var notification = AuctionFacts.Purchased(Guid.CreateVersion7(now), sale, now, notAfter);
        var created = new Dictionary<string, int>
        {
            [AuctionFacts.PurchasedType] = await NotificationStore.AddAddressed(work, notification,
                AuctionFacts.PurchasedType, AuctionFacts.CauseKind, sale.EventId.ToString(), now, notAfter,
                cancellationToken,
                await NotificationStore.DeliverySurface(work, sale.Winner, cancellationToken)),
        };

        // Торги кончились, и окна лота закрываются сейчас, а не по своему
        // моменту: перебитый узнаёт итоговую цену, а не «перебили» после
        // продажи. Повод и цена — продажи.
        var outbid = 0;
        foreach (var window in await OutbidStore.TakeLot(work, sale.LotId, cancellationToken))
        {
            if (window.RecipientId != sale.Winner)
            {
                outbid += await SendIfOutbid(work, window, sale.EventId, sale.Price, now, notAfter, cancellationToken);
            }
        }
        if (outbid > 0)
        {
            created[AuctionFacts.OutbidType] = outbid;
        }

        await work.Commit(cancellationToken);
        return new AuctionApplication(AuctionOutcome.Purchased, created);
    }

    /// <summary>Факт лота без повода: ключ и снимок реплики одной транзакцией.</summary>
    public async Task<AuctionApplication> Apply(AuctionLotFact fact, DateTimeOffset now, CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        if (await ConsumedEventStore.Consume(work, AuctionFeed.Source, fact.EventId, now, cancellationToken) == 0)
        {
            return new AuctionApplication(AuctionOutcome.Duplicate, new Dictionary<string, int>());
        }

        await LotReplicaStore.Apply(work, fact.Snapshot, now, cancellationToken);

        await work.Commit(cancellationToken);
        return new AuctionApplication(AuctionOutcome.LotReplicated, new Dictionary<string, int>());
    }

    /// <summary>Наступившие окна частоты для прохода.</summary>
    public async Task<IReadOnlyList<OutbidWindowKey>> DueWindows(DateTimeOffset now, int limit,
        CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        var due = await OutbidStore.Due(work, now, limit, cancellationToken);
        await work.Commit(cancellationToken);
        return due;
    }

    /// <summary>
    /// Закрывает наступившее окно своей транзакцией: одно сообщение, если
    /// участник всё ещё перебит. Возвращает число созданных фактов.
    /// </summary>
    public async Task<int> CloseWindow(OutbidWindowKey key, DateTimeOffset now, CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        var window = await OutbidStore.TakeDue(work, key, now, cancellationToken);
        var created = window is null ? 0
            : await SendIfOutbid(work, window, window.LastEventId, window.Price, now, now + options.Value.StaleAfter,
                cancellationToken);
        await work.Commit(cancellationToken);
        return created;
    }

    // Настройка читается и на закрытии: выключивший перебития за время окна
    // сообщения уже не ждёт.
    private static async Task<int> SendIfOutbid(UnitOfWork work, ClosedOutbidWindow window, Guid causeEventId,
        global::Auction.V1.Money price, DateTimeOffset now, DateTimeOffset notAfter, CancellationToken cancellationToken)
    {
        if (!window.Outbid
            || await OutbidStore.ReadPreference(work, window.RecipientId, cancellationToken) == OutbidFrequency.Off)
        {
            return 0;
        }

        var notification = AuctionFacts.Outbid(Guid.CreateVersion7(now), window.RecipientId, window.LotId,
            causeEventId, price, now, notAfter);
        return await NotificationStore.AddAddressed(work, notification, AuctionFacts.OutbidType,
            AuctionFacts.CauseKind, causeEventId.ToString(), now, notAfter, cancellationToken,
            await NotificationStore.DeliverySurface(work, window.RecipientId, cancellationToken));
    }
}
