using Notifications.Auction;
using Notifications.Facts;
using Notifications.TestKit;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.AuctionTests;

/// <summary>
/// Следующий лот живого финала (ADR-063, дополнение 2026-10-20): разбор факта
/// взятия лота в работу, оценка его длительности и форма сообщения.
/// </summary>
public class FinalLotNextTests
{
    private const string ActivatedSubject = "events.auction.final_lot_activated";

    [Fact]
    public void When_LotActivated_Expect_ActiveLotAndLineup()
    {
        var auction = EventFactory.AuctionOfMeetup();
        var meetup = EventFactory.NewId();
        var lots = new[] { EventFactory.NewId(), EventFactory.NewId() };
        var message = EventFactory.FinalLotActivated(auction, meetup, lots[0], lots);

        var decoded = AuctionMapping.Decode(ActivatedSubject, EventFactory.Bytes(message));

        var activated = decoded.ShouldBeOfType<AuctionDecoded.FinalLotActivated>().Value;
        activated.EventId.ShouldBe(Guid.Parse(message.EventId));
        activated.AuctionId.ShouldBe(Guid.Parse(auction));
        activated.ActiveLotId.ShouldBe(Guid.Parse(lots[0]));
        activated.Lineup.ShouldBe(lots.Select(Guid.Parse).ToArray());
    }

    [Fact]
    public void When_ActivatedWithoutActiveLot_Expect_Poison()
    {
        var message = EventFactory.FinalLotActivated(EventFactory.AuctionOfMeetup(), EventFactory.NewId(),
            EventFactory.NewId(), EventFactory.NewId());
        message.State.InFinal.ClearActiveLotId();

        AuctionMapping.Decode(ActivatedSubject, EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_LineupEmptyOrRepeated_Expect_Poison()
    {
        var lot = EventFactory.NewId();
        var empty = EventFactory.FinalLotActivated(EventFactory.AuctionOfMeetup(), EventFactory.NewId(), lot);
        var repeated = EventFactory.FinalLotActivated(EventFactory.AuctionOfMeetup(), EventFactory.NewId(), lot, lot,
            lot);

        AuctionMapping.Decode(ActivatedSubject, EventFactory.Bytes(empty))
            .ShouldBeOfType<AuctionDecoded.Poison>();
        AuctionMapping.Decode(ActivatedSubject, EventFactory.Bytes(repeated))
            .ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_NextLotAnnounced_Expect_FactWithActiveLotAndPlace()
    {
        var eventId = EventFactory.NewId();
        var lotId = EventFactory.NewId();
        var activeLotId = EventFactory.NewId();

        var notification = AuctionFacts.FinalLotNext(Guid.CreateVersion7(), Guid.CreateVersion7(), Guid.Parse(lotId),
            Guid.Parse(activeLotId), 3, 5, Guid.Parse(eventId), EventFactory.Committed,
            EventFactory.Committed.AddHours(1));

        notification.AuctionFinalLotNext.ShouldNotBeNull();
        notification.AuctionFinalLotNext.LotId.ShouldBe(lotId);
        notification.AuctionFinalLotNext.ActiveLotId.ShouldBe(activeLotId);
        notification.AuctionFinalLotNext.Place.ShouldBe(3u);
        notification.AuctionFinalLotNext.LineupSize.ShouldBe(5u);
        // Времени фабрика не обещает: ноль значит «неизвестно».
        notification.AuctionFinalLotNext.EstimatedMinutes.ShouldBe(0);
        // Повод — событие аукциона: взятого в работу лота.
        notification.Cause.AuctionEventId.ShouldBe(eventId);
    }
}
