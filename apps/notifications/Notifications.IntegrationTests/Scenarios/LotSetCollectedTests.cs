using Notifications.Auction;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.TestKit;
using Notifications.V1;
using Npgsql;
using Shouldly;
using Xunit;
using static Notifications.IntegrationTests.Infrastructure.AuctionFixtures;
using static Notifications.IntegrationTests.Infrastructure.FactFixtures;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>Собранный сет проходит через JetStream, PostgreSQL и outbox (PER-687).</summary>
public class LotSetCollectedTests
{
    [Fact]
    public async Task When_LotSetCollected_Expect_OneFactToCollectorAndNoneOnRedelivery()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        var collector = EventFactory.NewId();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var lots = new[] { EventFactory.NewId(), EventFactory.NewId(), EventFactory.NewId() };
        var message = EventFactory.LotSetCollected(EventFactory.AuctionOfMeetup(), EventFactory.NewId(),
            collector, "Сервиз", lots);

        await nats.Publish(AuctionFeed.LotSetCollectedSubject, message);
        var published = await Eventually(nats.PublishedFacts, facts => facts.Count == 1);

        var fact = published.Single().Fact;
        fact.TypeCase.ShouldBe(Notification.TypeOneofCase.LotSetCollected);
        fact.RecipientId.ShouldBe(collector);
        fact.Cause.AuctionEventId.ShouldBe(message.EventId);
        fact.LotSetCollected.SetName.ShouldBe("Сервиз");
        fact.LotSetCollected.LotCount.ShouldBe(3u);
        fact.LotSetCollected.LotId.ShouldBe(lots[0]);

        await nats.Publish(AuctionFeed.LotSetCollectedSubject, message, messageId: Guid.NewGuid().ToString());
        await Eventually(() => Task.FromResult(silo.Service<AuctionTelemetry>().Total("duplicate")), count => count == 1);
        (await Count(db, "notification")).ShouldBe(1);
        (await nats.PublishedFacts()).Count.ShouldBe(1);
        silo.Service<AuctionTelemetry>().Total("lot_set_collected").ShouldBe(1);
    }

    [Theory]
    [InlineData("member", "events.notifications.notification_created.hub")]
    [InlineData("guest", "events.notifications.notification_created.auction")]
    public async Task When_CollectorHasCircle_Expect_FactOnCircleSubject(string circle, string subject)
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        var collector = (await Person(db, circle == "member" ? MemberHolding : GuestHolding)).ToString();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);

        await nats.Publish(AuctionFeed.LotSetCollectedSubject,
            EventFactory.LotSetCollected(EventFactory.AuctionOfMeetup(), EventFactory.NewId(), collector,
                "Сервиз", EventFactory.NewId(), EventFactory.NewId()));

        var published = await Eventually(nats.PublishedFacts, facts => facts.Count == 1);
        published.Single().Subject.ShouldBe(subject);
        published.Single().Fact.RecipientId.ShouldBe(collector);
    }

    [Fact]
    public async Task When_ConsumedEventKeyIsPruned_Expect_CauseKeyStillPreventsSecondFact()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var collector = EventFactory.NewId();
        var set = AuctionMapping.Decode(AuctionFeed.LotSetCollectedSubject, EventFactory.Bytes(
                EventFactory.LotSetCollected(EventFactory.AuctionOfMeetup(), EventFactory.NewId(), collector,
                    "Сервиз", EventFactory.NewId(), EventFactory.NewId())))
            .ShouldBeOfType<AuctionDecoded.LotSet>().Value;

        (await store.Apply(set, EventFactory.Committed, Cancellation)).FactsCreated.ShouldBe(1);
        await PruneEventKeys(db, EventFactory.Committed.AddDays(9));
        (await store.Apply(set, EventFactory.Committed.AddDays(10), Cancellation)).FactsCreated.ShouldBe(0);
        (await Count(db, "notification")).ShouldBe(1);
    }
}
