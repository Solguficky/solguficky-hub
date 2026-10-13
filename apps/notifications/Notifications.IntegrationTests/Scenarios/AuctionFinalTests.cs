using Notifications.Auction;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.TestKit;
using Notifications.V1;
using Shouldly;
using Xunit;
using static Notifications.IntegrationTests.Infrastructure.FactFixtures;
using static Notifications.IntegrationTests.Infrastructure.AuctionFixtures;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Анонс состава и старта финала (PER-477) через настоящие JetStream, PostgreSQL
/// и composition root. Круг — те, кто хоть раз вёл лот этого аукциона.
/// </summary>
public class AuctionFinalTests
{
    private const string HeldSubject = "events.auction.lot_held_for_final";
    private const string LineupSubject = "events.auction.final_lineup_frozen";
    private const string StartedSubject = "events.auction.final_started";
    private const string FinishedSubject = "events.auction.auction_finished";

    /// <summary>
    /// Лидер лота состава получает один анонс со своим лотом, участник без
    /// лота состава — анонс без своих лотов, ставивший в другом аукционе —
    /// ничего; повтор факта заморозки второго анонса не даёт.
    /// </summary>
    [Fact]
    public async Task When_LineupFrozen_Expect_OneFactPerBidderAndNoneOnRedelivery()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var auction = EventFactory.AuctionOfMeetup();
        var meetup = EventFactory.NewId();
        var (leader, bidder, stranger) = (EventFactory.NewId(), EventFactory.NewId(), EventFactory.NewId());
        var (first, second, sold) = (EventFactory.NewId(), EventFactory.NewId(), EventFactory.NewId());

        await nats.Publish(AuctionFeed.BidPlacedSubject, EventFactory.Bid(first, leader: leader, auction: auction));
        await nats.Publish(AuctionFeed.BidPlacedSubject, EventFactory.Bid(second, leader: leader, auction: auction));
        await nats.Publish(AuctionFeed.BidPlacedSubject, EventFactory.Bid(sold, leader: bidder, auction: auction));
        await nats.Publish(AuctionFeed.BidPlacedSubject, EventFactory.Bid(EventFactory.NewId(), leader: stranger));
        await nats.Publish(HeldSubject, EventFactory.HeldForFinal(first, auction: auction, leader: leader, price: 50000));
        await nats.Publish(HeldSubject, EventFactory.HeldForFinal(second, auction: auction, leader: leader, price: 70000));
        var lineup = EventFactory.LineupFrozen(auction, meetup, second, first);
        await nats.Publish(LineupSubject, lineup);

        var published = await Eventually(nats.PublishedFacts, facts => facts.Count == 2);
        var facts = published.Select(entry => entry.Fact).ToList();
        facts.ShouldAllBe(fact => fact.TypeCase == Notification.TypeOneofCase.AuctionFinalLineup);
        facts.ShouldAllBe(fact => fact.Cause.AuctionEventId == lineup.EventId);
        facts.Select(fact => fact.RecipientId).ShouldBe(new[] { leader, bidder }, ignoreOrder: true);

        var own = facts.Single(fact => fact.RecipientId == leader).AuctionFinalLineup;
        own.AuctionId.ShouldBe(auction);
        own.MeetupId.ShouldBe(meetup);
        own.Lineup.Select(lot => lot.LotId).ShouldBe(new[] { second, first });
        own.Lineup.Select(lot => lot.Price.MinorUnits).ShouldBe(new long[] { 70000, 50000 });
        own.YourLotIds.ShouldBe(new[] { second, first });
        facts.Single(fact => fact.RecipientId == bidder).AuctionFinalLineup.YourLotIds.ShouldBeEmpty();

        await nats.Publish(LineupSubject, lineup, messageId: Guid.NewGuid().ToString());
        await Eventually(() => Task.FromResult(silo.Service<AuctionTelemetry>().Total("duplicate")), count => count == 1);
        (await nats.PublishedFacts()).Count.ShouldBe(2);
        (await Count(db, "notification")).ShouldBe(2);
    }

    /// <summary>
    /// Удержание лота состава пришло после факта заморозки: анонс ждёт его в
    /// потоке, а не уходит без лота и не теряется.
    /// </summary>
    [Fact]
    public async Task When_HoldArrivesAfterLineup_Expect_AnnouncementAfterHold()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var auction = EventFactory.AuctionOfMeetup();
        var (leader, lot) = (EventFactory.NewId(), EventFactory.NewId());

        await nats.Publish(AuctionFeed.BidPlacedSubject, EventFactory.Bid(lot, leader: leader, auction: auction));
        // Срок ожидания считается от заморозки: она только что случилась.
        var lineup = EventFactory.LineupFrozen(auction, EventFactory.NewId(), lot);
        lineup.OccurredAt = DateTimeOffset.UtcNow.ToString("O");
        await nats.Publish(LineupSubject, lineup);
        await Eventually(() => Task.FromResult(silo.Service<AuctionTelemetry>().Total("lineup_pending")), count => count >= 1);
        (await Count(db, "notification")).ShouldBe(0);

        await nats.Publish(HeldSubject, EventFactory.HeldForFinal(lot, auction: auction, leader: leader));

        var published = await Eventually(nats.PublishedFacts, facts => facts.Count == 1);
        published.Single().Fact.AuctionFinalLineup.YourLotIds.ShouldBe(new[] { lot });
        silo.Service<AuctionTelemetry>().Total("final_announced").ShouldBe(1);
    }

    /// <summary>
    /// Удержание одного лота состава так и не пришло: после срока ожидания
    /// анонс уходит по известным лотам, а не висит в потоке. Лидер известного
    /// лота получает его, даже если своей ставки круг не видел.
    /// </summary>
    [Fact]
    public async Task When_HoldNeverArrivesAndWaitExpired_Expect_AnnouncementWithKnownLots()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var auction = EventFactory.AuctionOfMeetup();
        var (leader, known, lost) = (EventFactory.NewId(), EventFactory.NewId(), EventFactory.NewId());

        await nats.Publish(HeldSubject, EventFactory.HeldForFinal(known, auction: auction, leader: leader));
        await nats.Publish(LineupSubject, EventFactory.LineupFrozen(auction, EventFactory.NewId(), known, lost));

        var published = await Eventually(nats.PublishedFacts, facts => facts.Count == 1);
        var fact = published.Single().Fact;
        fact.RecipientId.ShouldBe(leader);
        fact.AuctionFinalLineup.Lineup.Select(lot => lot.LotId).ShouldBe(new[] { known });
        fact.AuctionFinalLineup.YourLotIds.ShouldBe(new[] { known });
        silo.Service<AuctionTelemetry>().Total("lineup_incomplete").ShouldBe(1);
    }

    /// <summary>
    /// Старт финала получают все участники, лидер состава тоже; конец аукциона
    /// забывает его круг и удержания.
    /// </summary>
    [Fact]
    public async Task When_FinalStartedThenAuctionFinished_Expect_FactPerBidderAndAudienceForgotten()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var auction = EventFactory.AuctionOfMeetup();
        var meetup = EventFactory.NewId();
        var (leader, bidder, lot) = (EventFactory.NewId(), EventFactory.NewId(), EventFactory.NewId());

        await nats.Publish(AuctionFeed.BidPlacedSubject, EventFactory.Bid(lot, leader: leader, auction: auction));
        await nats.Publish(AuctionFeed.BidPlacedSubject,
            EventFactory.Bid(EventFactory.NewId(), leader: bidder, auction: auction));
        await nats.Publish(HeldSubject, EventFactory.HeldForFinal(lot, auction: auction, leader: leader));
        var started = EventFactory.FinalStarted(auction, meetup, lot);
        await nats.Publish(StartedSubject, started);

        var published = await Eventually(nats.PublishedFacts, facts => facts.Count == 2);
        var facts = published.Select(entry => entry.Fact).ToList();
        facts.ShouldAllBe(fact => fact.TypeCase == Notification.TypeOneofCase.AuctionFinalStarted);
        facts.ShouldAllBe(fact => fact.AuctionFinalStarted.AuctionId == auction && fact.AuctionFinalStarted.MeetupId == meetup);
        facts.Select(fact => fact.RecipientId).ShouldBe(new[] { leader, bidder }, ignoreOrder: true);

        await nats.Publish(FinishedSubject, EventFactory.AuctionFinished(auction, meetup));
        await Eventually(() => Count(db, "auction_bidder"), count => count == 0);
        (await Count(db, "lot_hold")).ShouldBe(0);
    }

    /// <summary>
    /// Выключивший анонс финала (PER-539) не получает ни состава, ни старта,
    /// даже лидером лота состава; включённый выключатель анонс не меняет.
    /// </summary>
    [Fact]
    public async Task When_BidderSilencedFinal_Expect_NoLineupAndNoStartForThem()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var auction = EventFactory.AuctionOfMeetup();
        var meetup = EventFactory.NewId();
        var (silenced, bidder, lot) = (EventFactory.NewId(), EventFactory.NewId(), EventFactory.NewId());
        await SetFinalAnnouncements(db, silenced, enabled: false);
        await SetFinalAnnouncements(db, bidder, enabled: true);

        await nats.Publish(AuctionFeed.BidPlacedSubject, EventFactory.Bid(lot, leader: silenced, auction: auction));
        await nats.Publish(AuctionFeed.BidPlacedSubject,
            EventFactory.Bid(EventFactory.NewId(), leader: bidder, auction: auction));
        await nats.Publish(HeldSubject, EventFactory.HeldForFinal(lot, auction: auction, leader: silenced));
        await nats.Publish(LineupSubject, EventFactory.LineupFrozen(auction, meetup, lot));
        await nats.Publish(StartedSubject, EventFactory.FinalStarted(auction, meetup, lot));

        var published = await Eventually(nats.PublishedFacts, facts => facts.Count == 2);
        var facts = published.Select(entry => entry.Fact).ToList();
        facts.ShouldAllBe(fact => fact.RecipientId == bidder);
        facts.Select(fact => fact.TypeCase).ShouldBe(
            new[] { Notification.TypeOneofCase.AuctionFinalLineup, Notification.TypeOneofCase.AuctionFinalStarted },
            ignoreOrder: true);
        await Eventually(() => Task.FromResult(silo.Service<AuctionTelemetry>().Total("final_announced")),
            count => count == 2);
        (await Count(db, "notification")).ShouldBe(2);
    }

    [Theory]
    [InlineData("member", "events.notifications.notification_created.hub")]
    [InlineData("guest", "events.notifications.notification_created.auction")]
    public async Task When_BidderHasCircle_Expect_AnnouncementOnCircleSubject(string circle, string subject)
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        var recipient = (await Person(db, circle == "member" ? MemberHolding : GuestHolding)).ToString();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var auction = EventFactory.AuctionOfMeetup();

        await nats.Publish(AuctionFeed.BidPlacedSubject,
            EventFactory.Bid(EventFactory.NewId(), leader: recipient, auction: auction));
        await nats.Publish(StartedSubject, EventFactory.FinalStarted(auction, EventFactory.NewId(), EventFactory.NewId()));

        var published = await Eventually(nats.PublishedFacts, facts => facts.Count == 1);
        published.Single().Subject.ShouldBe(subject);
    }
}
