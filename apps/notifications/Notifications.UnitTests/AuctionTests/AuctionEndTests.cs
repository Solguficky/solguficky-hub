using Auction.V1;
using Notifications.Auction;
using Notifications.Infrastructure;
using Notifications.TestKit;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.AuctionTests;

/// <summary>
/// Конец аукциона для избранного и извещение об отмене (PER-604): разбор
/// конца по снимку, аукцион и цена продажи в снимке лота, адресаты отмены.
/// </summary>
public class AuctionEndTests
{
    private const string CancelledSubject = "events.auction.auction_cancelled";
    private const string DiscardedSubject = "events.auction.auction_discarded";
    private const string PrebiddingEndedSubject = "events.auction.prebidding_ended";

    [Fact]
    public void When_PrebiddingEndsFinished_Expect_FinishedWithRegistry()
    {
        var auction = EventFactory.AuctionOfMeetup();
        var meetup = EventFactory.NewId();
        var lots = new[] { EventFactory.NewId(), EventFactory.NewId() };

        var closed = AuctionMapping.Decode(PrebiddingEndedSubject,
                EventFactory.Bytes(EventFactory.PrebiddingFinished(auction, meetup, lots)))
            .ShouldBeOfType<AuctionDecoded.Closed>().Value;

        closed.End.ShouldBe(AuctionEnd.Finished);
        closed.AuctionId.ShouldBe(Guid.Parse(auction));
        closed.MeetupId.ShouldBe(Guid.Parse(meetup));
        closed.Registry.ShouldBe(lots.Select(Guid.Parse).ToArray());
    }

    [Fact]
    public void When_AuctionCancelled_Expect_Cancelled()
    {
        var message = EventFactory.AuctionCancelled(EventFactory.AuctionOfMeetup(), EventFactory.NewId(),
            EventFactory.NewId());

        var closed = AuctionMapping.Decode(CancelledSubject, EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Closed>().Value;

        closed.End.ShouldBe(AuctionEnd.Cancelled);
        closed.EventId.ShouldBe(Guid.Parse(message.EventId));
    }

    [Fact]
    public void When_AuctionDiscarded_Expect_DiscardedWithRegistry()
    {
        var lot = EventFactory.NewId();

        var closed = AuctionMapping.Decode(DiscardedSubject,
                EventFactory.Bytes(EventFactory.AuctionDiscarded(EventFactory.AuctionOfMeetup(), EventFactory.NewId(), lot)))
            .ShouldBeOfType<AuctionDecoded.Closed>().Value;

        closed.End.ShouldBe(AuctionEnd.Discarded);
        closed.Registry.ShouldBe([Guid.Parse(lot)]);
    }

    /// <summary>Признак конца — снимок, а не имя факта: отмена со снимком торгов — яд.</summary>
    [Fact]
    public void When_CancelledStateIsNotCancelled_Expect_Poison()
    {
        var message = EventFactory.AuctionCancelled(EventFactory.AuctionOfMeetup(), EventFactory.NewId());
        message.State.Prebidding = new AuctionState.Types.Prebidding();

        AuctionMapping.Decode(CancelledSubject, EventFactory.Bytes(message)).ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_DiscardedStateIsNotDiscarded_Expect_Poison()
    {
        var message = EventFactory.AuctionDiscarded(EventFactory.AuctionOfMeetup(), EventFactory.NewId());
        message.State.Draft = new AuctionState.Types.Draft();

        AuctionMapping.Decode(DiscardedSubject, EventFactory.Bytes(message)).ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_RegistryLotRepeated_Expect_Poison()
    {
        var lot = EventFactory.NewId();
        var message = EventFactory.AuctionCancelled(EventFactory.AuctionOfMeetup(), EventFactory.NewId(), lot, lot);

        AuctionMapping.Decode(CancelledSubject, EventFactory.Bytes(message)).ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_LotFactDecoded_Expect_SnapshotCarriesAuction()
    {
        var auction = EventFactory.AuctionOfMeetup();
        var message = EventFactory.Trading(EventFactory.NewId(), "lot_opened", deadline: EventFactory.Deadline(60));
        message.State.AuctionId = auction;

        var fact = AuctionMapping.Decode("events.auction.lot_opened", EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Lot>().Value;

        fact.Snapshot.AuctionId.ShouldBe(Guid.Parse(auction));
        fact.Snapshot.SalePrice.ShouldBeNull();
    }

    [Fact]
    public void When_SaleDecoded_Expect_AuctionAndSalePriceInSnapshot()
    {
        var auction = EventFactory.AuctionOfMeetup();
        var message = EventFactory.Sold(EventFactory.NewId());
        message.State.AuctionId = auction;

        var sale = AuctionMapping.Decode(AuctionFeed.LotSoldSubject, EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Sale>().Value;

        sale.AuctionId.ShouldBe(Guid.Parse(auction));
        sale.Snapshot.ShouldNotBeNull().SalePrice.ShouldBe(message.State.Sold.Price);
    }

    /// <summary>Тот, кто ставил на трёх лотах, — один адресат, а не три.</summary>
    [Fact]
    public void When_PersonFollowedThreeLots_Expect_OneRecipient()
    {
        var person = Guid.CreateVersion7();
        var lots = Enumerable.Range(0, 3)
            .Select(_ => new EndedLot(Guid.CreateVersion7(), LotStatus.Withdrawn, person, null))
            .ToArray();

        var audience = AuctionFacts.CancellationAudience([person], lots);

        audience.Count.ShouldBe(1);
        audience[0].Recipient.ShouldBe(person);
        audience[0].Purchases.ShouldBeEmpty();
    }

    /// <summary>Покупатель без отметки — тоже адресат; его покупки — только его.</summary>
    [Fact]
    public void When_BuyerBoughtLot_Expect_OwnPurchasesOnly()
    {
        var follower = Guid.CreateVersion7();
        var buyer = Guid.CreateVersion7();
        var price = new Money { MinorUnits = 45600, Currency = "RUB" };
        var sold = new EndedLot(Guid.CreateVersion7(), LotStatus.Sold, buyer, price);
        var withdrawn = new EndedLot(Guid.CreateVersion7(), LotStatus.Withdrawn, follower, null);

        var audience = AuctionFacts.CancellationAudience([follower], [sold, withdrawn])
            .ToDictionary(entry => entry.Recipient, entry => entry.Purchases);

        audience.Keys.ShouldBe([follower, buyer], ignoreOrder: true);
        audience[buyer].ShouldBe([sold]);
        audience[follower].ShouldBeEmpty();
    }

    /// <summary>Покупатель лота, реплика которого записана без цены, — адресат без строки покупки.</summary>
    [Fact]
    public void When_SoldReplicaHasNoPrice_Expect_BuyerWithoutPurchases()
    {
        var buyer = Guid.CreateVersion7();
        var legacy = new EndedLot(Guid.CreateVersion7(), LotStatus.Sold, buyer, null);

        var audience = AuctionFacts.CancellationAudience([], [legacy]);

        audience.ShouldHaveSingleItem().Recipient.ShouldBe(buyer);
        audience[0].Purchases.ShouldBeEmpty();
    }

    [Fact]
    public void When_CancellationBuilt_Expect_CauseIsCancellationAndPurchasesWithPrice()
    {
        var recipient = Guid.CreateVersion7();
        var auction = Guid.CreateVersion7();
        var meetup = Guid.CreateVersion7();
        var cancellation = Guid.CreateVersion7();
        var lot = new EndedLot(Guid.CreateVersion7(), LotStatus.Sold, recipient,
            new Money { MinorUnits = 45600, Currency = "RUB" });

        var fact = AuctionFacts.Cancellation(Guid.CreateVersion7(), recipient, auction, meetup, cancellation, [lot],
            EventFactory.Committed, EventFactory.Committed.AddHours(24));

        fact.RecipientId.ShouldBe(recipient.ToString());
        fact.Cause.AuctionEventId.ShouldBe(cancellation.ToString());
        fact.AuctionCancelled.AuctionId.ShouldBe(auction.ToString());
        fact.AuctionCancelled.MeetupId.ShouldBe(meetup.ToString());
        fact.AuctionCancelled.Purchases.Single().LotId.ShouldBe(lot.LotId.ToString());
        fact.AuctionCancelled.Purchases.Single().Price.ShouldBe(lot.SalePrice);
    }
}
