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
    public void When_PurchaseFactBuilt_Expect_WinnerCauseLotPriceAndExpiryWithoutRequestId()
    {
        var sale = AuctionMappingTests.DecodeSale(EventFactory.Sold(EventFactory.NewId()));
        var now = EventFactory.Committed;
        var id = Guid.CreateVersion7();
        var fact = AuctionFacts.Purchased(id, sale, now, now.AddHours(24));
        fact.NotificationId.ShouldBe(id.ToString());
        fact.RecipientId.ShouldBe(sale.Winner.ToString());
        fact.Cause.AuctionLotEventId.ShouldBe(sale.EventId.ToString());
        fact.LotPurchased.LotId.ShouldBe(sale.LotId.ToString());
        fact.LotPurchased.Price.ShouldBe(sale.Price);
        DateTimeOffset.Parse(fact.CreatedAt).ShouldBe(now);
        DateTimeOffset.Parse(fact.NotAfter).ShouldBe(now.AddHours(24));
        fact.HasRequestId.ShouldBeFalse();
    }

    [Fact]
    public void When_ProxyRaisedFactBuilt_Expect_LeaderCausePriceAndExpiryWithoutRequestId()
    {
        var leader = EventFactory.NewId();
        var bid = AuctionMappingTests.Decode(EventFactory.Bid(EventFactory.NewId(), EventFactory.NewId(), leader,
            proxy: true, answers: true));
        var now = EventFactory.Committed;
        var id = Guid.CreateVersion7();
        var fact = AuctionFacts.ProxyRaised(id, bid, now, now.AddHours(24));
        fact.NotificationId.ShouldBe(id.ToString());
        fact.RecipientId.ShouldBe(leader);
        fact.Cause.AuctionLotEventId.ShouldBe(bid.EventId.ToString());
        fact.LotProxyRaised.LotId.ShouldBe(bid.LotId.ToString());
        fact.LotProxyRaised.CurrentPrice.ShouldBe(bid.Price);
        DateTimeOffset.Parse(fact.CreatedAt).ShouldBe(now);
        DateTimeOffset.Parse(fact.NotAfter).ShouldBe(now.AddHours(24));
        fact.HasRequestId.ShouldBeFalse();
    }

    [Fact]
    public void When_BidDidNotAnswerAnotherBidder_Expect_ProxyRaisedBuilderRefuses()
    {
        var bid = AuctionMappingTests.Decode(EventFactory.Bid(EventFactory.NewId(), EventFactory.NewId(), proxy: true));
        Should.Throw<ArgumentException>(() => AuctionFacts.ProxyRaised(Guid.CreateVersion7(), bid, EventFactory.Committed, EventFactory.Committed));
    }

    [Fact]
    public void When_BidHasNoOutbidRecipient_Expect_FactBuilderRefuses()
    {
        var bid = AuctionMappingTests.Decode(EventFactory.Bid(EventFactory.NewId()));
        Should.Throw<ArgumentException>(() => AuctionFacts.Outbid(Guid.CreateVersion7(), bid, EventFactory.Committed, EventFactory.Committed));
    }
}
