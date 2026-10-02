using Notifications.Auction;
using Notifications.Facts;
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

/// <summary>Контрактные события через настоящие JetStream, PostgreSQL и composition root.</summary>
public class AuctionOutbidTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task When_ManualOrFoldedProxyOutbids_Expect_OneAddressedFactWithoutReplicaOrSubscription(bool proxy)
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var previous = EventFactory.NewId();
        var message = EventFactory.Bid(EventFactory.NewId(), previous, proxy: proxy);
        await nats.Publish(AuctionFeed.BidPlacedSubject, message);
        var published = await Eventually(nats.PublishedFacts, facts => facts.Count == 1);
        var (fact, messageId) = published.Single();
        fact.TypeCase.ShouldBe(Notification.TypeOneofCase.LotOutbid);
        fact.RecipientId.ShouldBe(previous);
        fact.Cause.AuctionLotEventId.ShouldBe(message.EventId);
        fact.LotOutbid.LotId.ShouldBe(message.LotId);
        fact.LotOutbid.CurrentPrice.ShouldBe(message.State.Trading.CurrentPrice);
        messageId.ShouldBe(fact.NotificationId);
        (DateTimeOffset.Parse(fact.NotAfter) - DateTimeOffset.Parse(fact.CreatedAt)).ShouldBe(TimeSpan.FromHours(24));
        (await Count(db, "notification")).ShouldBe(1);
        (await Count(db, "identity_replica")).ShouldBe(0);
        (await Count(db, "meetup_subscription")).ShouldBe(0);
        (await StoredFact(db)).ShouldBe(fact);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task When_FirstBidOrLeaderRetainsLead_Expect_NoFactButEventAcknowledged(bool self)
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var leader = EventFactory.NewId();
        await nats.Publish(AuctionFeed.BidPlacedSubject, EventFactory.Bid(EventFactory.NewId(), self ? leader : null, leader, proxy: self));
        await Eventually(() => Count(db, "consumed_event"), count => count == 1);
        await Eventually(() => nats.Unacknowledged(AuctionFeed.Feed), pending => pending == 0);
        (await Count(db, "notification")).ShouldBe(0);
        (await nats.PublishedFacts()).ShouldBeEmpty();
    }

    [Fact]
    public async Task When_EventRedeliveredWithNewTransportId_Expect_NoSecondFact()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var message = EventFactory.Bid(EventFactory.NewId(), EventFactory.NewId());
        await nats.Publish(AuctionFeed.BidPlacedSubject, message);
        await Eventually(nats.PublishedFacts, facts => facts.Count == 1);
        await nats.Publish(AuctionFeed.BidPlacedSubject, message, messageId: Guid.NewGuid().ToString());
        await Eventually(() => Task.FromResult(silo.Service<AuctionTelemetry>().Total("duplicate")), count => count == 1);
        (await Count(db, "notification")).ShouldBe(1);
        (await Count(db, "consumed_event")).ShouldBe(1);
        (await nats.PublishedFacts()).Count.ShouldBe(1);
    }

    [Fact]
    public async Task When_OlderDistinctEventArrivesAfterNewer_Expect_BothCausesPreserved()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var lot = EventFactory.NewId();
        var newer = EventFactory.Bid(lot, EventFactory.NewId(), version: 10);
        var older = EventFactory.Bid(lot, EventFactory.NewId(), version: 3);
        await nats.Publish(AuctionFeed.BidPlacedSubject, newer);
        await Eventually(nats.PublishedFacts, facts => facts.Count == 1);
        await nats.Publish(AuctionFeed.BidPlacedSubject, older);
        var published = await Eventually(nats.PublishedFacts, facts => facts.Count == 2);
        published.Select(item => item.Fact.Cause.AuctionLotEventId).ShouldBe([newer.EventId, older.EventId], ignoreOrder: true);
    }

    [Fact]
    public async Task When_PoisonAndUnrelatedAuctionFactPrecedeBid_Expect_FlowContinues()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var broken = EventFactory.Bid(EventFactory.NewId(), "");
        await nats.Publish(AuctionFeed.BidPlacedSubject, broken);
        await nats.Publish("events.auction.auction_scheduled", new global::Auction.V1.AuctionEvent());
        await nats.Publish(AuctionFeed.BidPlacedSubject, EventFactory.Bid(EventFactory.NewId(), EventFactory.NewId()));
        await Eventually(nats.PublishedFacts, facts => facts.Count == 1);
        await Eventually(() => nats.Unacknowledged(AuctionFeed.Feed), pending => pending == 0);
        silo.Service<AuctionTelemetry>().Total("poison").ShouldBe(1);
        silo.Service<AuctionTelemetry>().Total("ignored").ShouldBe(1);
        (await Count(db, "notification")).ShouldBe(1);
    }

    [Fact]
    public async Task When_ConcurrentDuplicateApplied_Expect_OneKeyAndOneFact()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var bid = Decode(EventFactory.Bid(EventFactory.NewId(), EventFactory.NewId()));
        var outcomes = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => store.Apply(bid, EventFactory.Committed, Cancellation)));
        outcomes.Sum(outcome => outcome.FactsCreated).ShouldBe(1);
        outcomes.Count(outcome => outcome.Outcome == AuctionOutcome.Duplicate).ShouldBe(7);
        (await Count(db, "consumed_event")).ShouldBe(1);
        (await Count(db, "notification")).ShouldBe(1);
    }

    [Fact]
    public async Task When_OutboxInsertFails_Expect_KeyRolledBackAndRetryCreatesFact()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var bid = Decode(EventFactory.Bid(EventFactory.NewId(), EventFactory.NewId()));
        await RejectOutbox(db);
        await Should.ThrowAsync<PostgresException>(() => store.Apply(bid, EventFactory.Committed, Cancellation));
        (await Count(db, "consumed_event")).ShouldBe(0);
        (await Count(db, "notification")).ShouldBe(0);
        await RestoreOutbox(db);
        (await store.Apply(bid, EventFactory.Committed, Cancellation)).FactsCreated.ShouldBe(1);
    }

    [Fact]
    public async Task When_EventKeyPruned_Expect_PersistentCauseKeyStillPreventsSecondFact()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var bid = Decode(EventFactory.Bid(EventFactory.NewId(), EventFactory.NewId()));
        (await store.Apply(bid, EventFactory.Committed, Cancellation)).FactsCreated.ShouldBe(1);
        await PruneEventKeys(db, EventFactory.Committed.AddDays(9));
        (await store.Apply(bid, EventFactory.Committed.AddDays(10), Cancellation)).FactsCreated.ShouldBe(0);
        (await Count(db, "notification")).ShouldBe(1);
    }

    [Fact]
    public async Task When_ServiceRestartsAndCauseRepublished_Expect_NoSecondFact()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        var message = EventFactory.Bid(EventFactory.NewId(), EventFactory.NewId());
        await using (var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url))
        {
            await nats.Publish(AuctionFeed.BidPlacedSubject, message);
            await Eventually(nats.PublishedFacts, facts => facts.Count == 1);
        }
        await using var restarted = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        await nats.Publish(AuctionFeed.BidPlacedSubject, message, messageId: Guid.NewGuid().ToString());
        await Eventually(() => Task.FromResult(restarted.Service<AuctionTelemetry>().Total("duplicate")), count => count == 1);
        (await Count(db, "notification")).ShouldBe(1);
        (await nats.PublishedFacts()).Count.ShouldBe(1);
    }

}
