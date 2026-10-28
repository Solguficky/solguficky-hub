using Notifications.Auction;
using Notifications.Infrastructure;
using Notifications.TestKit;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.AuctionTests;

/// <summary>
/// Какое положение аукциона закрывает объявление (PER-780): скрытый, отменённый
/// и удалённый — да; видимый, прошедший и неизвестный — нет.
/// </summary>
public class AuctionStandingTests
{
    [Theory]
    [InlineData(AuctionStanding.Hidden, true)]
    [InlineData(AuctionStanding.Cancelled, true)]
    [InlineData(AuctionStanding.Discarded, true)]
    [InlineData(AuctionStanding.Visible, false)]
    [InlineData(AuctionStanding.Finished, false)]
    public void ClosedForNotice_Standing_MatchesRule(AuctionStanding standing, bool closed) =>
        AuctionStandingStore.ClosedForNotice(standing).ShouldBe(closed);

    [Fact]
    public void ClosedForNotice_UnknownAuction_IsOpen() =>
        AuctionStandingStore.ClosedForNotice(null).ShouldBeFalse();

    [Theory]
    [InlineData(AuctionEnd.Finished, AuctionStanding.Finished)]
    [InlineData(AuctionEnd.Cancelled, AuctionStanding.Cancelled)]
    [InlineData(AuctionEnd.Discarded, AuctionStanding.Discarded)]
    public void Of_End_GivesStanding(AuctionEnd end, AuctionStanding standing) =>
        AuctionStandingStore.Of(end).ShouldBe(standing);

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void Decode_AuctionDrafted_CarriesHiddenFromSnapshot(bool hidden)
    {
        var auction = EventFactory.AuctionOfMeetup();
        var fact = EventFactory.AuctionDrafted(auction, EventFactory.NewId(), hidden, version: 3);

        var decoded = AuctionMapping.Decode("events.auction.auction_drafted", EventFactory.Bytes(fact))
            .ShouldBeOfType<AuctionDecoded.Announcement>();

        decoded.Value.Occasion.ShouldBe(AnnouncementOccasion.Drafted);
        decoded.Value.Hidden.ShouldBe(hidden);
        decoded.Value.Version.ShouldBe(3);
    }

    [Fact]
    public void Decode_AuctionDraftedNotDraft_IsPoison()
    {
        var fact = EventFactory.AuctionDrafted(EventFactory.AuctionOfMeetup(), EventFactory.NewId());
        fact.State.Scheduled = new global::Auction.V1.AuctionState.Types.Scheduled();

        AuctionMapping.Decode("events.auction.auction_drafted", EventFactory.Bytes(fact))
            .ShouldBeOfType<AuctionDecoded.Poison>();
    }
}
