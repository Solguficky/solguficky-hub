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

/// <summary>Итог жеребьёвки розыгрыша через настоящие JetStream, PostgreSQL и composition root (PER-620).</summary>
public class RaffleResultTests
{
    [Fact]
    public async Task When_RaffleDrawn_Expect_OneFactPerTicketHolderAndNoneOnRedelivery()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var auction = EventFactory.AuctionOfMeetup();
        var holders = new[] { EventFactory.NewId(), EventFactory.NewId(), EventFactory.NewId() };
        var message = EventFactory.RaffleDrawn(auction, 2, holders);

        await nats.Publish(AuctionFeed.RaffleDrawnSubject, message);
        var published = await Eventually(nats.PublishedFacts, facts => facts.Count == 3);

        var facts = published.Select(item => item.Fact).ToArray();
        facts.ShouldAllBe(fact => fact.TypeCase == Notification.TypeOneofCase.RaffleResult);
        facts.ShouldAllBe(fact => fact.Cause.AuctionRaffleEventId == message.EventId);
        facts.ShouldAllBe(fact => fact.RaffleResult.AuctionId == auction);
        facts.ShouldAllBe(fact => fact.RaffleResult.WinningTicket == 2 && fact.RaffleResult.TicketCount == 3);
        facts.Select(fact => fact.RecipientId).OrderBy(id => id).ShouldBe(holders.OrderBy(id => id));
        foreach (var fact in facts)
        {
            fact.RaffleResult.Ticket.ShouldBe((uint)Array.IndexOf(holders, fact.RecipientId) + 1);
        }
        facts.Count(fact => fact.RaffleResult.Ticket == fact.RaffleResult.WinningTicket).ShouldBe(1);

        await nats.Publish(AuctionFeed.RaffleDrawnSubject, message, messageId: Guid.NewGuid().ToString());
        await Eventually(() => Task.FromResult(silo.Service<AuctionTelemetry>().Total("duplicate")), count => count == 1);
        (await Count(db, "notification")).ShouldBe(3);
        (await nats.PublishedFacts()).Count.ShouldBe(3);
        silo.Service<AuctionTelemetry>().Total("raffle_announced").ShouldBe(1);
    }

    [Theory]
    [InlineData("member", "events.notifications.notification_created.hub")]
    [InlineData("guest", "events.notifications.notification_created.auction")]
    public async Task When_HolderHasCircle_Expect_ResultOnCircleSubject(string circle, string subject)
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        var holder = (await Person(db, circle == "member" ? MemberHolding : GuestHolding)).ToString();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);

        await nats.Publish(AuctionFeed.RaffleDrawnSubject,
            EventFactory.RaffleDrawn(EventFactory.AuctionOfMeetup(), 1, holder));

        var published = await Eventually(nats.PublishedFacts, facts => facts.Count == 1);
        published.Single().Subject.ShouldBe(subject);
    }

    /// <summary>
    /// Пустой пул жеребьёвки не даёт, и Auction такого факта не публикует; пришедший
    /// всё же — яд, а не сообщение: никому не пишется и в поток не возвращается.
    /// </summary>
    [Fact]
    public async Task When_DrawWithoutTickets_Expect_NoFact()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);

        await nats.Publish(AuctionFeed.RaffleDrawnSubject, EventFactory.RaffleDrawn(EventFactory.AuctionOfMeetup(), 1));

        await Eventually(() => nats.Unacknowledged(AuctionFeed.Feed), pending => pending == 0);
        (await Count(db, "notification")).ShouldBe(0);
        (await Count(db, "consumed_event")).ShouldBe(0);
        (await nats.PublishedFacts()).ShouldBeEmpty();
    }

    [Fact]
    public async Task When_DrawKeyPruned_Expect_PersistentCauseKeyStillPreventsSecondFact()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var draw = AuctionMapping.Decode(AuctionFeed.RaffleDrawnSubject, EventFactory.Bytes(
                EventFactory.RaffleDrawn(EventFactory.AuctionOfMeetup(), 1, EventFactory.NewId(), EventFactory.NewId())))
            .ShouldBeOfType<AuctionDecoded.Raffle>().Value;
        (await store.Apply(draw, EventFactory.Committed, Cancellation)).FactsCreated.ShouldBe(2);
        await PruneEventKeys(db, EventFactory.Committed.AddDays(9));
        (await store.Apply(draw, EventFactory.Committed.AddDays(10), Cancellation)).FactsCreated.ShouldBe(0);
        (await Count(db, "notification")).ShouldBe(2);
    }
}
