using Microsoft.Extensions.Options;
using Notifications.Domain;
using Notifications.Facts;
using Notifications.Infrastructure;
using Notifications.Messaging;
using Notifications.V1;
using Npgsql;

namespace Notifications.Auction;

public enum AuctionOutcome
{
    Outbid, FirstBid, LeaderUnchanged, Overtaken, Purchased, Duplicate, Suppressed, Collected, LotReplicated,
    FinalAnnounced, LineupPending, LineupIncomplete, AuctionForgotten, RaffleAnnounced, PredictionResultsAnnounced,
    AuctionCancelled, AuctionEnded,
    FinalLotNext, LeadRestored, LotSetCollected,
    Announcement, AnnouncementWithdrawn, StandingRecorded,
    InvoiceReplicated, InvoiceStale,
    TradingEnded,
}

/// <summary>Исход повода и созданные факты по типу: ставка даёт до двух — перебитому и лидеру автоставки.</summary>
public sealed record AuctionApplication(AuctionOutcome Outcome, IReadOnlyDictionary<string, int> Created)
{
    public int FactsCreated => Created.Values.Sum();
}

/// <summary>Ключ события, реплика лота и адресный факт — одна транзакция, без чтения чужой реплики.</summary>
/// <remarks>
/// «Перебили» и ответ своей автоставки фильтрует настройка получателя
/// (PER-514, PER-596), в живом финале — выключатель перебитий в финале
/// (PER-645), и читается она той же транзакцией, что и ключ события:
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

        // Ставка кончившегося аукциона пришла позже его конца: ни реплики, ни
        // отметки, ни круга анонса она не создаёт (ADR-063, дополнение
        // 2026-10-12). Блокировка аукциона держит порядок с его концом.
        await AuctionEndStore.LockShared(work, bid.AuctionId, cancellationToken);
        var ended = await AuctionEndStore.Read(work, bid.AuctionId, cancellationToken);
        if (ended is null)
        {
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

            // Лидер ставки — участник аукциона и адресат анонса финала (PER-477).
            // Ручная ставка, перебитая той же командой, тоже участие: человек
            // ставил, а лидерство он потерял уже чужой автоставкой.
            await FinalStore.AddBidder(work, bid.AuctionId, bid.Leader, now, cancellationToken);

            // Ставивший на лот узнает, что лот продан в финале (PER-812).
            await FinalStore.AddLotBidder(work, bid.LotId, bid.Leader, now, cancellationToken);
        }

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
                await Decide(work, outbidRecipient, bid.LiveFinal, cancellationToken))
            : null;
        var proxy = bid.ProxyRaisedRecipient is { } proxyRecipient
            ? new Addressed(proxyRecipient, LotActivityKind.ProxyRaised,
                await Decide(work, proxyRecipient, bid.LiveFinal, cancellationToken))
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

        // Лидер поздней ставки отменённого аукциона узнаёт об отмене, даже если
        // отметки у него не было: повод — сам факт отмены, и уже извещённый
        // гаснет на ключе (тип, повод, получатель) (ADR-047, «Факт отмены»).
        if (ended is { End: AuctionEnd.Cancelled } cancelled)
        {
            var notification = AuctionFacts.Cancellation(Guid.CreateVersion7(now), bid.Leader, bid.AuctionId,
                cancelled.MeetupId, cancelled.EventId, [], now, notAfter);
            created[AuctionFacts.AuctionCancelledType] = await NotificationStore.AddAddressed(work, notification,
                AuctionFacts.AuctionCancelledType, AuctionFacts.AuctionCauseKind, cancelled.EventId.ToString(), now,
                notAfter, cancellationToken,
                await NotificationStore.DeliverySurface(work, bid.Leader, cancellationToken));
        }
        await work.Commit(cancellationToken);
        return new AuctionApplication(outcome, created);
    }

    // В живом финале частота не действует: решает выключатель перебитий в
    // финале (PER-645), и в окно сводки ставка финала не попадает.
    private static async Task<OutbidDecision> Decide(UnitOfWork work, Guid recipient, bool liveFinal,
        CancellationToken cancellationToken) =>
        liveFinal
            ? OutbidFrequencies.DecideLiveFinal(await OutbidStore.ReadLiveFinal(work, recipient, cancellationToken))
            : OutbidFrequencies.Decide(await OutbidStore.ReadPreference(work, recipient, cancellationToken));

    public async Task<AuctionApplication> Apply(AuctionSale sale, DateTimeOffset now, CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        if (await ConsumedEventStore.Consume(work, AuctionFeed.Source, sale.EventId, now, cancellationToken) == 0)
        {
            return new AuctionApplication(AuctionOutcome.Duplicate, new Dictionary<string, int>());
        }

        // Продажа кончившегося аукциона остаётся продажей и покупку извещает, но
        // реплику его лота уже не воскрешает.
        await AuctionEndStore.LockShared(work, sale.AuctionId, cancellationToken);
        var ended = await AuctionEndStore.Read(work, sale.AuctionId, cancellationToken);
        if (sale.Snapshot is { } snapshot && ended is null)
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

        // Покупатель продажи, пришедшей после отмены, узнаёт об отмене со своей
        // покупкой, как лидер поздней ставки; уже извещённый гаснет на ключе.
        if (ended is { End: AuctionEnd.Cancelled } cancelled)
        {
            var purchase = new EndedLot(sale.LotId, LotStatus.Sold, sale.Winner, sale.Price);
            var cancellation = AuctionFacts.Cancellation(Guid.CreateVersion7(now), sale.Winner, sale.AuctionId,
                cancelled.MeetupId, cancelled.EventId, [purchase], now, notAfter);
            created[AuctionFacts.AuctionCancelledType] = await NotificationStore.AddAddressed(work, cancellation,
                AuctionFacts.AuctionCancelledType, AuctionFacts.AuctionCauseKind, cancelled.EventId.ToString(), now,
                notAfter, cancellationToken,
                await NotificationStore.DeliverySurface(work, sale.Winner, cancellationToken));
        }

        // Лот продан в финале: об этом узнают все, кто на него ставил, кроме
        // победителя — ему уже пришла покупка (PER-812). Выключатель анонса
        // финала гасит и эту весть.
        if (ended is null && await FinalStore.IsFinalLot(work, sale.LotId, cancellationToken))
        {
            var bidders = (await FinalStore.LotBidders(work, sale.LotId, cancellationToken))
                .Where(bidder => bidder != sale.Winner)
                .ToArray();
            var silenced = await FinalStore.Silenced(work, bidders, cancellationToken);
            var inFinal = 0;
            foreach (var bidder in bidders.Where(bidder => !silenced.Contains(bidder)))
            {
                inFinal += await NotificationStore.AddAddressed(work,
                    AuctionFacts.LotSoldInFinal(Guid.CreateVersion7(now), bidder, sale, now, notAfter),
                    AuctionFacts.LotSoldInFinalType, AuctionFacts.CauseKind, sale.EventId.ToString(), now, notAfter,
                    cancellationToken, await NotificationStore.DeliverySurface(work, bidder, cancellationToken));
            }
            created[AuctionFacts.LotSoldInFinalType] = inFinal;
        }

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

        // Факт лота кончившегося аукциона — например, снятие после отмены — ни
        // реплики, ни удержания для анонса не пишет.
        await AuctionEndStore.LockShared(work, fact.Snapshot.AuctionId, cancellationToken);
        if (await AuctionEndStore.Read(work, fact.Snapshot.AuctionId, cancellationToken) is not null)
        {
            await work.Commit(cancellationToken);
            return new AuctionApplication(AuctionOutcome.AuctionEnded, new Dictionary<string, int>());
        }

        await LotReplicaStore.Apply(work, fact.Snapshot, now, cancellationToken);
        if (fact.Hold is { } hold)
        {
            await FinalStore.Hold(work, hold, cancellationToken);
        }

        await work.Commit(cancellationToken);
        return new AuctionApplication(AuctionOutcome.LotReplicated, new Dictionary<string, int>());
    }

    /// <summary>
    /// Снятие участника с лота (ADR-072, PER-672): реплика лота после снятия и
    /// отметка новому лидеру — той же транзакцией, что ключ события, а поверх
    /// них сообщение «ведение вернулось». Его получает только новый лидер, и
    /// только когда лидерство сменилось: снятие того, кто лот не вёл, и снятие
    /// единственного участника повода не дают, а снятому не пишется ничего.
    /// Настройка перебитий сообщение не гасит: ставки получатель не делал.
    /// </summary>
    public async Task<AuctionApplication> Apply(AuctionRemoval removal, DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        if (await ConsumedEventStore.Consume(work, AuctionFeed.Source, removal.EventId, now, cancellationToken) == 0)
        {
            return new AuctionApplication(AuctionOutcome.Duplicate, new Dictionary<string, int>());
        }

        // Снятие лота кончившегося аукциона ни реплики, ни сообщения не пишет.
        await AuctionEndStore.LockShared(work, removal.Snapshot.AuctionId, cancellationToken);
        if (await AuctionEndStore.Read(work, removal.Snapshot.AuctionId, cancellationToken) is not null)
        {
            await work.Commit(cancellationToken);
            return new AuctionApplication(AuctionOutcome.AuctionEnded, new Dictionary<string, int>());
        }

        await LotReplicaStore.Apply(work, removal.Snapshot, now, cancellationToken);

        // Снятие меняет лидера и цену лота, а строки открытого окна перебитий
        // несут их на момент последней ставки: без этой правки сводка сказала бы
        // «лот за тобой» тому, кто лот уже не ведёт, и назвала бы старую цену.
        await OutbidStore.FollowLot(work, removal.Snapshot.LotId, removal.Snapshot.Leader, removal.EventId,
            removal.Snapshot.Version, removal.Price, cancellationToken);

        // Удержание лота помнит лидера и цену на момент удержания: снятие
        // участника меняет и их, а состав финала и весть «твой лот следующий»
        // читают их оттуда — снятому они достаться не должны.
        if (removal.Snapshot.Status == LotStatus.Held)
        {
            await FinalStore.UpdateHold(work, removal.Snapshot.LotId, removal.Snapshot.Leader, removal.Price,
                cancellationToken);
        }

        var created = new Dictionary<string, int>();
        if (removal.Snapshot.Leader is { } leader)
        {
            // Отметка — как у лидера ставки: лот, который человек ведёт, он видит
            // в избранном. Снятую отметку вставка не возвращает, как и у ставки.
            await FavoriteStore.AutoFollow(work, leader, removal.Snapshot.LotId, now, cancellationToken);
        }

        var restored = removal.RestoredRecipient;
        if (restored is not null)
        {
            var notAfter = now + options.Value.StaleAfter;
            var notification = AuctionFacts.LeadRestored(Guid.CreateVersion7(now), removal, now, notAfter);
            created[AuctionFacts.LeadRestoredType] = await NotificationStore.AddAddressed(work, notification,
                AuctionFacts.LeadRestoredType, AuctionFacts.CauseKind, removal.EventId.ToString(), now, notAfter,
                cancellationToken,
                await NotificationStore.DeliverySurface(work, restored.Value, cancellationToken));
        }

        await work.Commit(cancellationToken);
        return new AuctionApplication(
            restored is null ? AuctionOutcome.LotReplicated : AuctionOutcome.LeadRestored, created);
    }

    /// <summary>
    /// Анонс финала (PER-477): по факту на человека из круга аукциона и
    /// лидеров лотов состава. У заморозки лидер лота состава получает тот же
    /// факт со своими лотами, а не второй. Удержание каждого лота состава
    /// приходит своим фактом и может отстать: пока его нет и срок ожидания не
    /// вышел, анонс откатывается целиком, и сообщение возвращается в поток.
    /// После срока анонс уходит по известным удержаниям.
    /// </summary>
    public async Task<AuctionApplication> Apply(AuctionFinal final, DateTimeOffset now, CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        if (await ConsumedEventStore.Consume(work, AuctionFeed.Source, final.EventId, now, cancellationToken) == 0)
        {
            return new AuctionApplication(AuctionOutcome.Duplicate, new Dictionary<string, int>());
        }

        // Анонс, вернувшийся в поток ждать удержаний, мог догнать конец аукциона:
        // кончившемуся аукциону финал не анонсируется, и круг его уже забыт.
        await AuctionEndStore.LockShared(work, final.AuctionId, cancellationToken);
        if (await AuctionEndStore.Read(work, final.AuctionId, cancellationToken) is not null)
        {
            await work.Commit(cancellationToken);
            return new AuctionApplication(AuctionOutcome.AuctionEnded, new Dictionary<string, int>());
        }

        var held = await FinalStore.Held(work, final.Lineup, cancellationToken);
        var complete = held.Count == final.Lineup.Count;
        var lineupFrozen = final.Occasion == FinalOccasion.LineupFrozen;
        if (lineupFrozen && !complete && now - final.OccurredAt < options.Value.FinalLineupWait)
        {
            return new AuctionApplication(AuctionOutcome.LineupPending, new Dictionary<string, int>());
        }
        var lineup = final.Lineup.Where(held.ContainsKey).Select(lot => held[lot]).ToArray();

        // Состав и старт идут всем держателям права ставок, а не только ведшим
        // лот (PER-812); лидер состава попадает в круг в любом случае. Выключивший
        // анонс финала (PER-539) не получает ни состава, ни старта: настройку
        // читает та же транзакция, что пишет факты.
        var audience = await FinalAudience(work, lineup.Select(lot => lot.Leader).OfType<Guid>(),
            cancellationToken);

        var notAfter = now + options.Value.StaleAfter;
        var type = lineupFrozen ? AuctionFacts.FinalLineupType : AuctionFacts.FinalStartedType;
        var created = 0;
        // Состав без единого известного удержания показать нечем: факта нет,
        // а исход говорит, что состав неполон.
        if (!lineupFrozen || lineup.Length > 0)
        {
            foreach (var recipient in audience)
            {
                var notification = lineupFrozen
                    ? AuctionFacts.FinalLineup(Guid.CreateVersion7(now), recipient, final, lineup, now, notAfter)
                    : AuctionFacts.FinalStarted(Guid.CreateVersion7(now), recipient, final, now, notAfter);
                created += await NotificationStore.AddAddressed(work, notification, type,
                    AuctionFacts.AuctionCauseKind, final.EventId.ToString(), now, notAfter, cancellationToken,
                    await NotificationStore.DeliverySurface(work, recipient, cancellationToken));
            }
        }

        // Финал начался: первый лот состава идёт следующим, и его лидер узнаёт
        // об этом (ADR-063, дополнение 2026-10-20).
        var nextCreated = 0;
        if (!lineupFrozen && final.Lineup.Count > 0)
        {
            nextCreated = await AnnounceNext(work, final.Lineup[0], null, final.Lineup, final.EventId, now,
                cancellationToken);
        }

        await work.Commit(cancellationToken);
        var outcome = lineupFrozen && !complete ? AuctionOutcome.LineupIncomplete : AuctionOutcome.FinalAnnounced;
        var counts = new Dictionary<string, int> { [type] = created };
        if (nextCreated > 0)
        {
            counts[AuctionFacts.FinalLotNextType] = nextCreated;
        }
        return new AuctionApplication(outcome, counts);
    }

    /// <summary>
    /// Лот финала взяли в работу: следующий лот состава известен, и его лидер
    /// узнаёт, что его лот идёт следом (ADR-063, дополнение 2026-10-20).
    /// </summary>
    public async Task<AuctionApplication> Apply(AuctionFinalLotActivated activated, DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        if (await ConsumedEventStore.Consume(work, AuctionFeed.Source, activated.EventId, now, cancellationToken) == 0)
        {
            return new AuctionApplication(AuctionOutcome.Duplicate, new Dictionary<string, int>());
        }

        await FinalStore.TrackLot(work, activated.AuctionId, activated.ActiveLotId, activated.Lineup,
            activated.OccurredAt, cancellationToken);

        var created = await AnnounceNext(work, NextLot(activated), activated.ActiveLotId, activated.Lineup,
            activated.EventId, now, cancellationToken);

        await work.Commit(cancellationToken);
        return new AuctionApplication(AuctionOutcome.FinalLotNext,
            new Dictionary<string, int> { [AuctionFacts.FinalLotNextType] = created });
    }

    /// <summary>Лот состава, который идёт следом за взятым в работу.</summary>
    private static Guid? NextLot(AuctionFinalLotActivated activated)
    {
        for (var place = 0; place < activated.Lineup.Count; place++)
        {
            if (activated.Lineup[place] != activated.ActiveLotId)
            {
                continue;
            }
            return place + 1 < activated.Lineup.Count ? activated.Lineup[place + 1] : null;
        }
        return null;
    }

    /// <summary>
    /// Сообщает лидеру следующего лота, какой лот идёт сейчас и каким по счёту
    /// стоит его лот. Времени не обещает: длительность лота знает только
    /// ведущий (PER-812). Выключатель анонса финала гасит и эту весть (PER-539).
    /// </summary>
    private async Task<int> AnnounceNext(UnitOfWork work, Guid? nextLotId, Guid? activeLotId,
        IReadOnlyList<Guid> lineup, Guid eventId, DateTimeOffset now, CancellationToken cancellationToken)
    {
        if (nextLotId is not { } lotId)
        {
            return 0;
        }

        var held = await FinalStore.Held(work, [lotId], cancellationToken);
        // Лот, удержанный без ставки, лидера не имеет: сообщать некому.
        if (!held.TryGetValue(lotId, out var lot) || lot.Leader is not { } leader)
        {
            return 0;
        }

        var silenced = await FinalStore.Silenced(work, [leader], cancellationToken);
        if (silenced.Contains(leader))
        {
            return 0;
        }

        var notAfter = now + options.Value.StaleAfter;
        var notification = AuctionFacts.FinalLotNext(Guid.CreateVersion7(now), leader, lotId, activeLotId,
            lineup.ToList().IndexOf(lotId) + 1, lineup.Count, eventId, now, notAfter);
        return await NotificationStore.AddAddressed(work, notification, AuctionFacts.FinalLotNextType,
            AuctionFacts.AuctionCauseKind, eventId.ToString(), now, notAfter, cancellationToken,
            await NotificationStore.DeliverySurface(work, leader, cancellationToken));
    }

    // Круг вестей финала: держатели права ставок и те, кому нужно сообщить о
    // своём лоте, без выключивших анонс финала.
    private static async Task<Guid[]> FinalAudience(UnitOfWork work, IEnumerable<Guid> extra,
        CancellationToken cancellationToken)
    {
        var recipients = (await NotificationStore.PlaceBidsHolders(work, cancellationToken))
            .Union(extra)
            .ToArray();
        var silenced = await FinalStore.Silenced(work, recipients, cancellationToken);
        return recipients.Where(recipient => !silenced.Contains(recipient)).ToArray();
    }

    /// <summary>
    /// Конец онлайн-торгов с финалом впереди (PER-812): весть всем держателям
    /// права ставок — сколько лотов продано и сколько ждёт финала. Удержание
    /// последнего лота может прийти позже этого факта: пока реплика лота реестра
    /// не догнала и срок ожидания не вышел, весть откатывается целиком.
    /// </summary>
    public async Task<AuctionApplication> Apply(AuctionTradingEnded ended, DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        if (await ConsumedEventStore.Consume(work, AuctionFeed.Source, ended.EventId, now, cancellationToken) == 0)
        {
            return new AuctionApplication(AuctionOutcome.Duplicate, new Dictionary<string, int>());
        }

        await AuctionEndStore.LockShared(work, ended.AuctionId, cancellationToken);
        if (await AuctionEndStore.Read(work, ended.AuctionId, cancellationToken) is not null)
        {
            await work.Commit(cancellationToken);
            return new AuctionApplication(AuctionOutcome.AuctionEnded, new Dictionary<string, int>());
        }

        var counts = await LotReplicaStore.StatusCounts(work, ended.Registry, cancellationToken);
        int Count(LotStatus status) => counts.TryGetValue(status, out var count) ? count : 0;
        var settled = Count(LotStatus.Held) + Count(LotStatus.Sold) + Count(LotStatus.Unsold)
            + Count(LotStatus.Withdrawn);
        if (settled < ended.Registry.Count && now - ended.OccurredAt < options.Value.FinalLineupWait)
        {
            return new AuctionApplication(AuctionOutcome.LineupPending, new Dictionary<string, int>());
        }

        // Снимок «перерыв» значит, что удержан хотя бы один лот: если реплика
        // удержания не догнала и срок ожидания вышел, ноль не должен прозвучать
        // как «финала не будет».
        var created = await AnnounceTradingEnd(work, ended, Count(LotStatus.Sold), Math.Max(Count(LotStatus.Held), 1),
            now, cancellationToken);
        await work.Commit(cancellationToken);
        return new AuctionApplication(AuctionOutcome.TradingEnded,
            new Dictionary<string, int> { [AuctionFacts.PrebiddingEndedType] = created });
    }

    private async Task<int> AnnounceTradingEnd(UnitOfWork work, AuctionTradingEnded ended, int sold, int held,
        DateTimeOffset now, CancellationToken cancellationToken)
    {
        var notAfter = now + options.Value.StaleAfter;
        var created = 0;
        foreach (var recipient in await FinalAudience(work, [], cancellationToken))
        {
            created += await NotificationStore.AddAddressed(work,
                AuctionFacts.PrebiddingEnded(Guid.CreateVersion7(now), recipient, ended, sold, held, now, notAfter),
                AuctionFacts.PrebiddingEndedType, AuctionFacts.AuctionCauseKind, ended.EventId.ToString(), now,
                notAfter, cancellationToken,
                await NotificationStore.DeliverySurface(work, recipient, cancellationToken));
        }
        return created;
    }

    /// <summary>
    /// Конец аукциона: круг анонса и удержания лотов больше не нужны, а
    /// избранное его лотов уходит — реплики, отметки, живые и снятые, и
    /// несработавшие задания напоминания (ADR-063, дополнение 2026-10-12).
    /// Прошедший и отменённый аукцион пишут строку «аукцион закончен», которая
    /// не даёт старому факту лота воскресить реплику и отметку; удалённый до
    /// торгов её не пишет — он рождается заново под тем же идентификатором.
    /// Отмена ещё и извещает причастных: по факту на человека, покупателю — со
    /// своими покупками.
    /// </summary>
    public async Task<AuctionApplication> Apply(AuctionClosed closed, DateTimeOffset now, CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        if (await ConsumedEventStore.Consume(work, AuctionFeed.Source, closed.EventId, now, cancellationToken) == 0)
        {
            return new AuctionApplication(AuctionOutcome.Duplicate, new Dictionary<string, int>());
        }

        // Каталог без удержанных лотов: весть «финала не будет» считает проданные
        // по реплике, а факты последних лотов могут прийти позже факта аукциона.
        // Пока реплики реестра не догнали и срок ожидания не вышел, конец
        // откатывается целиком и ждёт в потоке (PER-812).
        if (closed is { End: AuctionEnd.Finished, FromPrebidding: true } && closed.Registry.Count > 0)
        {
            var counts = await LotReplicaStore.StatusCounts(work, closed.Registry, cancellationToken);
            var settled = counts.Where(entry => entry.Key is LotStatus.Held or LotStatus.Sold or LotStatus.Unsold
                or LotStatus.Withdrawn).Sum(entry => entry.Value);
            if (settled < closed.Registry.Count && now - closed.OccurredAt < options.Value.FinalLineupWait)
            {
                return new AuctionApplication(AuctionOutcome.LineupPending, new Dictionary<string, int>());
            }
        }

        // Порядок держит ручную отметку: удаление реплики ждёт отметку в полёте,
        // и только после него причастные читаются вместе с ней. Новая отметка
        // после удаления реплики получает «лот неизвестен».
        await AuctionEndStore.LockExclusive(work, closed.AuctionId, cancellationToken);
        var lots = await AuctionEndStore.TakeLots(work, closed, cancellationToken);
        // Реестр — тоже: отметку по ставке с кривым снимком лот получает и без
        // реплики, и её держатель причастен так же.
        var lotIds = lots.Select(lot => lot.LotId).Union(closed.Registry).ToArray();
        var followers = closed.End == AuctionEnd.Cancelled
            ? await FavoriteStore.Followers(work, lotIds, cancellationToken)
            : [];
        await FavoriteStore.Forget(work, lotIds, cancellationToken);
        await AuctionEndStore.CancelReminders(work, lotIds, cancellationToken);
        // Положение для команды объявления и снятие неотправленных объявлений
        // (PER-780) — под той же исключительной блокировкой: объявление,
        // принятое до конца, здесь уже видно, а принятое после читает конец.
        // Устаревший конец удалённого — запоздавший после нового рождения — не
        // снимает объявлений нового рождения.
        if (await AuctionStandingStore.Apply(work, closed.AuctionId, closed.MeetupId,
                AuctionStandingStore.Of(closed.End), closed.Version, now, cancellationToken)
            && closed.End != AuctionEnd.Finished)
        {
            await NotificationStore.WithdrawAuctionNotices(work, closed.MeetupId,
                closed.End == AuctionEnd.Cancelled
                    ? NotificationFacts.WithdrawnOnAuctionCancelled
                    : NotificationFacts.WithdrawnOnAuctionDiscarded,
                now, cancellationToken);
        }
        // Окна лотов кончились вместе с аукционом: задание начала окна не
        // сработает после его конца, а сработавшее остаётся историей.
        await StepWindowTaskStore.CancelForAuction(work, closed.AuctionId, cancellationToken);
        // Удалённый до торгов круга анонса не имеет: ставок и удержаний у него не
        // было, а круг по тому же auction_id — уже нового рождения, чья ставка
        // могла обогнать запоздавшее удаление.
        if (closed.End != AuctionEnd.Discarded)
        {
            await AuctionEndStore.Mark(work, closed, now, cancellationToken);
            await FinalStore.Forget(work, closed.AuctionId, cancellationToken);
        }

        if (closed.End != AuctionEnd.Cancelled)
        {
            // Каталог без удержанных лотов кончает аукцион тем же prebidding_ended:
            // финала не будет, и об этом тоже узнают все (PER-812).
            if (closed is { End: AuctionEnd.Finished, FromPrebidding: true })
            {
                var sold = lots.Count(lot => lot.Status == LotStatus.Sold);
                var told = await AnnounceTradingEnd(work,
                    new AuctionTradingEnded(closed.EventId, closed.AuctionId, closed.MeetupId, closed.Version,
                        closed.OccurredAt, closed.Registry),
                    sold, 0, now, cancellationToken);
                await work.Commit(cancellationToken);
                return new AuctionApplication(AuctionOutcome.TradingEnded,
                    new Dictionary<string, int> { [AuctionFacts.PrebiddingEndedType] = told });
            }
            await work.Commit(cancellationToken);
            return new AuctionApplication(AuctionOutcome.AuctionForgotten, new Dictionary<string, int>());
        }

        var notAfter = now + options.Value.StaleAfter;
        var created = 0;
        foreach (var (recipient, purchases) in AuctionFacts.CancellationAudience(followers, lots))
        {
            var notification = AuctionFacts.Cancellation(Guid.CreateVersion7(now), recipient, closed.AuctionId,
                closed.MeetupId, closed.EventId, purchases, now, notAfter);
            created += await NotificationStore.AddAddressed(work, notification, AuctionFacts.AuctionCancelledType,
                AuctionFacts.AuctionCauseKind, closed.EventId.ToString(), now, notAfter, cancellationToken,
                await NotificationStore.DeliverySurface(work, recipient, cancellationToken));
        }

        await work.Commit(cancellationToken);
        return new AuctionApplication(AuctionOutcome.AuctionCancelled,
            new Dictionary<string, int> { [AuctionFacts.AuctionCancelledType] = created });
    }

    /// <summary>
    /// Видимость аукциона и открытие торгов (PER-646): публикация и открытие
    /// дают весть держателям права ставок, снятие — снимает неотправленную весть
    /// о публикации, потому что человек пошёл бы к аукциону, которого не видит.
    /// Настройка уведомлений аукциона читается той же транзакцией, что ключ
    /// события. Повтор отсекает ключ события, а после его чистки — уникальность
    /// (тип, повод, получатель).
    /// </summary>
    public async Task<AuctionApplication> Apply(AuctionAnnouncement announcement, DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        if (await ConsumedEventStore.Consume(work, AuctionFeed.Source, announcement.EventId, now, cancellationToken) == 0)
        {
            return new AuctionApplication(AuctionOutcome.Duplicate, new Dictionary<string, int>());
        }

        // Положение аукциона для команды объявления (PER-780). Скрытие берёт
        // исключительную блокировку аукциона до записи: команда объявления
        // читает положение под разделяемой, и объявление в полёте скрытие либо
        // дождётся и снимет, либо команда увидит скрытие и откажет.
        await AuctionEndStore.LockExclusive(work, announcement.AuctionId, cancellationToken);
        var hidden = announcement.Occasion == AnnouncementOccasion.Hidden
            || (announcement.Occasion == AnnouncementOccasion.Drafted && announcement.Hidden);
        var current = await AuctionStandingStore.Apply(work, announcement.AuctionId, announcement.MeetupId,
            hidden ? AuctionStanding.Hidden : AuctionStanding.Visible, announcement.Version, now, cancellationToken);

        // Рождение только записывает положение: вести у него нет, а снимать
        // нечего — у рождённого заново аукциона объявления сняло удаление.
        if (announcement.Occasion == AnnouncementOccasion.Drafted)
        {
            await work.Commit(cancellationToken);
            return new AuctionApplication(AuctionOutcome.StandingRecorded, new Dictionary<string, int>());
        }

        if (announcement.Occasion == AnnouncementOccasion.Hidden)
        {
            var withdrawn = await NotificationStore.WithdrawOnAuctionHidden(work, announcement.MeetupId, now,
                cancellationToken);
            // Устаревшее скрытие — пришедшее после новой публикации — объявлений,
            // принятых по опубликованному аукциону, не снимает.
            if (current)
            {
                await NotificationStore.WithdrawAuctionNotices(work, announcement.MeetupId,
                    NotificationFacts.WithdrawnOnAuctionHidden, now, cancellationToken);
            }
            await work.Commit(cancellationToken);
            return new AuctionApplication(AuctionOutcome.AnnouncementWithdrawn,
                new Dictionary<string, int> { [AuctionFacts.PublishedType] = withdrawn });
        }

        var notAfter = now + options.Value.StaleAfter;
        var created = await NotificationStore.AddAuctionAnnouncement(work, announcement, now, notAfter,
            cancellationToken);
        var type = announcement.Occasion == AnnouncementOccasion.TradingOpened
            ? AuctionFacts.TradingOpenedType
            : AuctionFacts.PublishedType;

        await work.Commit(cancellationToken);
        return new AuctionApplication(AuctionOutcome.Announcement,
            new Dictionary<string, int> { [type] = created.Created });
    }

    /// <summary>
    /// Итог жеребьёвки (PER-620): по факту на каждого владельца билета,
    /// победителю — тот же факт со своим номером. Настройки и категории его не
    /// фильтруют: сообщение одно на розыгрыш. Повтор отсекает ключ события, а
    /// после его чистки — уникальность (тип, повод, получатель).
    /// </summary>
    public async Task<AuctionApplication> Apply(RaffleDraw draw, DateTimeOffset now, CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        if (await ConsumedEventStore.Consume(work, AuctionFeed.Source, draw.EventId, now, cancellationToken) == 0)
        {
            return new AuctionApplication(AuctionOutcome.Duplicate, new Dictionary<string, int>());
        }

        var notAfter = now + options.Value.StaleAfter;
        var created = 0;
        for (var index = 0; index < draw.Tickets.Count; index++)
        {
            var recipient = draw.Tickets[index];
            var notification = AuctionFacts.RaffleResult(Guid.CreateVersion7(now), recipient, index + 1, draw, now,
                notAfter);
            created += await NotificationStore.AddAddressed(work, notification, AuctionFacts.RaffleResultType,
                AuctionFacts.RaffleCauseKind, draw.EventId.ToString(), now, notAfter, cancellationToken,
                await NotificationStore.DeliverySurface(work, recipient, cancellationToken));
        }

        await work.Commit(cancellationToken);
        return new AuctionApplication(AuctionOutcome.RaffleAnnounced,
            new Dictionary<string, int> { [AuctionFacts.RaffleResultType] = created });
    }

    /// <summary>
    /// Собранный сет даёт ровно один адресный факт собравшему. Настройки и
    /// категории его не фильтруют; повтор держат ключ события и ключ причины.
    /// </summary>
    public async Task<AuctionApplication> Apply(CollectedLotSet set, DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        if (await ConsumedEventStore.Consume(work, AuctionFeed.Source, set.EventId, now, cancellationToken) == 0)
        {
            return new AuctionApplication(AuctionOutcome.Duplicate, new Dictionary<string, int>());
        }

        var notAfter = now + options.Value.StaleAfter;
        var notification = AuctionFacts.LotSetCollected(Guid.CreateVersion7(now), set, now, notAfter);
        var created = await NotificationStore.AddAddressed(work, notification, AuctionFacts.LotSetCollectedType,
            AuctionFacts.AuctionCauseKind, set.EventId.ToString(), now, notAfter, cancellationToken,
            await NotificationStore.DeliverySurface(work, set.CollectorId, cancellationToken));

        await work.Commit(cancellationToken);
        return new AuctionApplication(AuctionOutcome.LotSetCollected,
            new Dictionary<string, int> { [AuctionFacts.LotSetCollectedType] = created });
    }

    /// <summary>
    /// Итоги прогнозов (PER-567): по факту на каждого, кто сделал прогноз, —
    /// адресаты берутся из самого факта, и не ответивший ни на одну номинацию
    /// в нём не назван. Ручная отметка подсчитанных итогов не несёт и адресатов
    /// не даёт. Настройки и категории его не фильтруют: сообщение одно на
    /// аукцион. Повтор отсекает ключ события, а после его чистки —
    /// уникальность (тип, повод, получатель).
    /// </summary>
    public async Task<AuctionApplication> Apply(PredictionSettlement settlement, DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        if (await ConsumedEventStore.Consume(work, AuctionFeed.Source, settlement.EventId, now, cancellationToken) == 0)
        {
            return new AuctionApplication(AuctionOutcome.Duplicate, new Dictionary<string, int>());
        }

        var notAfter = now + options.Value.StaleAfter;
        var created = 0;
        foreach (var participant in settlement.Manual ? Array.Empty<PredictionParticipant>() : settlement.Participants)
        {
            var notification = AuctionFacts.PredictionResults(Guid.CreateVersion7(now), participant, settlement, now,
                notAfter);
            created += await NotificationStore.AddAddressed(work, notification, AuctionFacts.PredictionResultsType,
                AuctionFacts.PredictionResultsCauseKind, settlement.EventId.ToString(), now, notAfter, cancellationToken,
                await NotificationStore.DeliverySurface(work, participant.ParticipantId, cancellationToken));
        }

        await work.Commit(cancellationToken);
        return new AuctionApplication(AuctionOutcome.PredictionResultsAnnounced,
            new Dictionary<string, int> { [AuctionFacts.PredictionResultsType] = created });
    }

    /// <summary>
    /// Факт счёта: реплика счёта и ключ события одной транзакцией. Поводов
    /// факт не даёт: из реплики живут задания напоминания о неоплаченном счёте
    /// (PER-330), а адресный факт пишет грин в момент срабатывания задания.
    /// </summary>
    /// <remarks>
    /// Порядок доставки не обещан, и факты счёта идут разными subject'ами:
    /// <c>invoice_paid</c> может прийти раньше <c>invoice_issued</c>. Реплика
    /// держит версию и не откатывается поздним фактом, поэтому задания,
    /// заведённые после оплаты, не воскресают.
    /// </remarks>
    public async Task<AuctionApplication> Apply(AuctionInvoice invoice, DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        if (await ConsumedEventStore.Consume(work, AuctionFeed.Source, invoice.EventId, now, cancellationToken) == 0)
        {
            return new AuctionApplication(AuctionOutcome.Duplicate, new Dictionary<string, int>());
        }

        // Поздний факт счёта не откатывает реплику: версия растёт, и снимок
        // оплаченного счёта переживает позднее выставление. Такой факт
        // рапортуется отдельно — снимок не записан.
        var recorded = await InvoiceReplicaStore.Apply(work, invoice.Snapshot, now, cancellationToken);

        await work.Commit(cancellationToken);
        return new AuctionApplication(
            recorded ? AuctionOutcome.InvoiceReplicated : AuctionOutcome.InvoiceStale,
            new Dictionary<string, int>());
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
