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
    public void When_AuctionBornAtMeetup_Expect_UuidV5AuctionAccepted()
    {
        var message = EventFactory.Bid(EventFactory.NewId(), EventFactory.NewId());
        message.State.AuctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
        Decode(message).LotId.ShouldBe(Guid.Parse(message.LotId));
    }

    [Fact]
    public void When_LeaderProxyRaisesPriceOnOwnCommand_Expect_NoRecipient()
    {
        var leader = EventFactory.NewId();
        var bid = Decode(EventFactory.Bid(EventFactory.NewId(), leader, leader, proxy: true));
        bid.OutbidRecipient.ShouldBeNull();
        bid.ProxyRaisedRecipient.ShouldBeNull();
    }

    [Fact]
    public void When_LeaderProxyAnswersRivalLimit_Expect_LeaderAddressedAndNoOutbid()
    {
        var leader = EventFactory.NewId();
        var bid = Decode(EventFactory.Bid(EventFactory.NewId(), leader, leader, proxy: true, answers: true));
        bid.OutbidRecipient.ShouldBeNull();
        bid.ProxyRaisedRecipient.ShouldBe(Guid.Parse(leader));
    }

    [Fact]
    public void When_LeaderProxyAnswersRivalBid_Expect_LeaderAndRivalBothAddressed()
    {
        var rival = EventFactory.NewId();
        var leader = EventFactory.NewId();
        var bid = Decode(EventFactory.Bid(EventFactory.NewId(), rival, leader, proxy: true, answers: true));
        bid.OutbidRecipient.ShouldBe(Guid.Parse(rival));
        bid.ProxyRaisedRecipient.ShouldBe(Guid.Parse(leader));
    }

    [Fact]
    public void When_ManualBidOvertakenInSameCommand_Expect_PreviousLeaderNotOutbid()
    {
        var bid = Decode(EventFactory.Bid(EventFactory.NewId(), EventFactory.NewId(), overtaken: true));
        bid.OutbidRecipient.ShouldBeNull();
        bid.ProxyRaisedRecipient.ShouldBeNull();
    }

    [Theory]
    [InlineData(true, true)]
    [InlineData(false, false)]
    public void When_TransactionFlagContradictsOrigin_Expect_Poison(bool proxy, bool overtaken)
    {
        var message = EventFactory.Bid(EventFactory.NewId(), EventFactory.NewId(), proxy: proxy,
            overtaken: overtaken, answers: !overtaken);
        AuctionMapping.Decode(AuctionFeed.BidPlacedSubject, EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Theory]
    [InlineData("events.auction.auction_scheduled")]
    [InlineData("events.auction.lot_added")]
    [InlineData("events.auction.invoice_issued")]
    [InlineData("events.auction.future_occasion")]
    public void When_NotLotSubject_Expect_NotParsedAsLotEvent(string subject) =>
        AuctionMapping.Decode(subject, new byte[] { 0xff }).ShouldBeOfType<AuctionDecoded.Ignored>();

    [Theory]
    [InlineData("events.auction.lot_unsold")]
    [InlineData("events.auction.lot_opened")]
    public void When_LotSubjectCarriesBrokenProtobuf_Expect_Poison(string subject) =>
        AuctionMapping.Decode(subject, new byte[] { 0xff }).ShouldBeOfType<AuctionDecoded.Poison>();

    /// <summary>Каждый факт лота без повода ведёт реплику: снимок, а не факт уведомления.</summary>
    [Theory]
    [InlineData("events.auction.lot_drafted", LotStatus.Draft)]
    [InlineData("events.auction.lot_opened", LotStatus.Trading)]
    [InlineData("events.auction.ask_advanced", LotStatus.Trading)]
    [InlineData("events.auction.deadline_extended", LotStatus.Trading)]
    [InlineData("events.auction.lot_resumed", LotStatus.Trading)]
    [InlineData("events.auction.lot_unsold", LotStatus.Unsold)]
    [InlineData("events.auction.lot_withdrawn", LotStatus.Withdrawn)]
    [InlineData("events.auction.lot_held_for_final", LotStatus.Held)]
    public void When_LotFactWithoutCause_Expect_SnapshotOfItsStatus(string subject, LotStatus status)
    {
        var lotId = EventFactory.NewId();
        var occasion = subject["events.auction.".Length..];
        var message = occasion switch
        {
            "lot_drafted" => EventFactory.Drafted(lotId),
            "lot_unsold" => EventFactory.Unsold(lotId),
            "lot_withdrawn" => EventFactory.Withdrawn(lotId),
            "lot_held_for_final" => EventFactory.HeldForFinal(lotId),
            _ => EventFactory.Trading(lotId, occasion),
        };

        var fact = AuctionMapping.Decode(subject, EventFactory.Bytes(message)).ShouldBeOfType<AuctionDecoded.Lot>().Value;

        fact.EventId.ShouldBe(Guid.Parse(message.EventId));
        fact.Snapshot.LotId.ShouldBe(Guid.Parse(lotId));
        fact.Snapshot.Version.ShouldBe(message.Version);
        fact.Snapshot.Status.ShouldBe(status);
        fact.Snapshot.Terminal.ShouldBe(status is LotStatus.Unsold or LotStatus.Withdrawn);
    }

    [Fact]
    public void When_TradingSnapshotHasDeadlineAndLeader_Expect_BothInSnapshot()
    {
        var leader = EventFactory.NewId();
        var message = EventFactory.Trading(EventFactory.NewId(), "deadline_extended", deadline: EventFactory.Deadline(90),
            leader: leader);

        var snapshot = AuctionMapping.Decode("events.auction.deadline_extended", EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Lot>().Value.Snapshot;

        snapshot.Deadline.ShouldBe(EventFactory.Committed.AddMinutes(90));
        snapshot.Leader.ShouldBe(Guid.Parse(leader));
    }

    /// <summary>Лот, который ведёт человек, дедлайна не несёт: это не ошибка снимка.</summary>
    [Fact]
    public void When_TradingSnapshotWithoutDeadlineOrLeader_Expect_EmptyFields()
    {
        var snapshot = AuctionMapping.Decode("events.auction.lot_opened",
                EventFactory.Bytes(EventFactory.Trading(EventFactory.NewId(), "lot_opened")))
            .ShouldBeOfType<AuctionDecoded.Lot>().Value.Snapshot;

        snapshot.Deadline.ShouldBeNull();
        snapshot.Leader.ShouldBeNull();
    }

    [Fact]
    public void When_HeldForFinal_Expect_LeaderWithoutDeadline()
    {
        var message = EventFactory.HeldForFinal(EventFactory.NewId());

        var snapshot = AuctionMapping.Decode("events.auction.lot_held_for_final", EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Lot>().Value.Snapshot;

        snapshot.Leader.ShouldBe(Guid.Parse(message.State.Held.LeaderId));
        snapshot.Deadline.ShouldBeNull();
    }

    [Fact]
    public void When_BidCarriesDeadline_Expect_SnapshotWithLeaderAndDeadline()
    {
        var leader = EventFactory.NewId();
        var bid = Decode(EventFactory.Bid(EventFactory.NewId(), leader: leader, deadline: EventFactory.Deadline(60)));

        var snapshot = bid.Snapshot.ShouldNotBeNull();
        snapshot.Status.ShouldBe(LotStatus.Trading);
        snapshot.Leader.ShouldBe(Guid.Parse(leader));
        snapshot.Deadline.ShouldBe(EventFactory.Committed.AddMinutes(60));
        snapshot.Version.ShouldBe(bid.Version);
    }

    [Fact]
    public void When_LotSold_Expect_TerminalSnapshotLedByWinner()
    {
        var winner = EventFactory.NewId();

        var snapshot = DecodeSale(EventFactory.Sold(EventFactory.NewId(), winner)).Snapshot.ShouldNotBeNull();

        snapshot.Status.ShouldBe(LotStatus.Sold);
        snapshot.Terminal.ShouldBeTrue();
        snapshot.Leader.ShouldBe(Guid.Parse(winner));
    }

    /// <summary>Кривой дедлайн снимка не стоит перебитому сообщения: повод остаётся, реплики нет.</summary>
    [Fact]
    public void When_BidSnapshotDeadlineInvalid_Expect_CauseKeptWithoutSnapshot()
    {
        var previous = EventFactory.NewId();
        var bid = Decode(EventFactory.Bid(EventFactory.NewId(), previous, deadline: "tomorrow"));

        bid.OutbidRecipient.ShouldBe(Guid.Parse(previous));
        bid.Snapshot.ShouldBeNull();
    }

    [Theory]
    [InlineData("deadline")]
    [InlineData("leader")]
    [InlineData("status")]
    [InlineData("state")]
    [InlineData("state_id")]
    [InlineData("occasion")]
    [InlineData("version")]
    public void When_LotSnapshotInvalid_Expect_Poison(string field)
    {
        var message = EventFactory.Trading(EventFactory.NewId(), "deadline_extended", deadline: EventFactory.Deadline(30),
            leader: EventFactory.NewId());
        switch (field)
        {
            case "deadline": message.State.Trading.Deadline = "tomorrow"; break;
            case "leader": message.State.Trading.LeaderId = "bad"; break;
            case "status": message.State.ClearStatus(); break;
            case "state": message.State = null; break;
            case "state_id": message.State.Id = EventFactory.NewId(); break;
            case "occasion": message.LotOpened = new LotOpened(); break;
            case "version": message.Version = 0; break;
            default: throw new ArgumentOutOfRangeException(nameof(field));
        }

        AuctionMapping.Decode("events.auction.deadline_extended", EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_LotSold_Expect_WinnerAddressedWithSalePrice()
    {
        var winner = EventFactory.NewId();
        var message = EventFactory.Sold(EventFactory.NewId(), winner);
        var sale = DecodeSale(message);
        sale.Winner.ShouldBe(Guid.Parse(winner));
        sale.Price.ShouldBe(message.State.Sold.Price);
        sale.EventId.ShouldBe(Guid.Parse(message.EventId));
        sale.LotId.ShouldBe(Guid.Parse(message.LotId));
        sale.Version.ShouldBe(message.Version);
    }

    // Auction сегодня не выставляет config у проданного лота; продажа из-за
    // этого не должна стать ядом и потеряться без повтора.
    [Fact]
    public void When_SoldStateHasNoConfig_Expect_SaleAccepted() =>
        DecodeSale(EventFactory.Sold(EventFactory.NewId(), config: false)).Price.Currency.ShouldBe("RUB");

    // Instant.toString производителя на наносекундных часах пишет девять
    // знаков дроби; DateTimeOffset держит семь.
    [Fact]
    public void When_SaleInstantsHaveNanoseconds_Expect_SaleAcceptedTruncatedToTicks()
    {
        var message = EventFactory.Sold(EventFactory.NewId());
        message.OccurredAt = "2026-10-03T12:00:00.123456789Z";
        message.State.Sold.SoldAt = "2026-10-03T12:00:00.123456789Z";
        DecodeSale(message).OccurredAt.ShouldBe(new DateTimeOffset(2026, 10, 3, 12, 0, 0, TimeSpan.Zero).AddTicks(1234567));
    }

    [Fact]
    public void When_BidInstantHasNanoseconds_Expect_BidAccepted()
    {
        var message = EventFactory.Bid(EventFactory.NewId(), EventFactory.NewId());
        message.OccurredAt = "2026-10-03T12:00:00.123456789Z";
        Decode(message).OccurredAt.ShouldBe(new DateTimeOffset(2026, 10, 3, 12, 0, 0, TimeSpan.Zero).AddTicks(1234567));
    }

    [Fact]
    public void When_BrokenSoldProtobuf_Expect_Poison() =>
        AuctionMapping.Decode(AuctionFeed.LotSoldSubject, new byte[] { 0xff }).ShouldBeOfType<AuctionDecoded.Poison>();

    [Theory]
    [InlineData("event_id")]
    [InlineData("version")]
    [InlineData("occurred_at")]
    [InlineData("occasion")]
    [InlineData("state")]
    [InlineData("state_id")]
    [InlineData("auction_id")]
    [InlineData("status")]
    [InlineData("winner")]
    [InlineData("winner_version")]
    [InlineData("bid_id")]
    [InlineData("price")]
    [InlineData("negative_price")]
    [InlineData("currency")]
    [InlineData("config_currency")]
    [InlineData("sold_at")]
    [InlineData("sold_at_non_utc")]
    public void When_RequiredSaleFieldInvalid_Expect_Poison(string field)
    {
        var message = EventFactory.Sold(EventFactory.NewId());
        switch (field)
        {
            case "event_id": message.EventId = "bad"; break;
            case "version": message.Version = 0; break;
            case "occurred_at": message.OccurredAt = "2026-09-01"; break;
            case "occasion": message.LotUnsold = new LotUnsold(); break;
            case "state": message.State = null; break;
            case "state_id": message.State.Id = EventFactory.NewId(); break;
            case "auction_id": message.State.AuctionId = ""; break;
            case "status": message.State.Unsold = UnsoldReason.NoBids; break;
            case "winner": message.State.Sold.WinnerId = ""; break;
            case "winner_version": message.State.Sold.WinnerId = Guid.NewGuid().ToString(); break;
            case "bid_id": message.State.Sold.BidId = "bad"; break;
            case "price": message.State.Sold.Price = null; break;
            case "negative_price": message.State.Sold.Price.MinorUnits = -1; break;
            case "currency": message.State.Sold.Price.Currency = "rub"; break;
            case "config_currency": message.State.Config.Currency = "EUR"; break;
            case "sold_at": message.State.Sold.SoldAt = ""; break;
            case "sold_at_non_utc": message.State.Sold.SoldAt = "2026-09-01T12:00:00+03:00"; break;
            default: throw new ArgumentOutOfRangeException(nameof(field));
        }
        AuctionMapping.Decode(AuctionFeed.LotSoldSubject, EventFactory.Bytes(message)).ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_BidPayloadArrivesOnLotSoldSubject_Expect_Poison() =>
        AuctionMapping.Decode(AuctionFeed.LotSoldSubject, EventFactory.Bytes(EventFactory.Bid(EventFactory.NewId(), EventFactory.NewId())))
            .ShouldBeOfType<AuctionDecoded.Poison>();

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
    [InlineData("auction_id_version")]
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
            case "auction_id_version": message.State.AuctionId = Guid.NewGuid().ToString(); break;
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

    internal static AuctionSale DecodeSale(LotEvent message) =>
        AuctionMapping.Decode(AuctionFeed.LotSoldSubject, EventFactory.Bytes(message)).ShouldBeOfType<AuctionDecoded.Sale>().Value;
}
