using Auction.V1;
using Notifications.Auction;
using Notifications.TestKit;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.AuctionTests;

public class AuctionMappingTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void When_LeaderChanges_Expect_PreviousLeaderAddressedWithFinalPrice(bool proxy)
    {
        var previous = EventFactory.NewId();
        var message = EventFactory.Bid(EventFactory.NewId(), previous, proxy: proxy);
        var bid = Decode(message);
        bid.OutbidRecipient.ShouldBe(Guid.Parse(previous));
        bid.Price.ShouldBe(message.State.Trading.CurrentPrice);
        bid.EventId.ShouldBe(Guid.Parse(message.EventId));
        bid.LotId.ShouldBe(Guid.Parse(message.LotId));
    }

    [Fact]
    public void When_FirstBid_Expect_NoRecipient() =>
        Decode(EventFactory.Bid(EventFactory.NewId())).OutbidRecipient.ShouldBeNull();

    [Theory]
    [InlineData("2026-10-03T12:00:00Z")]
    [InlineData("2026-10-03T12:00:00.1234567Z")]
    public void When_UtcTimestampUsesZuluSuffix_Expect_UtcInstant(string timestamp)
    {
        var message = EventFactory.Bid(EventFactory.NewId(), EventFactory.NewId());
        message.OccurredAt = timestamp;
        var bid = Decode(message);
        bid.OccurredAt.Offset.ShouldBe(TimeSpan.Zero);
        bid.OccurredAt.ShouldBe(DateTimeOffset.Parse(timestamp, System.Globalization.CultureInfo.InvariantCulture));
    }

    [Fact]
    public void When_LeaderProxyRaisesPrice_Expect_NoRecipient()
    {
        var leader = EventFactory.NewId();
        Decode(EventFactory.Bid(EventFactory.NewId(), leader, leader, proxy: true)).OutbidRecipient.ShouldBeNull();
    }

    [Theory]
    [InlineData("events.auction.auction_scheduled")]
    [InlineData("events.auction.lot_sold")]
    [InlineData("events.auction.future_occasion")]
    public void When_UnrelatedSubject_Expect_NotParsedAsLotEvent(string subject) =>
        AuctionMapping.Decode(subject, new byte[] { 0xff }).ShouldBeOfType<AuctionDecoded.Ignored>();

    [Fact]
    public void When_BrokenProtobuf_Expect_Poison() =>
        AuctionMapping.Decode(AuctionFeed.BidPlacedSubject, new byte[] { 0xff }).ShouldBeOfType<AuctionDecoded.Poison>();

    [Theory]
    [InlineData("event_id")]
    [InlineData("uuid_version")]
    [InlineData("lot_id")]
    [InlineData("version")]
    [InlineData("occurred_at")]
    [InlineData("non_utc")]
    [InlineData("occasion")]
    [InlineData("state")]
    [InlineData("state_id")]
    [InlineData("auction_id")]
    [InlineData("status")]
    [InlineData("leader")]
    [InlineData("bid_id")]
    [InlineData("price")]
    [InlineData("negative_price")]
    [InlineData("currency")]
    [InlineData("config_currency")]
    [InlineData("phase")]
    [InlineData("origin")]
    [InlineData("manual_source")]
    [InlineData("previous_empty")]
    [InlineData("previous_zero")]
    public void When_RequiredBidFieldInvalid_Expect_Poison(string field)
    {
        var message = EventFactory.Bid(EventFactory.NewId(), EventFactory.NewId());
        switch (field)
        {
            case "event_id": message.EventId = "bad"; break;
            case "uuid_version": message.EventId = Guid.NewGuid().ToString(); break;
            case "lot_id": message.LotId = "bad"; break;
            case "version": message.Version = 0; break;
            case "occurred_at": message.OccurredAt = "2026-09-01"; break;
            case "non_utc": message.OccurredAt = "2026-09-01T12:00:00+03:00"; break;
            case "occasion": message.LotOpened = new LotOpened(); break;
            case "state": message.State = null; break;
            case "state_id": message.State.Id = EventFactory.NewId(); break;
            case "auction_id": message.State.AuctionId = ""; break;
            case "status": message.State.Draft = new LotDraft(); break;
            case "leader": message.State.Trading.ClearLeaderId(); break;
            case "bid_id": message.State.Trading.LeadingBidId = ""; break;
            case "price": message.State.Trading.CurrentPrice = null; break;
            case "negative_price": message.State.Trading.CurrentPrice.MinorUnits = -1; break;
            case "currency": message.State.Trading.CurrentPrice.Currency = "rub"; break;
            case "config_currency": message.State.Config.Currency = "EUR"; break;
            case "phase": message.State.Trading.Phase = (LotPhase)999; break;
            case "origin": message.BidPlaced.ClearOrigin(); break;
            case "manual_source": message.BidPlaced.Manual.Source = (BidSource)999; break;
            case "previous_empty": message.BidPlaced.PreviousLeaderId = ""; break;
            case "previous_zero": message.BidPlaced.PreviousLeaderId = Guid.Empty.ToString(); break;
            default: throw new ArgumentOutOfRangeException(nameof(field));
        }
        AuctionMapping.Decode(AuctionFeed.BidPlacedSubject, EventFactory.Bytes(message)).ShouldBeOfType<AuctionDecoded.Poison>();
    }

    internal static AuctionBid Decode(LotEvent message) =>
        AuctionMapping.Decode(AuctionFeed.BidPlacedSubject, EventFactory.Bytes(message)).ShouldBeOfType<AuctionDecoded.Bid>().Value;
}
