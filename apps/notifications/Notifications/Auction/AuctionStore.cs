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
/// «Перебили» и ответ своей автоставки фильтрует настройка получателя
/// (PER-514, PER-596), и читается она той же транзакцией, что и ключ события:
/// повтор, пришедший после смены настройки, уже отсечён ключом и решения не
/// меняет. Покупку настройка не трогает.
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

        // Решения по обоим адресатам — до записи: окна берутся раньше, чем
        // ставка тронет строки лота, потому что порядок блокировок — окна по
        // возрастанию идентификатора, затем строки (OutbidStore).
        var outbid = bid.OutbidRecipient is { } outbidRecipient
            ? new Addressed(outbidRecipient, LotActivityKind.Outbid,
                OutbidFrequencies.Decide(await OutbidStore.ReadPreference(work, outbidRecipient, cancellationToken)))
            : null;
        var proxy = bid.ProxyRaisedRecipient is { } proxyRecipient
            ? new Addressed(proxyRecipient, LotActivityKind.ProxyRaised,
                OutbidFrequencies.Decide(await OutbidStore.ReadPreference(work, proxyRecipient, cancellationToken)))
            : null;
        var collected = new[] { outbid, proxy }
            .OfType<Addressed>()
            .Where(addressed => addressed.Decision is OutbidDecision.Collect)
            .ToArray();
        await OutbidStore.LockForBid(work, bid.LotId,
            collected.ToDictionary(addressed => addressed.RecipientId,
                addressed => now + ((OutbidDecision.Collect)addressed.Decision).Window),
            now, cancellationToken);

        // Ставка обновляет все строки лота: лидера, повод и цену. Ручная ставка, перебитая той же командой, лидерства не дала, и
        // строк не трогает — их догонит следующее событие той же команды.
        if (!bid.OvertakenByProxy)
        {
            await OutbidStore.FollowLot(work, bid.LotId, bid.Leader, bid.EventId, bid.Version, bid.Price,
                cancellationToken);
        }
        foreach (var addressed in collected)
        {
            await OutbidStore.AddLine(work, addressed.RecipientId, bid.LotId, addressed.Kind,
                bid.Leader, bid.EventId, bid.Version, bid.Price, now, cancellationToken);
        }

        if (outbid is not null)
        {
            switch (outbid.Decision)
            {
                case OutbidDecision.Send:
                    var notification = AuctionFacts.Outbid(Guid.CreateVersion7(now), bid, now, notAfter);
                    created[AuctionFacts.OutbidType] = await NotificationStore.AddAddressed(work, notification,
                        AuctionFacts.OutbidType, AuctionFacts.CauseKind, bid.EventId.ToString(), now, notAfter,
                        cancellationToken,
                        await NotificationStore.DeliverySurface(work, outbid.RecipientId, cancellationToken));
                    outcome = AuctionOutcome.Outbid;
                    break;
                case OutbidDecision.Collect:
                    outcome = AuctionOutcome.Collected;
                    break;
                case OutbidDecision.Suppress:
                    outcome = AuctionOutcome.Suppressed;
                    break;
            }
        }
        // Уникальность факта — (тип, повод, получатель), поэтому лидер и
        // перебитый получают по факту от одного события, а повтор — ни одного.
        if (proxy is { Decision: OutbidDecision.Send })
        {
            var notification = AuctionFacts.ProxyRaised(Guid.CreateVersion7(now), bid, now, notAfter);
            created[AuctionFacts.ProxyRaisedType] = await NotificationStore.AddAddressed(work, notification,
                AuctionFacts.ProxyRaisedType, AuctionFacts.CauseKind, bid.EventId.ToString(), now, notAfter,
                cancellationToken,
                await NotificationStore.DeliverySurface(work, proxy.RecipientId, cancellationToken));
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

        // Торги кончились, и окна со строками лота закрываются сейчас, а не по
        // своему моменту: перебитый узнаёт итоговую цену, а не сводку после
        // конца торгов. Строка проданного лота несёт цену продажи.
        var digests = 0;
        foreach (var digest in await OutbidStore.TakeLot(work, sale.LotId, sale.Winner, cancellationToken))
        {
            digests += await SendDigest(work, AuctionFacts.Sold(digest, sale.LotId, sale.Price), now, notAfter,
                cancellationToken);
        }
        if (digests > 0)
        {
            created[AuctionFacts.DigestType] = digests;
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

    /// <summary>Люди, чьи окна сводки наступили, для прохода.</summary>
    public async Task<IReadOnlyList<Guid>> DueDigests(DateTimeOffset now, int limit,
        CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        var due = await OutbidStore.Due(work, now, limit, cancellationToken);
        await work.Commit(cancellationToken);
        return due;
    }

    /// <summary>
    /// Закрывает наступившее окно своей транзакцией: одна сводка со всеми его
    /// строками. Возвращает число созданных фактов.
    /// </summary>
    public async Task<int> CloseDigest(Guid recipientId, DateTimeOffset now, CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        var digest = await OutbidStore.TakeDue(work, recipientId, now, cancellationToken);
        var created = digest is null ? 0
            : await SendDigest(work, digest, now, now + options.Value.StaleAfter, cancellationToken);
        await work.Commit(cancellationToken);
        return created;
    }

    // Настройка читается и на закрытии: выключивший перебития за время окна
    // сводки уже не ждёт.
    private static async Task<int> SendDigest(UnitOfWork work, ClosedDigest digest, DateTimeOffset now,
        DateTimeOffset notAfter, CancellationToken cancellationToken)
    {
        if (digest.Lines.Count == 0
            || await OutbidStore.ReadPreference(work, digest.RecipientId, cancellationToken) == OutbidFrequency.Off)
        {
            return 0;
        }

        var notification = AuctionFacts.Digest(Guid.CreateVersion7(now), digest, now, notAfter);
        return await NotificationStore.AddAddressed(work, notification, AuctionFacts.DigestType,
            AuctionFacts.DigestCauseKind, digest.DigestId.ToString(), now, notAfter, cancellationToken,
            await NotificationStore.DeliverySurface(work, digest.RecipientId, cancellationToken));
    }

    private sealed record Addressed(Guid RecipientId, LotActivityKind Kind, OutbidDecision Decision);
}
