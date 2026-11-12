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
/// и composition root. Круг — все держатели права ставок (PER-812), а не только
/// те, кто вёл лот этого аукциона.
/// </summary>
public class AuctionFinalTests
{
    private const string HeldSubject = "events.auction.lot_held_for_final";
    private const string LineupSubject = "events.auction.final_lineup_frozen";
    private const string StartedSubject = "events.auction.final_started";
    private const string ActivatedSubject = "events.auction.final_lot_activated";
    private const string FinishedSubject = "events.auction.auction_finished";
    private const string EndedSubject = "events.auction.prebidding_ended";

    // Человек без права ставок: вестей финала не получает.
    private static readonly Holding WithoutBids = new("member", [], ["access_hub"]);

    private static async Task<string> Holder(IsolatedDatabase db, Holding? holding = null) =>
        (await Person(db, holding ?? MemberHolding)).ToString();

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
        var (leader, bidder, idle) = (await Holder(db), await Holder(db), await Holder(db));
        var stranger = await Holder(db, WithoutBids);
        var (first, second, sold) = (EventFactory.NewId(), EventFactory.NewId(), EventFactory.NewId());

        await nats.Publish(AuctionFeed.BidPlacedSubject, EventFactory.Bid(first, leader: leader, auction: auction));
        await nats.Publish(AuctionFeed.BidPlacedSubject, EventFactory.Bid(second, leader: leader, auction: auction));
        await nats.Publish(AuctionFeed.BidPlacedSubject, EventFactory.Bid(sold, leader: bidder, auction: auction));
        await nats.Publish(AuctionFeed.BidPlacedSubject, EventFactory.Bid(EventFactory.NewId(), leader: stranger));
        await nats.Publish(HeldSubject, EventFactory.HeldForFinal(first, auction: auction, leader: leader, price: 50000));
        await nats.Publish(HeldSubject, EventFactory.HeldForFinal(second, auction: auction, leader: leader, price: 70000));
        var lineup = EventFactory.LineupFrozen(auction, meetup, second, first);
        await nats.Publish(LineupSubject, lineup);

        var published = await Eventually(nats.PublishedFacts, facts => facts.Count == 3);
        var facts = published.Select(entry => entry.Fact).ToList();
        facts.ShouldAllBe(fact => fact.TypeCase == Notification.TypeOneofCase.AuctionFinalLineup);
        facts.ShouldAllBe(fact => fact.Cause.AuctionEventId == lineup.EventId);
        // Весть получает и тот, кто ставок не делал; без права ставок — никто.
        facts.Select(fact => fact.RecipientId).ShouldBe(new[] { leader, bidder, idle }, ignoreOrder: true);
        facts.ShouldNotContain(fact => fact.RecipientId == stranger);

        var own = facts.Single(fact => fact.RecipientId == leader).AuctionFinalLineup;
        own.AuctionId.ShouldBe(auction);
        own.MeetupId.ShouldBe(meetup);
        own.Lineup.Select(lot => lot.LotId).ShouldBe(new[] { second, first });
        own.Lineup.Select(lot => lot.Price.MinorUnits).ShouldBe(new long[] { 70000, 50000 });
        own.YourLotIds.ShouldBe(new[] { second, first });
        facts.Single(fact => fact.RecipientId == bidder).AuctionFinalLineup.YourLotIds.ShouldBeEmpty();
        facts.Single(fact => fact.RecipientId == idle).AuctionFinalLineup.YourLotIds.ShouldBeEmpty();

        await nats.Publish(LineupSubject, lineup, messageId: Guid.NewGuid().ToString());
        await Eventually(() => Task.FromResult(silo.Service<AuctionTelemetry>().Total("duplicate")), count => count == 1);
        (await nats.PublishedFacts()).Count.ShouldBe(3);
        (await Count(db, "notification")).ShouldBe(3);
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
        var (leader, lot) = (await Holder(db), EventFactory.NewId());

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
        var (leader, known, lost) = (await Holder(db), EventFactory.NewId(), EventFactory.NewId());

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
    /// <remarks>
    /// Старт финала — и момент, когда первый лот состава становится следующим:
    /// его лидер узнаёт об этом отдельным фактом (ADR-063, дополнение
    /// 2026-10-20).
    /// </remarks>
    [Fact]
    public async Task When_FinalStartedThenAuctionFinished_Expect_FactPerBidderAndAudienceForgotten()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var auction = EventFactory.AuctionOfMeetup();
        var meetup = EventFactory.NewId();
        var (leader, bidder, lot) = (await Holder(db), await Holder(db), EventFactory.NewId());

        await nats.Publish(AuctionFeed.BidPlacedSubject, EventFactory.Bid(lot, leader: leader, auction: auction));
        await nats.Publish(AuctionFeed.BidPlacedSubject,
            EventFactory.Bid(EventFactory.NewId(), leader: bidder, auction: auction));
        await nats.Publish(HeldSubject, EventFactory.HeldForFinal(lot, auction: auction, leader: leader));
        var started = EventFactory.FinalStarted(auction, meetup, lot);
        await nats.Publish(StartedSubject, started);

        var published = await Eventually(nats.PublishedFacts, facts => facts.Count == 3);
        var facts = published.Select(entry => entry.Fact).ToList();
        var announced = facts
            .Where(fact => fact.TypeCase == Notification.TypeOneofCase.AuctionFinalStarted)
            .ToArray();
        announced.ShouldAllBe(fact => fact.AuctionFinalStarted.AuctionId == auction && fact.AuctionFinalStarted.MeetupId == meetup);
        announced.Select(fact => fact.RecipientId).ShouldBe(new[] { leader, bidder }, ignoreOrder: true);

        // Следующий лот состава — лидеру первого лота: его лот идёт первым.
        var next = facts.Single(fact => fact.TypeCase == Notification.TypeOneofCase.AuctionFinalLotNext);
        next.RecipientId.ShouldBe(leader);
        next.AuctionFinalLotNext.LotId.ShouldBe(lot);
        // Старт финала: лот ещё не идёт, свой лот первый из одного; времени не обещают.
        next.AuctionFinalLotNext.ActiveLotId.ShouldBeEmpty();
        next.AuctionFinalLotNext.Place.ShouldBe(1u);
        next.AuctionFinalLotNext.LineupSize.ShouldBe(1u);
        next.AuctionFinalLotNext.EstimatedMinutes.ShouldBe(0);

        await nats.Publish(FinishedSubject, EventFactory.AuctionFinished(auction, meetup));
        await Eventually(() => Count(db, "auction_bidder"), count => count == 0);
        (await Count(db, "lot_hold")).ShouldBe(0);
        (await Count(db, "auction_final_lot")).ShouldBe(0);
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
        var (silenced, bidder, lot) = (await Holder(db), await Holder(db), EventFactory.NewId());
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

    /// <summary>
    /// Лот финала взяли в работу: следующий лот состава известен, и его лидер
    /// узнаёт, что его лот идёт следом (ADR-063, дополнение 2026-10-20).
    /// </summary>
    [Fact]
    public async Task When_LotActivated_Expect_NextLotLeaderNotified()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var auction = EventFactory.AuctionOfMeetup();
        var meetup = EventFactory.NewId();
        var (firstLeader, secondLeader) = (await Holder(db), await Holder(db));
        var (first, second) = (EventFactory.NewId(), EventFactory.NewId());

        await nats.Publish(HeldSubject, EventFactory.HeldForFinal(first, auction: auction, leader: firstLeader));
        await nats.Publish(HeldSubject, EventFactory.HeldForFinal(second, auction: auction, leader: secondLeader));
        await nats.Publish(ActivatedSubject,
            EventFactory.FinalLotActivated(auction, meetup, first, first, second));

        var published = await Eventually(nats.PublishedFacts, facts => facts.Count == 1);
        var fact = published.Single().Fact;
        fact.TypeCase.ShouldBe(Notification.TypeOneofCase.AuctionFinalLotNext);
        fact.RecipientId.ShouldBe(secondLeader);
        fact.AuctionFinalLotNext.LotId.ShouldBe(second);
        // Называется идущий сейчас лот и место своего лота; времени не обещают.
        fact.AuctionFinalLotNext.ActiveLotId.ShouldBe(first);
        fact.AuctionFinalLotNext.Place.ShouldBe(2u);
        fact.AuctionFinalLotNext.LineupSize.ShouldBe(2u);
        fact.AuctionFinalLotNext.EstimatedMinutes.ShouldBe(0);
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

    /// <summary>
    /// Конец онлайн-торгов с лотами на удержании (PER-812): весть получают все
    /// держатели права ставок, и не делавший ставок тоже; без права и выключивший
    /// анонс финала — нет. Число проданных и удержанных лотов считает реплика.
    /// </summary>
    [Fact]
    public async Task When_PrebiddingEndsIntoBreak_Expect_FactToEveryBidsHolderWithCounts()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var auction = EventFactory.AuctionOfMeetup();
        var meetup = EventFactory.NewId();
        var (bidder, idle, silenced) = (await Holder(db), await Holder(db), await Holder(db));
        var stranger = await Holder(db, WithoutBids);
        await SetFinalAnnouncements(db, silenced, enabled: false);
        var (soldLot, heldLot) = (EventFactory.NewId(), EventFactory.NewId());

        await nats.Publish(AuctionFeed.LotSoldSubject, EventFactory.Sold(soldLot, winner: EventFactory.NewId()));
        await nats.Publish(HeldSubject, EventFactory.HeldForFinal(heldLot, auction: auction, leader: bidder));
        await nats.Publish(EndedSubject, EventFactory.PrebiddingBreak(auction, meetup, soldLot, heldLot));

        var published = await Eventually(nats.PublishedFacts, facts => facts.Count(entry =>
            entry.Fact.TypeCase == Notification.TypeOneofCase.AuctionPrebiddingEnded) == 2);
        var facts = published.Select(entry => entry.Fact)
            .Where(fact => fact.TypeCase == Notification.TypeOneofCase.AuctionPrebiddingEnded)
            .ToList();
        facts.Select(fact => fact.RecipientId).ShouldBe(new[] { bidder, idle }, ignoreOrder: true);
        facts.ShouldNotContain(fact => fact.RecipientId == stranger || fact.RecipientId == silenced);
        facts.ShouldAllBe(fact => fact.AuctionPrebiddingEnded.AuctionId == auction
            && fact.AuctionPrebiddingEnded.MeetupId == meetup
            && fact.AuctionPrebiddingEnded.SoldCount == 1 && fact.AuctionPrebiddingEnded.HeldCount == 1);
    }

    /// <summary>
    /// Каталог без удержанных лотов кончает аукцион тем же фактом: финала не
    /// будет, и об этом тоже узнают все держатели права ставок (PER-812).
    /// </summary>
    [Fact]
    public async Task When_PrebiddingEndsWithoutHeldLots_Expect_FactWithNoFinal()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var auction = EventFactory.AuctionOfMeetup();
        var holder = await Holder(db);
        var soldLot = EventFactory.NewId();

        await nats.Publish(AuctionFeed.LotSoldSubject, EventFactory.Sold(soldLot, winner: EventFactory.NewId()));
        await nats.Publish(EndedSubject, EventFactory.PrebiddingFinished(auction, EventFactory.NewId(), soldLot));

        var published = await Eventually(nats.PublishedFacts, facts => facts.Count(entry =>
            entry.Fact.TypeCase == Notification.TypeOneofCase.AuctionPrebiddingEnded) == 1);
        var fact = published.Select(entry => entry.Fact)
            .Single(entry => entry.TypeCase == Notification.TypeOneofCase.AuctionPrebiddingEnded);
        fact.RecipientId.ShouldBe(holder);
        fact.AuctionPrebiddingEnded.SoldCount.ShouldBe(1u);
        fact.AuctionPrebiddingEnded.HeldCount.ShouldBe(0u);
    }

    /// <summary>
    /// Лот финала продан: узнают все, кто на него ставил, кроме победителя —
    /// ему приходит покупка; выключивший анонс финала и лот вне финала вести
    /// не дают (PER-812).
    /// </summary>
    [Fact]
    public async Task When_FinalLotSold_Expect_FactToItsBiddersExceptWinner()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var auction = EventFactory.AuctionOfMeetup();
        var meetup = EventFactory.NewId();
        var (loser, other, winner, silenced) = (EventFactory.NewId(), EventFactory.NewId(), EventFactory.NewId(),
            EventFactory.NewId());
        await SetFinalAnnouncements(db, silenced, enabled: false);
        var (finalLot, onlineLot) = (EventFactory.NewId(), EventFactory.NewId());

        foreach (var leader in new[] { loser, other, silenced, winner })
        {
            await nats.Publish(AuctionFeed.BidPlacedSubject, EventFactory.Bid(finalLot, leader: leader, auction: auction));
        }
        await nats.Publish(AuctionFeed.BidPlacedSubject, EventFactory.Bid(onlineLot, leader: loser, auction: auction));
        await nats.Publish(ActivatedSubject, EventFactory.FinalLotActivated(auction, meetup, finalLot, finalLot));
        await nats.Publish(AuctionFeed.LotSoldSubject, EventFactory.Sold(onlineLot, winner: winner));
        await nats.Publish(AuctionFeed.LotSoldSubject, EventFactory.Sold(finalLot, winner: winner));

        var published = await Eventually(nats.PublishedFacts, facts => facts.Count(entry =>
            entry.Fact.TypeCase == Notification.TypeOneofCase.AuctionLotSoldInFinal) == 2);
        var sold = published.Select(entry => entry.Fact)
            .Where(fact => fact.TypeCase == Notification.TypeOneofCase.AuctionLotSoldInFinal)
            .ToList();
        sold.Select(fact => fact.RecipientId).ShouldBe(new[] { loser, other }, ignoreOrder: true);
        sold.ShouldAllBe(fact => fact.AuctionLotSoldInFinal.LotId == finalLot);
        // Победитель получает покупки обоих лотов, но не весть о проигранном.
        published.Select(entry => entry.Fact)
            .Count(fact => fact.TypeCase == Notification.TypeOneofCase.LotPurchased && fact.RecipientId == winner)
            .ShouldBe(2);
    }
}
