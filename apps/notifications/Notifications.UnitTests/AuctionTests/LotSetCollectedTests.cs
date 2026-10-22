using Notifications.Auction;
using Notifications.TestKit;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.AuctionTests;

/// <summary>Разбор собранного сета и форма личного факта собравшему (PER-687).</summary>
public class LotSetCollectedTests
{
    private const string Subject = AuctionFeed.LotSetCollectedSubject;

    [Fact]
    public void When_LotSetCollected_Expect_NameCollectorAndLotsInOrganizerOrder()
    {
        var auction = EventFactory.AuctionOfMeetup();
        var meetup = EventFactory.NewId();
        var collector = EventFactory.NewId();
        var lots = new[] { EventFactory.NewId(), EventFactory.NewId(), EventFactory.NewId() };
        var message = EventFactory.LotSetCollected(auction, meetup, collector, "Сервиз", lots);

        var set = AuctionMapping.Decode(Subject, EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.LotSet>().Value;

        set.EventId.ShouldBe(Guid.Parse(message.EventId));
        set.AuctionId.ShouldBe(Guid.Parse(auction));
        set.Version.ShouldBe(message.Version);
        set.Name.ShouldBe("Сервиз");
        set.CollectorId.ShouldBe(Guid.Parse(collector));
        set.LotIds.ShouldBe(lots.Select(Guid.Parse).ToArray());
    }

    [Fact]
    public void When_FactBuilt_Expect_OneRecipientSetCountAndFirstLotAnchor()
    {
        var collector = EventFactory.NewId();
        var lots = new[] { EventFactory.NewId(), EventFactory.NewId(), EventFactory.NewId() };
        var set = AuctionMapping.Decode(Subject, EventFactory.Bytes(EventFactory.LotSetCollected(
                EventFactory.AuctionOfMeetup(), EventFactory.NewId(), collector, "Сервиз", lots)))
            .ShouldBeOfType<AuctionDecoded.LotSet>().Value;

        var fact = AuctionFacts.LotSetCollected(Guid.CreateVersion7(), set, EventFactory.Committed,
            EventFactory.Committed.AddHours(24));

        fact.RecipientId.ShouldBe(collector);
        fact.Cause.AuctionEventId.ShouldBe(set.EventId.ToString());
        fact.TypeCase.ShouldBe(Notifications.V1.Notification.TypeOneofCase.LotSetCollected);
        fact.LotSetCollected.SetName.ShouldBe("Сервиз");
        fact.LotSetCollected.LotCount.ShouldBe(3u);
        fact.LotSetCollected.LotId.ShouldBe(lots[0]);
    }

    [Fact]
    public void When_AuctionSnapshotHasNoMatchingStatus_Expect_LotSetStillDecoded()
    {
        var message = EventFactory.LotSetCollected(EventFactory.AuctionOfMeetup(), EventFactory.NewId(),
            EventFactory.NewId(), "Сервиз", EventFactory.NewId(), EventFactory.NewId());

        // The fixture state has no status: settlement is an occasion, not a
        // transition of AuctionState's status.
        AuctionMapping.Decode(Subject, EventFactory.Bytes(message)).ShouldBeOfType<AuctionDecoded.LotSet>();
    }

    [Fact]
    public void When_OccasionOrSnapshotAuctionDoesNotMatch_Expect_Poison()
    {
        var wrongOccasion = EventFactory.LotSetCollected(EventFactory.AuctionOfMeetup(), EventFactory.NewId(),
            EventFactory.NewId(), "Сервиз", EventFactory.NewId(), EventFactory.NewId());
        wrongOccasion.ClearOccasion();
        var wrongAuction = EventFactory.LotSetCollected(EventFactory.AuctionOfMeetup(), EventFactory.NewId(),
            EventFactory.NewId(), "Сервиз", EventFactory.NewId(), EventFactory.NewId());
        wrongAuction.State.Id = EventFactory.NewId();

        AuctionMapping.Decode(Subject, EventFactory.Bytes(wrongOccasion)).ShouldBeOfType<AuctionDecoded.Poison>();
        AuctionMapping.Decode(Subject, EventFactory.Bytes(wrongAuction)).ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_SetHasInvalidOrRepeatedIdentifiers_Expect_Poison()
    {
        var collectorInvalid = EventFactory.LotSetCollected(EventFactory.AuctionOfMeetup(), EventFactory.NewId(),
            "not-a-uuid", "Сервиз", EventFactory.NewId(), EventFactory.NewId());
        var setIdInvalid = EventFactory.LotSetCollected(EventFactory.AuctionOfMeetup(), EventFactory.NewId(),
            EventFactory.NewId(), "Сервиз", EventFactory.NewId(), EventFactory.NewId());
        setIdInvalid.LotSetCollected.LotSetId = "not-a-uuid";
        var lotInvalid = EventFactory.LotSetCollected(EventFactory.AuctionOfMeetup(), EventFactory.NewId(),
            EventFactory.NewId(), "Сервиз", EventFactory.NewId(), "not-a-uuid");
        var lotRepeatedId = EventFactory.NewId();
        var lotsRepeated = EventFactory.LotSetCollected(EventFactory.AuctionOfMeetup(), EventFactory.NewId(),
            EventFactory.NewId(), "Сервиз", lotRepeatedId, lotRepeatedId);
        var nameBlank = EventFactory.LotSetCollected(EventFactory.AuctionOfMeetup(), EventFactory.NewId(),
            EventFactory.NewId(), "  ", EventFactory.NewId(), EventFactory.NewId());
        var oneLot = EventFactory.LotSetCollected(EventFactory.AuctionOfMeetup(), EventFactory.NewId(),
            EventFactory.NewId(), "Сервиз", EventFactory.NewId());

        foreach (var message in new[] { collectorInvalid, setIdInvalid, lotInvalid, lotsRepeated, nameBlank, oneLot })
        {
            AuctionMapping.Decode(Subject, EventFactory.Bytes(message)).ShouldBeOfType<AuctionDecoded.Poison>();
        }
    }

    [Fact]
    public void When_PayloadBroken_Expect_Poison() =>
        AuctionMapping.Decode(Subject, new byte[] { 0xff }).ShouldBeOfType<AuctionDecoded.Poison>();
}
