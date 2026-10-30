using Auction.V1;
using Notifications.Auction;
using Notifications.Infrastructure;
using Notifications.TestKit;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.AuctionTests;

/// <summary>Разбор фактов финала аукциона и форма анонса (PER-477).</summary>
public class AuctionFinalTests
{
    private const string LineupSubject = "events.auction.final_lineup_frozen";
    private const string StartedSubject = "events.auction.final_started";

    [Fact]
    public void When_LineupFrozen_Expect_LineupInFinalOrder()
    {
        var auction = EventFactory.AuctionOfMeetup();
        var meetup = EventFactory.NewId();
        var lots = new[] { EventFactory.NewId(), EventFactory.NewId() };
        var message = EventFactory.LineupFrozen(auction, meetup, lots);

        var final = Decode(LineupSubject, message);

        final.EventId.ShouldBe(Guid.Parse(message.EventId));
        final.AuctionId.ShouldBe(Guid.Parse(auction));
        final.MeetupId.ShouldBe(Guid.Parse(meetup));
        final.Occasion.ShouldBe(FinalOccasion.LineupFrozen);
        final.Lineup.ShouldBe(lots.Select(Guid.Parse).ToArray());
    }

    [Fact]
    public void When_FinalStarted_Expect_StartedOccasion()
    {
        var message = EventFactory.FinalStarted(EventFactory.AuctionOfMeetup(), EventFactory.NewId(), EventFactory.NewId());
        Decode(StartedSubject, message).Occasion.ShouldBe(FinalOccasion.Started);
    }

    [Fact]
    public void When_LineupSubjectCarriesOtherStatus_Expect_Poison()
    {
        var message = EventFactory.FinalStarted(EventFactory.AuctionOfMeetup(), EventFactory.NewId(), EventFactory.NewId());
        message.FinalLineupFrozen = new FinalLineupFrozen();
        AuctionMapping.Decode(LineupSubject, EventFactory.Bytes(message)).ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_SubjectDoesNotMatchOccasion_Expect_Poison()
    {
        var message = EventFactory.LineupFrozen(EventFactory.AuctionOfMeetup(), EventFactory.NewId(), EventFactory.NewId());
        AuctionMapping.Decode(StartedSubject, EventFactory.Bytes(message)).ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_LineupEmptyOrRepeated_Expect_Poison()
    {
        var lot = EventFactory.NewId();
        var empty = EventFactory.LineupFrozen(EventFactory.AuctionOfMeetup(), EventFactory.NewId());
        var repeated = EventFactory.LineupFrozen(EventFactory.AuctionOfMeetup(), EventFactory.NewId(), lot, lot);
        AuctionMapping.Decode(LineupSubject, EventFactory.Bytes(empty)).ShouldBeOfType<AuctionDecoded.Poison>();
        AuctionMapping.Decode(LineupSubject, EventFactory.Bytes(repeated)).ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_MeetupIdInvalid_Expect_Poison()
    {
        var message = EventFactory.LineupFrozen(EventFactory.AuctionOfMeetup(), "not-a-uuid", EventFactory.NewId());
        AuctionMapping.Decode(LineupSubject, EventFactory.Bytes(message)).ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_AuctionFinished_Expect_Closed()
    {
        var auction = EventFactory.AuctionOfMeetup();
        var closed = AuctionMapping.Decode("events.auction.auction_finished",
                EventFactory.Bytes(EventFactory.AuctionFinished(auction, EventFactory.NewId())))
            .ShouldBeOfType<AuctionDecoded.Closed>().Value;
        closed.AuctionId.ShouldBe(Guid.Parse(auction));
    }

    /// <summary>
    /// Каталог с удержанными лотами ведёт к перерыву, а не к концу: круг ещё
    /// нужен, а весть о конце онлайн-торгов уходит всем (PER-812).
    /// </summary>
    [Fact]
    public void When_PrebiddingEndsIntoBreak_Expect_TradingEndedWithRegistry()
    {
        var lots = new[] { EventFactory.NewId(), EventFactory.NewId() };
        var message = EventFactory.AuctionFinished(EventFactory.AuctionOfMeetup(), EventFactory.NewId());
        message.State.OnBreak = new AuctionState.Types.Break();
        message.State.LotIds.AddRange(lots);
        message.PrebiddingEnded = new PrebiddingEnded();

        var ended = AuctionMapping.Decode("events.auction.prebidding_ended", EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.TradingEnded>().Value;

        ended.Registry.ShouldBe(lots.Select(Guid.Parse).ToArray());
    }

    [Fact]
    public void When_PrebiddingEndsIntoBreakWithRepeatedLot_Expect_Poison()
    {
        var lot = EventFactory.NewId();
        var message = EventFactory.AuctionFinished(EventFactory.AuctionOfMeetup(), EventFactory.NewId());
        message.State.OnBreak = new AuctionState.Types.Break();
        message.State.LotIds.AddRange([lot, lot]);
        message.PrebiddingEnded = new PrebiddingEnded();

        AuctionMapping.Decode("events.auction.prebidding_ended", EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Poison>();
    }

    /// <summary>Конец торгов без финала помечен: весть о нём тоже уходит, а конец после финала — нет.</summary>
    [Fact]
    public void When_PrebiddingEndsFinished_Expect_ClosedFromPrebidding()
    {
        var message = EventFactory.PrebiddingFinished(EventFactory.AuctionOfMeetup(), EventFactory.NewId());

        AuctionMapping.Decode("events.auction.prebidding_ended", EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Closed>().Value.FromPrebidding.ShouldBeTrue();
        AuctionMapping.Decode("events.auction.auction_finished",
                EventFactory.Bytes(EventFactory.AuctionFinished(EventFactory.AuctionOfMeetup(), EventFactory.NewId())))
            .ShouldBeOfType<AuctionDecoded.Closed>().Value.FromPrebidding.ShouldBeFalse();
    }

    [Fact]
    public void When_TradingEndFactBuilt_Expect_CountsAndCause()
    {
        var ended = new AuctionTradingEnded(Guid.CreateVersion7(), Guid.CreateVersion7(), Guid.CreateVersion7(), 3,
            EventFactory.Committed, []);

        var notification = AuctionFacts.PrebiddingEnded(Guid.CreateVersion7(), Guid.CreateVersion7(), ended, 4, 2,
            EventFactory.Committed, EventFactory.Committed.AddHours(1));

        notification.AuctionPrebiddingEnded.AuctionId.ShouldBe(ended.AuctionId.ToString());
        notification.AuctionPrebiddingEnded.MeetupId.ShouldBe(ended.MeetupId.ToString());
        notification.AuctionPrebiddingEnded.SoldCount.ShouldBe(4u);
        notification.AuctionPrebiddingEnded.HeldCount.ShouldBe(2u);
        notification.Cause.AuctionEventId.ShouldBe(ended.EventId.ToString());
    }

    [Fact]
    public void When_PrebiddingEndsFinished_Expect_Closed()
    {
        var message = EventFactory.AuctionFinished(EventFactory.AuctionOfMeetup(), EventFactory.NewId());
        message.PrebiddingEnded = new PrebiddingEnded();
        AuctionMapping.Decode("events.auction.prebidding_ended", EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Closed>();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void When_HeldForFinal_Expect_HoldWithPriceAndLeader(bool withBid)
    {
        var auction = EventFactory.AuctionOfMeetup();
        var leader = EventFactory.NewId();
        var message = EventFactory.HeldForFinal(EventFactory.NewId(), auction: auction, leader: withBid ? leader : "",
            price: 50000);

        var hold = AuctionMapping.Decode("events.auction.lot_held_for_final", EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Lot>().Value.Hold.ShouldNotBeNull();

        hold.LotId.ShouldBe(Guid.Parse(message.LotId));
        hold.AuctionId.ShouldBe(Guid.Parse(auction));
        hold.Leader.ShouldBe(withBid ? Guid.Parse(leader) : null);
        hold.Price.MinorUnits.ShouldBe(50000);
    }

    /// <summary>Кривая цена удержания лишает лот только записи для анонса, реплика идёт.</summary>
    [Fact]
    public void When_HeldPriceInvalid_Expect_ReplicaWithoutHold()
    {
        var message = EventFactory.HeldForFinal(EventFactory.NewId());
        message.State.Held.CurrentPrice.Currency = "rub";

        var fact = AuctionMapping.Decode("events.auction.lot_held_for_final", EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Lot>().Value;

        fact.Snapshot.Status.ShouldBe(LotStatus.Held);
        fact.Hold.ShouldBeNull();
    }

    [Fact]
    public void When_BidPlaced_Expect_AuctionOfTheLot()
    {
        var auction = EventFactory.AuctionOfMeetup();
        var bid = AuctionMapping.Decode(AuctionFeed.BidPlacedSubject,
                EventFactory.Bytes(EventFactory.Bid(EventFactory.NewId(), auction: auction)))
            .ShouldBeOfType<AuctionDecoded.Bid>().Value;
        bid.AuctionId.ShouldBe(Guid.Parse(auction));
    }

    [Fact]
    public void When_RecipientLeadsLotsOfLineup_Expect_OwnLotsNamedInLineupOrder()
    {
        var recipient = Guid.CreateVersion7();
        var other = Guid.CreateVersion7();
        var final = Decode(LineupSubject,
            EventFactory.LineupFrozen(EventFactory.AuctionOfMeetup(), EventFactory.NewId(), EventFactory.NewId()));
        var lineup = new[]
        {
            Held(recipient, 300), Held(other, 200), Held(null, 100), Held(recipient, 400),
        };

        var fact = AuctionFacts.FinalLineup(Guid.CreateVersion7(), recipient, final, lineup,
            EventFactory.Committed, EventFactory.Committed.AddHours(24));

        fact.Cause.AuctionEventId.ShouldBe(final.EventId.ToString());
        fact.AuctionFinalLineup.Lineup.Select(lot => lot.LotId).ShouldBe(lineup.Select(lot => lot.LotId.ToString()));
        fact.AuctionFinalLineup.Lineup.Select(lot => lot.Price.MinorUnits).ShouldBe(new long[] { 300, 200, 100, 400 });
        fact.AuctionFinalLineup.YourLotIds.ShouldBe(new[] { lineup[0].LotId.ToString(), lineup[3].LotId.ToString() });
    }

    [Fact]
    public void When_RecipientLeadsNoLotOfLineup_Expect_PlainAnnouncement()
    {
        var final = Decode(LineupSubject,
            EventFactory.LineupFrozen(EventFactory.AuctionOfMeetup(), EventFactory.NewId(), EventFactory.NewId()));
        var fact = AuctionFacts.FinalLineup(Guid.CreateVersion7(), Guid.CreateVersion7(), final,
            [Held(Guid.CreateVersion7(), 100)], EventFactory.Committed, EventFactory.Committed.AddHours(24));
        fact.AuctionFinalLineup.YourLotIds.ShouldBeEmpty();
        fact.AuctionFinalLineup.AuctionId.ShouldBe(final.AuctionId.ToString());
        fact.AuctionFinalLineup.MeetupId.ShouldBe(final.MeetupId.ToString());
    }

    private static HeldLot Held(Guid? leader, long price) =>
        new(Guid.CreateVersion7(), leader, new Money { MinorUnits = price, Currency = "RUB" });

    private static AuctionFinal Decode(string subject, AuctionEvent message) =>
        AuctionMapping.Decode(subject, EventFactory.Bytes(message)).ShouldBeOfType<AuctionDecoded.Final>().Value;

    [Fact]
    public void When_LotSoldInFinalFactBuilt_Expect_LotAndPriceWithSaleCause()
    {
        var sale = new AuctionSale(Guid.CreateVersion7(), Guid.CreateVersion7(), Guid.CreateVersion7(), 5,
            EventFactory.Committed, Guid.CreateVersion7(), new Money { MinorUnits = 90000, Currency = "RUB" }, null);

        var notification = AuctionFacts.LotSoldInFinal(Guid.CreateVersion7(), Guid.CreateVersion7(), sale,
            EventFactory.Committed, EventFactory.Committed.AddHours(1));

        notification.AuctionLotSoldInFinal.LotId.ShouldBe(sale.LotId.ToString());
        notification.AuctionLotSoldInFinal.Price.MinorUnits.ShouldBe(90000);
        notification.Cause.AuctionLotEventId.ShouldBe(sale.EventId.ToString());
    }
}
