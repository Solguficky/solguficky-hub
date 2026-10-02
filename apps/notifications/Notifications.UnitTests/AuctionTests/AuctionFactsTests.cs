using Notifications.Auction;
using Notifications.TestKit;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.AuctionTests;

public class AuctionFactsTests
{
    [Fact]
    public void When_OutbidFactBuilt_Expect_AddressCausePriceAndExpiryWithoutRequestId()
    {
        var bid = AuctionMappingTests.Decode(EventFactory.Bid(EventFactory.NewId(), EventFactory.NewId(), proxy: true));
        var now = EventFactory.Committed;
        var id = Guid.CreateVersion7();
        var fact = AuctionFacts.Outbid(id, bid, now, now.AddHours(24));
        fact.NotificationId.ShouldBe(id.ToString());
        fact.RecipientId.ShouldBe(bid.PreviousLeader!.Value.ToString());
        fact.Cause.AuctionLotEventId.ShouldBe(bid.EventId.ToString());
        fact.LotOutbid.LotId.ShouldBe(bid.LotId.ToString());
        fact.LotOutbid.CurrentPrice.ShouldBe(bid.Price);
        DateTimeOffset.Parse(fact.CreatedAt).ShouldBe(now);
        DateTimeOffset.Parse(fact.NotAfter).ShouldBe(now.AddHours(24));
        fact.HasRequestId.ShouldBeFalse();
    }

    [Fact]
    public void When_BidHasNoOutbidRecipient_Expect_FactBuilderRefuses()
    {
        var bid = AuctionMappingTests.Decode(EventFactory.Bid(EventFactory.NewId()));
        Should.Throw<ArgumentException>(() => AuctionFacts.Outbid(Guid.CreateVersion7(), bid, EventFactory.Committed, EventFactory.Committed));
    }
}
