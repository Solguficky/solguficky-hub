using Notifications.Auction;
using Notifications.TestKit;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.AuctionTests;

/// <summary>
/// Разбор факта снятия участника (ADR-072, п. 5, PER-672): новый лидер, цена и
/// дефекты, которые делают факт ядом.
/// </summary>
public class AuctionRemovalTests
{
    [Fact]
    public void When_RemovalChangesLead_Expect_NewLeaderAddressedWithPriceAfterRemoval()
    {
        var removed = EventFactory.NewId();
        var leader = EventFactory.NewId();
        var message = EventFactory.ParticipantRemoved(EventFactory.NewId(), removed, leader);
        var removal = DecodeRemoval(message);
        removal.RestoredRecipient.ShouldBe(Guid.Parse(leader));
        removal.PreviousLeader.ShouldBe(Guid.Parse(removed));
        removal.Snapshot.Leader.ShouldBe(Guid.Parse(leader));
        removal.Price.ShouldBe(message.State.Trading.CurrentPrice);
        removal.EventId.ShouldBe(Guid.Parse(message.EventId));
        removal.Snapshot.LotId.ShouldBe(Guid.Parse(message.LotId));
    }

    [Fact]
    public void When_RemovalKeepsTheLeader_Expect_NoRecipient()
    {
        var leader = EventFactory.NewId();
        DecodeRemoval(EventFactory.ParticipantRemoved(EventFactory.NewId(), leader, leader)).RestoredRecipient.ShouldBeNull();
    }

    [Fact]
    public void When_RemovalLeavesTheLotWithoutLeader_Expect_NoRecipient()
    {
        var removal = DecodeRemoval(EventFactory.ParticipantRemoved(EventFactory.NewId(), EventFactory.NewId()));
        removal.Snapshot.Leader.ShouldBeNull();
        removal.RestoredRecipient.ShouldBeNull();
    }

    [Fact]
    public void When_RemovalHappensInHeldLot_Expect_NewLeaderAddressedWithHeldPrice()
    {
        var removed = EventFactory.NewId();
        var leader = EventFactory.NewId();
        var message = EventFactory.ParticipantRemoved(EventFactory.NewId(), removed, leader, held: true, price: 7700);
        var removal = DecodeRemoval(message);
        removal.Snapshot.Status.ShouldBe(LotStatus.Held);
        removal.RestoredRecipient.ShouldBe(Guid.Parse(leader));
        removal.Price.ShouldBe(message.State.Held.CurrentPrice);
        removal.Price!.MinorUnits.ShouldBe(7700);
    }

    [Fact]
    public void When_PreviousLeaderIsNotCanonical_Expect_Poison()
    {
        var message = EventFactory.ParticipantRemoved(EventFactory.NewId(), "not-a-uuid", EventFactory.NewId());
        Decode(message).ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Theory]
    [InlineData("draft")]
    [InlineData("scheduled")]
    public void When_LotIsNotTradingNorHeld_Expect_Poison(string status)
    {
        var message = EventFactory.ParticipantRemoved(EventFactory.NewId(), EventFactory.NewId(), EventFactory.NewId());
        message.State.Trading = null;
        if (status == "draft") message.State.Draft = new global::Auction.V1.LotDraft();
        else message.State.Scheduled = new global::Auction.V1.LotSchedule();
        Decode(message).ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_PriceIsNegative_Expect_Poison()
    {
        var message = EventFactory.ParticipantRemoved(EventFactory.NewId(), EventFactory.NewId(), EventFactory.NewId(),
            price: -1);
        Decode(message).ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_SnapshotLeaderIsBroken_Expect_Poison()
    {
        var message = EventFactory.ParticipantRemoved(EventFactory.NewId(), EventFactory.NewId(), EventFactory.NewId());
        message.State.Trading.LeaderId = "";
        Decode(message).ShouldBeOfType<AuctionDecoded.Poison>();
    }

    private static AuctionDecoded Decode(global::Auction.V1.LotEvent message) =>
        AuctionMapping.Decode(AuctionFeed.ParticipantRemovedSubject, EventFactory.Bytes(message));

    private static AuctionRemoval DecodeRemoval(global::Auction.V1.LotEvent message) =>
        Decode(message).ShouldBeOfType<AuctionDecoded.Removal>().Value;
}
