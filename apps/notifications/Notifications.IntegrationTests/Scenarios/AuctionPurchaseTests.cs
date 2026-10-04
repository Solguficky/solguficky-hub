using Notifications.Auction;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.TestKit;
using Notifications.V1;
using Npgsql;
using Shouldly;
using Xunit;
using static Notifications.IntegrationTests.Infrastructure.FactFixtures;
using static Notifications.IntegrationTests.Infrastructure.AuctionFixtures;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>Продажа лота через настоящие JetStream, PostgreSQL и composition root.</summary>
public class AuctionPurchaseTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task When_LotSold_Expect_OneAddressedFactToWinner(bool config)
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var winner = EventFactory.NewId();
        var message = EventFactory.Sold(EventFactory.NewId(), winner, config: config);
        await nats.Publish(AuctionFeed.LotSoldSubject, message);
        var published = await Eventually(nats.PublishedFacts, facts => facts.Count == 1);
        var (fact, messageId) = published.Single();
        fact.TypeCase.ShouldBe(Notification.TypeOneofCase.LotPurchased);
        fact.RecipientId.ShouldBe(winner);
        fact.Cause.AuctionLotEventId.ShouldBe(message.EventId);
        fact.LotPurchased.LotId.ShouldBe(message.LotId);
        fact.LotPurchased.Price.ShouldBe(message.State.Sold.Price);
        messageId.ShouldBe(fact.NotificationId);
        (DateTimeOffset.Parse(fact.NotAfter) - DateTimeOffset.Parse(fact.CreatedAt)).ShouldBe(TimeSpan.FromHours(24));
        (await Count(db, "notification")).ShouldBe(1);
        (await StoredFact(db)).ShouldBe(fact);
        silo.Service<AuctionTelemetry>().Total("purchased").ShouldBe(1);
    }

    [Fact]
    public async Task When_LotUnsoldOrHeldForFinal_Expect_NoFactButEventsAcknowledged()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        await nats.Publish("events.auction.lot_unsold", EventFactory.Unsold(EventFactory.NewId()));
        await nats.Publish("events.auction.lot_held_for_final", EventFactory.HeldForFinal(EventFactory.NewId()));
        await Eventually(() => Task.FromResult(silo.Service<AuctionTelemetry>().Total("ignored")), count => count == 2);
        await Eventually(() => nats.Unacknowledged(AuctionFeed.Feed), pending => pending == 0);
        (await Count(db, "notification")).ShouldBe(0);
        (await Count(db, "consumed_event")).ShouldBe(0);
        (await nats.PublishedFacts()).ShouldBeEmpty();
    }

    [Fact]
    public async Task When_SaleRedeliveredWithNewTransportId_Expect_NoSecondFact()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var message = EventFactory.Sold(EventFactory.NewId());
        await nats.Publish(AuctionFeed.LotSoldSubject, message);
        await Eventually(nats.PublishedFacts, facts => facts.Count == 1);
        await nats.Publish(AuctionFeed.LotSoldSubject, message, messageId: Guid.NewGuid().ToString());
        await Eventually(() => Task.FromResult(silo.Service<AuctionTelemetry>().Total("duplicate")), count => count == 1);
        (await Count(db, "notification")).ShouldBe(1);
        (await Count(db, "consumed_event")).ShouldBe(1);
        (await nats.PublishedFacts()).Count.ShouldBe(1);
    }

    [Fact]
    public async Task When_ServiceRestartsAndSaleRepublished_Expect_NoSecondFact()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        var message = EventFactory.Sold(EventFactory.NewId());
        await using (var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url))
        {
            await nats.Publish(AuctionFeed.LotSoldSubject, message);
            await Eventually(nats.PublishedFacts, facts => facts.Count == 1);
        }
        await using var restarted = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        await nats.Publish(AuctionFeed.LotSoldSubject, message, messageId: Guid.NewGuid().ToString());
        await Eventually(() => Task.FromResult(restarted.Service<AuctionTelemetry>().Total("duplicate")), count => count == 1);
        (await Count(db, "notification")).ShouldBe(1);
        (await nats.PublishedFacts()).Count.ShouldBe(1);
    }

    [Fact]
    public async Task When_SaleKeyPruned_Expect_PersistentCauseKeyStillPreventsSecondFact()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var sale = DecodeSale(EventFactory.Sold(EventFactory.NewId()));
        (await store.Apply(sale, EventFactory.Committed, Cancellation)).FactsCreated.ShouldBe(1);
        await PruneEventKeys(db, EventFactory.Committed.AddDays(9));
        (await store.Apply(sale, EventFactory.Committed.AddDays(10), Cancellation)).FactsCreated.ShouldBe(0);
        (await Count(db, "notification")).ShouldBe(1);
    }
}
