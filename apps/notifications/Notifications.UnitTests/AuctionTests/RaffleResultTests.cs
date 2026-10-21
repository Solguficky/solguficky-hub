using Notifications.Auction;
using Notifications.TestKit;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.AuctionTests;

/// <summary>Разбор жеребьёвки розыгрыша и форма итога владельцу билета (PER-620).</summary>
public class RaffleResultTests
{
    private const string Subject = AuctionFeed.RaffleDrawnSubject;

    [Fact]
    public void When_RaffleDrawn_Expect_TicketsInOrderAndWinningTicket()
    {
        var auction = EventFactory.AuctionOfMeetup();
        var holders = new[] { EventFactory.NewId(), EventFactory.NewId(), EventFactory.NewId() };
        var message = EventFactory.RaffleDrawn(auction, 2, holders);

        var draw = AuctionMapping.Decode(Subject, EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Raffle>().Value;

        draw.EventId.ShouldBe(Guid.Parse(message.EventId));
        draw.AuctionId.ShouldBe(Guid.Parse(auction));
        draw.Version.ShouldBe(message.Version);
        draw.Tickets.ShouldBe(holders.Select(Guid.Parse).ToArray());
        draw.WinningTicket.ShouldBe(2);
    }

    [Fact]
    public void When_ResultBuilt_Expect_OwnTicketWinningTicketAndCount()
    {
        var holders = new[] { EventFactory.NewId(), EventFactory.NewId() };
        var draw = AuctionMapping.Decode(Subject,
                EventFactory.Bytes(EventFactory.RaffleDrawn(EventFactory.AuctionOfMeetup(), 1, holders)))
            .ShouldBeOfType<AuctionDecoded.Raffle>().Value;

        var fact = AuctionFacts.RaffleResult(Guid.CreateVersion7(), draw.Tickets[1], 2, draw, EventFactory.Committed,
            EventFactory.Committed.AddHours(24));

        fact.RecipientId.ShouldBe(holders[1]);
        fact.Cause.AuctionRaffleEventId.ShouldBe(draw.EventId.ToString());
        fact.RaffleResult.AuctionId.ShouldBe(draw.AuctionId.ToString());
        fact.RaffleResult.Ticket.ShouldBe(2u);
        fact.RaffleResult.WinningTicket.ShouldBe(1u);
        fact.RaffleResult.TicketCount.ShouldBe(2u);
    }

    // Приз едет в тело факта (PER-649): весть победителя называет его по нему.
    [Fact]
    public void When_ResultBuiltWithPrize_Expect_PrizeInBody()
    {
        var holders = new[] { EventFactory.NewId(), EventFactory.NewId() };
        var draw = AuctionMapping.Decode(Subject,
                EventFactory.Bytes(EventFactory.RaffleDrawnWithPrize(EventFactory.AuctionOfMeetup(), 1, "сертификат",
                    holders)))
            .ShouldBeOfType<AuctionDecoded.Raffle>().Value;

        var fact = AuctionFacts.RaffleResult(Guid.CreateVersion7(), draw.Tickets[0], 1, draw, EventFactory.Committed,
            EventFactory.Committed.AddHours(24));

        fact.RaffleResult.HasRafflePrize.ShouldBeTrue();
        fact.RaffleResult.RafflePrize.ShouldBe("сертификат");
    }

    // Приз необязателен (PER-649): розыгрыш без приза — его нет и в разборе.
    [Fact]
    public void When_RaffleDrawnWithPrize_Expect_PrizeInDraw()
    {
        var auction = EventFactory.AuctionOfMeetup();
        var holders = new[] { EventFactory.NewId(), EventFactory.NewId() };
        var message = EventFactory.RaffleDrawnWithPrize(auction, 1, "сертификат на 5000 ₽", holders);

        var draw = AuctionMapping.Decode(Subject, EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Raffle>().Value;

        draw.Prize.ShouldBe("сертификат на 5000 ₽");
    }

    [Fact]
    public void When_RaffleDrawnWithoutPrize_Expect_NoPrize()
    {
        var message = EventFactory.RaffleDrawn(EventFactory.AuctionOfMeetup(), 1, EventFactory.NewId());

        var draw = AuctionMapping.Decode(Subject, EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Raffle>().Value;

        draw.Prize.ShouldBeNull();
    }

    // Пробельную строку чужого писателя разбор читает как отсутствие: иначе
    // победитель получил бы приз без приза.
    [Fact]
    public void When_RaffleDrawnWithBlankPrize_Expect_NoPrize()
    {
        var message = EventFactory.RaffleDrawnWithPrize(EventFactory.AuctionOfMeetup(), 1, "  ",
            EventFactory.NewId());

        var draw = AuctionMapping.Decode(Subject, EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Raffle>().Value;

        draw.Prize.ShouldBeNull();
    }

    [Fact]
    public void When_OccasionMissing_Expect_Poison()
    {
        var message = EventFactory.RaffleDrawn(EventFactory.AuctionOfMeetup(), 1, EventFactory.NewId());
        message.ClearOccasion();
        AuctionMapping.Decode(Subject, EventFactory.Bytes(message)).ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_NoTickets_Expect_Poison() =>
        AuctionMapping.Decode(Subject, EventFactory.Bytes(EventFactory.RaffleDrawn(EventFactory.AuctionOfMeetup(), 1)))
            .ShouldBeOfType<AuctionDecoded.Poison>();

    [Theory]
    [InlineData(0u)]
    [InlineData(3u)]
    public void When_WinningTicketOutOfRange_Expect_Poison(uint winning)
    {
        var message = EventFactory.RaffleDrawn(EventFactory.AuctionOfMeetup(), winning,
            EventFactory.NewId(), EventFactory.NewId());
        AuctionMapping.Decode(Subject, EventFactory.Bytes(message)).ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_HolderRepeatedOrInvalid_Expect_Poison()
    {
        var holder = EventFactory.NewId();
        var repeated = EventFactory.RaffleDrawn(EventFactory.AuctionOfMeetup(), 1, holder, holder);
        var invalid = EventFactory.RaffleDrawn(EventFactory.AuctionOfMeetup(), 1, "not-a-uuid");
        AuctionMapping.Decode(Subject, EventFactory.Bytes(repeated)).ShouldBeOfType<AuctionDecoded.Poison>();
        AuctionMapping.Decode(Subject, EventFactory.Bytes(invalid)).ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_PayloadBroken_Expect_Poison() =>
        AuctionMapping.Decode(Subject, new byte[] { 0xff }).ShouldBeOfType<AuctionDecoded.Poison>();
}
