using Dapper;
using Notifications.Auction;
using Notifications.Facts;
using Notifications.Favorites;
using Notifications.Infrastructure;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.TestKit;
using Notifications.V1;
using Npgsql;
using Shouldly;
using Xunit;
using static Notifications.IntegrationTests.Infrastructure.FactFixtures;
using static Notifications.IntegrationTests.Infrastructure.AuctionFixtures;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Избранное до конца аукциона и извещение об отмене (PER-604, ADR-063,
/// дополнение 2026-10-12; ADR-047, «Факт отмены»): чистка по концу, строка
/// «аукцион закончен» против старых фактов, адресаты отмены и порядок с
/// ставкой в полёте — на настоящей базе; путь из шины — на настоящих
/// транспорте и composition root.
/// </summary>
public class AuctionEndTests
{
    private static readonly DateTimeOffset Now = EventFactory.Committed.AddHours(1);

    /// <summary>
    /// Приёмка: после <c>prebidding_ended</c> со снимком <c>finished</c> список
    /// пуст, задание напоминания снято, а повтор старого <c>bid_placed</c>,
    /// ключ которого уже вычищен, ни отметку, ни реплику не возвращает. Лот
    /// другого аукциона живёт.
    /// </summary>
    [Fact]
    public async Task When_AuctionFinished_Expect_FavoritesGoneAndOldBidDoesNotReturnThem()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var favorites = Favorites(source);
        var (auction, other) = (EventFactory.AuctionOfMeetup(), EventFactory.AuctionOfMeetup());
        var (lot, kept) = (EventFactory.NewId(), EventFactory.NewId());
        var person = EventFactory.NewId();
        var bid = EventFactory.Bid(lot, leader: person, auction: auction);
        await store.Apply(Decode(bid), Now, Cancellation);
        await store.Apply(Decode(EventFactory.Bid(kept, leader: person, auction: other)), Now, Cancellation);
        await ScheduleReminder(db, lot);

        await store.Apply(Closed(EventFactory.PrebiddingFinished(auction, EventFactory.NewId(), lot)), Now, Cancellation);

        (await favorites.List(Guid.Parse(person), Cancellation)).ShouldBe([Guid.Parse(kept)]);
        (await Scalar<string>(db, "SELECT state FROM lot_reminder_task WHERE lot_id = @Lot;", lot)).ShouldBe("cancelled");
        (await Count(db, "auction_ended")).ShouldBe(1);

        await PruneEventKeys(db, DateTimeOffset.UtcNow.AddDays(1));
        await store.Apply(Decode(bid), Now, Cancellation);

        (await favorites.List(Guid.Parse(person), Cancellation)).ShouldBe([Guid.Parse(kept)]);
        (await Count(db, "lot_replica")).ShouldBe(1);
    }

    /// <summary>Приёмка: пока аукцион идёт, проданный лот остаётся в списке с итогом.</summary>
    [Fact]
    public async Task When_LotSoldWhileAuctionRuns_Expect_LotStaysInList()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var auction = EventFactory.AuctionOfMeetup();
        var (lot, buyer) = (EventFactory.NewId(), EventFactory.NewId());
        await store.Apply(Decode(EventFactory.Bid(lot, leader: buyer, auction: auction)), Now, Cancellation);

        await store.Apply(DecodeSale(InAuction(EventFactory.Sold(lot, buyer), auction)), Now, Cancellation);

        (await Favorites(source).List(Guid.Parse(buyer), Cancellation)).ShouldBe([Guid.Parse(lot)]);
        var replica = await Scalar<string>(db, "SELECT status FROM lot_replica WHERE lot_id = @Lot;", lot);
        replica.ShouldBe("sold");
    }

    /// <summary>
    /// Приёмка: отмена даёт одному человеку один факт, хотя он вёл три лота;
    /// снявший отметку тоже причастен, а покупатель получает свою покупку с
    /// ценой. Реплики, отметки и задания уходят, строка «закончен» пишется.
    /// </summary>
    [Fact]
    public async Task When_AuctionCancelled_Expect_OneFactPerPersonAndBuyerGetsPurchase()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var favorites = Favorites(source);
        var (auction, meetup) = (EventFactory.AuctionOfMeetup(), EventFactory.NewId());
        var lots = new[] { EventFactory.NewId(), EventFactory.NewId(), EventFactory.NewId() };
        var (bidder, quitter, buyer) = (EventFactory.NewId(), EventFactory.NewId(), EventFactory.NewId());
        foreach (var lot in lots)
        {
            await store.Apply(Decode(EventFactory.Bid(lot, leader: bidder, auction: auction)), Now, Cancellation);
        }
        await favorites.Follow(Guid.Parse(quitter), Guid.Parse(lots[0]), Cancellation);
        await favorites.Unfollow(Guid.Parse(quitter), Guid.Parse(lots[0]), Cancellation);
        var sold = InAuction(EventFactory.Sold(lots[2], buyer, version: 9), auction);
        await store.Apply(DecodeSale(sold), Now, Cancellation);
        var cancellation = EventFactory.AuctionCancelled(auction, meetup, lots);

        var applied = await store.Apply(Closed(cancellation), Now, Cancellation);

        applied.Outcome.ShouldBe(AuctionOutcome.AuctionCancelled);
        applied.FactsCreated.ShouldBe(3);
        var facts = (await StoredFacts(db))
            .Where(fact => fact.TypeCase == Notification.TypeOneofCase.AuctionCancelled)
            .ToDictionary(fact => fact.RecipientId);
        facts.Keys.ShouldBe([bidder, quitter, buyer], ignoreOrder: true);
        facts.Values.ShouldAllBe(fact => fact.Cause.AuctionEventId == cancellation.EventId);
        facts.Values.ShouldAllBe(fact => fact.AuctionCancelled.AuctionId == auction && fact.AuctionCancelled.MeetupId == meetup);
        facts[bidder].AuctionCancelled.Purchases.ShouldBeEmpty();
        facts[quitter].AuctionCancelled.Purchases.ShouldBeEmpty();
        var purchase = facts[buyer].AuctionCancelled.Purchases.ShouldHaveSingleItem();
        purchase.LotId.ShouldBe(lots[2]);
        purchase.Price.ShouldBe(sold.State.Sold.Price);

        (await Count(db, "lot_replica")).ShouldBe(0);
        (await Count(db, "lot_favorite")).ShouldBe(0);
        (await Scalar<string>(db, "SELECT outcome FROM auction_ended;", null)).ShouldBe("cancelled");
    }

    /// <summary>
    /// Поздний <c>bid_placed</c> отменённого аукциона отметки не создаёт, а
    /// лидера извещает тем же поводом — один раз: уже извещённый второго
    /// факта не получает, как и повтор той же поздней ставки.
    /// </summary>
    [Fact]
    public async Task When_LateBidAfterCancel_Expect_LeaderNotifiedOnceAndNoMark()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var auction = EventFactory.AuctionOfMeetup();
        var (lot, notified, late) = (EventFactory.NewId(), EventFactory.NewId(), EventFactory.NewId());
        await store.Apply(Decode(EventFactory.Bid(lot, leader: notified, auction: auction)), Now, Cancellation);
        var cancellation = EventFactory.AuctionCancelled(auction, EventFactory.NewId(), lot);
        await store.Apply(Closed(cancellation), Now, Cancellation);

        var lateBid = EventFactory.Bid(lot, notified, late, version: 5, auction: auction);
        var applied = await store.Apply(Decode(lateBid), Now, Cancellation);
        await store.Apply(Decode(EventFactory.Bid(lot, late, notified, version: 7, auction: auction)), Now, Cancellation);
        await PruneEventKeys(db, DateTimeOffset.UtcNow.AddDays(1));
        await store.Apply(Decode(lateBid), Now, Cancellation);

        applied.Created[AuctionFacts.AuctionCancelledType].ShouldBe(1);
        var facts = (await StoredFacts(db))
            .Where(fact => fact.TypeCase == Notification.TypeOneofCase.AuctionCancelled)
            .ToArray();
        facts.Select(fact => fact.RecipientId).ShouldBe([notified, late], ignoreOrder: true);
        facts.ShouldAllBe(fact => fact.Cause.AuctionEventId == cancellation.EventId);
        (await Count(db, "lot_favorite")).ShouldBe(0);
        (await Count(db, "lot_replica")).ShouldBe(0);
    }

    /// <summary>
    /// Удалённый до торгов аукцион чистит избранное лотов своего реестра, но
    /// строки «закончен» не пишет: лот нового рождения под тем же
    /// <c>auction_id</c> получает реплику и отметку как обычно.
    /// </summary>
    [Fact]
    public async Task When_AuctionDiscarded_Expect_RegistryCleanedAndNewBirthLotReplicated()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var favorites = Favorites(source);
        var auction = EventFactory.AuctionOfMeetup();
        var (old, reborn) = (EventFactory.NewId(), EventFactory.NewId());
        var person = Guid.CreateVersion7();
        await store.Apply(LotFact("lot_drafted", InAuction(EventFactory.Drafted(old), auction)), Now, Cancellation);
        await favorites.Follow(person, Guid.Parse(old), Cancellation);

        var applied = await store.Apply(Closed(EventFactory.AuctionDiscarded(auction, EventFactory.NewId(), old)), Now,
            Cancellation);
        await store.Apply(Decode(EventFactory.Bid(reborn, leader: person.ToString(), auction: auction)), Now, Cancellation);

        applied.Outcome.ShouldBe(AuctionOutcome.AuctionForgotten);
        (await Count(db, "auction_ended")).ShouldBe(0);
        (await favorites.List(person, Cancellation)).ShouldBe([Guid.Parse(reborn)]);
        (await Count(db, "lot_replica")).ShouldBe(1);
    }

    /// <summary>Строка «аукцион закончен» уходит той же чисткой по сроку, что реплика.</summary>
    [Fact]
    public async Task When_EndRowOlderThanRetention_Expect_PrunedAndFreshKept()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var (old, fresh) = (EventFactory.AuctionOfMeetup(), EventFactory.AuctionOfMeetup());
        await store.Apply(Closed(EventFactory.PrebiddingFinished(old, EventFactory.NewId())), Now, Cancellation);
        await store.Apply(Closed(EventFactory.PrebiddingFinished(fresh, EventFactory.NewId())), Now, Cancellation);
        await Execute(db, """
            UPDATE auction_ended
            SET recorded_at = CASE WHEN auction_id = @Old THEN now() - interval '31 days' ELSE now() END;
            """, new { Old = Guid.Parse(old) });

        await Favorites(source).Prune(DateTimeOffset.UtcNow - TimeSpan.FromDays(30), Cancellation);

        (await Scalar<Guid>(db, "SELECT auction_id FROM auction_ended;", null)).ShouldBe(Guid.Parse(fresh));
    }

    /// <summary>
    /// Ставка в полёте: её транзакция держит разделяемую блокировку аукциона и
    /// уже поставила отметку, а отмена ждёт её коммита — и после него видит
    /// отметку, удаляет её и извещает лидера.
    /// </summary>
    [Fact]
    public async Task When_BidInFlightDuringCancel_Expect_CancelWaitsAndCleansAndNotifies()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var auction = EventFactory.AuctionOfMeetup();
        var lot = EventFactory.NewId();
        await store.Apply(Decode(EventFactory.Bid(lot, leader: EventFactory.NewId(), auction: auction)), Now, Cancellation);
        var inFlight = Guid.CreateVersion7();

        await using var connection = new NpgsqlConnection(db.ConnectionString);
        await connection.OpenAsync(Cancellation);
        await using var transaction = await connection.BeginTransactionAsync(Cancellation);
        await connection.ExecuteAsync(new CommandDefinition(
            """
            SELECT pg_advisory_xact_lock_shared(hashtextextended('auction:' || CAST(@Auction AS text), 0));
            INSERT INTO lot_favorite (identity_id, lot_id, followed_at) VALUES (@Person, @Lot, now());
            """,
            new { Auction = Guid.Parse(auction), Person = inFlight, Lot = Guid.Parse(lot) }, transaction,
            cancellationToken: Cancellation));

        var cancel = store.Apply(Closed(EventFactory.AuctionCancelled(auction, EventFactory.NewId(), lot)), Now,
            Cancellation);
        await Eventually(() => Scalar<long>(db,
            "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted;", null), count => count == 1);
        cancel.IsCompleted.ShouldBeFalse();
        await transaction.CommitAsync(Cancellation);
        await cancel;

        (await Count(db, "lot_favorite")).ShouldBe(0);
        (await StoredFacts(db)).ShouldContain(fact =>
            fact.TypeCase == Notification.TypeOneofCase.AuctionCancelled && fact.RecipientId == inFlight.ToString());
    }

    /// <summary>Путь из шины: отмена доходит до факта на subject круга получателя и чистит избранное.</summary>
    [Fact]
    public async Task When_CancelArrivesOnBus_Expect_FactAndFavoritesRemoved()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var auction = EventFactory.AuctionOfMeetup();
        var (lot, leader) = (EventFactory.NewId(), EventFactory.NewId());

        await nats.Publish(AuctionFeed.BidPlacedSubject, EventFactory.Bid(lot, leader: leader, auction: auction));
        await Eventually(() => Count(db, "lot_favorite"), count => count == 1);
        await nats.Publish("events.auction.auction_cancelled",
            EventFactory.AuctionCancelled(auction, EventFactory.NewId(), lot));

        var published = await Eventually(nats.PublishedFacts, facts => facts.Count == 1);
        published[0].Fact.TypeCase.ShouldBe(Notification.TypeOneofCase.AuctionCancelled);
        published[0].Fact.RecipientId.ShouldBe(leader);
        (await Count(db, "lot_favorite")).ShouldBe(0);
        silo.Service<AuctionTelemetry>().Total("auction_cancelled").ShouldBe(1);
    }

    private static FavoriteOperations Favorites(NpgsqlDataSource source) => new(source, TimeProvider.System, new FactTelemetry());

    private static AuctionClosed Closed(global::Auction.V1.AuctionEvent message)
    {
        var subject = message.OccasionCase switch
        {
            global::Auction.V1.AuctionEvent.OccasionOneofCase.PrebiddingEnded => "events.auction.prebidding_ended",
            global::Auction.V1.AuctionEvent.OccasionOneofCase.AuctionCancelled => "events.auction.auction_cancelled",
            global::Auction.V1.AuctionEvent.OccasionOneofCase.AuctionDiscarded => "events.auction.auction_discarded",
            _ => throw new ArgumentOutOfRangeException(nameof(message)),
        };
        return AuctionMapping.Decode(subject, EventFactory.Bytes(message)).ShouldBeOfType<AuctionDecoded.Closed>().Value;
    }

    private static AuctionLotFact LotFact(string occasion, global::Auction.V1.LotEvent message) =>
        AuctionMapping.Decode($"events.auction.{occasion}", EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Lot>().Value;

    private static global::Auction.V1.LotEvent InAuction(global::Auction.V1.LotEvent message, string auction)
    {
        message.State.AuctionId = auction;
        return message;
    }

    /// <summary>Живое задание напоминания лота, как его завёл бы грин.</summary>
    private static Task ScheduleReminder(IsolatedDatabase db, string lot) => Execute(db, """
        INSERT INTO lot_reminder_task (task_id, lot_id, deadline, due_at, state, created_at)
        VALUES (@Task, @Lot, now() + interval '2 hours', now() + interval '1 hour', 'scheduled', now());
        """, new { Task = Guid.NewGuid(), Lot = Guid.Parse(lot) });

    private static async Task<T> Scalar<T>(IsolatedDatabase db, string sql, string? lot)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        return await connection.QuerySingleAsync<T>(new CommandDefinition(sql,
            lot is null ? null : new { Lot = Guid.Parse(lot) }, cancellationToken: Cancellation));
    }
}
