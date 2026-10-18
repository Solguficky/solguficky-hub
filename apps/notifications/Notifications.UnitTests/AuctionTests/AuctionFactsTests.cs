using Notifications.Auction;
using Notifications.Infrastructure;
using Notifications.V1;
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
    public void When_DigestFactBuilt_Expect_WindowCauseAndLinesInOrder()
    {
        var recipient = Guid.CreateVersion7();
        var digestId = Guid.CreateVersion7();
        var first = Guid.CreateVersion7();
        var second = Guid.CreateVersion7();
        var price = new global::Auction.V1.Money { MinorUnits = 50000, Currency = "RUB" };
        var digest = new ClosedDigest(recipient, digestId,
        [
            new DigestLine(first, LotActivityKind.Outbid, true, price),
            new DigestLine(second, LotActivityKind.ProxyRaised, false, price),
        ]);
        var now = EventFactory.Committed;
        var fact = AuctionFacts.Digest(Guid.CreateVersion7(), digest, now, now.AddHours(24));
        fact.RecipientId.ShouldBe(recipient.ToString());
        fact.Cause.OutbidDigestId.ShouldBe(digestId.ToString());
        fact.LotActivityDigest.Lines.Select(line => (line.LotId, line.Kind, line.RecipientLeads)).ShouldBe(
        [
            (first.ToString(), LotActivityKind.Outbid, true),
            (second.ToString(), LotActivityKind.ProxyRaised, false),
        ]);
        fact.LotActivityDigest.Lines[0].CurrentPrice.ShouldBe(price);
        fact.LotActivityDigest.Lines[0].CurrentPrice.ShouldNotBeSameAs(price);
    }

    [Fact]
    public void When_DigestClosedBySale_Expect_SoldLotLinesCarrySalePriceAndNoLead()
    {
        var sold = Guid.CreateVersion7();
        var other = Guid.CreateVersion7();
        var bid = new global::Auction.V1.Money { MinorUnits = 40000, Currency = "RUB" };
        var sale = new global::Auction.V1.Money { MinorUnits = 45000, Currency = "RUB" };
        var digest = new ClosedDigest(Guid.CreateVersion7(), Guid.CreateVersion7(),
        [
            new DigestLine(sold, LotActivityKind.Outbid, true, bid),
            new DigestLine(other, LotActivityKind.Outbid, true, bid),
        ]);
        var closed = AuctionFacts.Sold(digest, sold, sale);
        closed.Lines.ShouldBe(
        [
            new DigestLine(sold, LotActivityKind.Outbid, false, sale),
            new DigestLine(other, LotActivityKind.Outbid, true, bid),
        ]);
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
