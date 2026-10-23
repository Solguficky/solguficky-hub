using Auction.V1;
using Notifications.Auction;
using Notifications.TestKit;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.AuctionTests;

/// <summary>Разбор итогов прогнозов и форма адресного факта сделавшему прогноз (PER-567).</summary>
public class PredictionResultsTests
{
    private const string Subject = AuctionFeed.PredictionResultsSettledSubject;

    [Fact]
    public void When_ResultsSettled_Expect_NominationsAndEveryParticipant()
    {
        var auction = EventFactory.AuctionOfMeetup();
        var participants = new[] { EventFactory.NewId(), EventFactory.NewId() };
        var message = EventFactory.PredictionResultsSettled(auction, participants);

        var settlement = AuctionMapping.Decode(Subject, EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Predictions>().Value;

        settlement.EventId.ShouldBe(Guid.Parse(message.EventId));
        settlement.AuctionId.ShouldBe(Guid.Parse(auction));
        settlement.Nominations.Select(outcome => outcome.Nomination)
            .ShouldBe([PredictionNomination.MostExpensiveLot, PredictionNomination.TotalSales]);
        settlement.Nominations[0].Lots.ShouldBe([Guid.Parse(message.State.Nominations[0].Lots.LotIds[0])]);
        settlement.Nominations[0].WinnerNames.ShouldBe(["Первый"]);
        settlement.Nominations[1].Number.ShouldBe(60_000);
        settlement.Participants.Select(participant => participant.ParticipantId)
            .ShouldBe(participants.Select(Guid.Parse).ToArray());
    }

    [Fact]
    public void When_FactBuilt_Expect_OwnResultAndWinnerNamesWithoutOthersAnswers()
    {
        var participants = new[] { EventFactory.NewId(), EventFactory.NewId() };
        var settlement = AuctionMapping.Decode(Subject, EventFactory.Bytes(
                EventFactory.PredictionResultsSettled(EventFactory.AuctionOfMeetup(), participants)))
            .ShouldBeOfType<AuctionDecoded.Predictions>().Value;

        var fact = AuctionFacts.PredictionResults(Guid.CreateVersion7(), settlement.Participants[1], settlement,
            EventFactory.Committed, EventFactory.Committed.AddHours(24));

        fact.RecipientId.ShouldBe(participants[1]);
        fact.Cause.AuctionPredictionResultsEventId.ShouldBe(settlement.EventId.ToString());
        var body = fact.PredictionResults;
        body.AuctionId.ShouldBe(settlement.AuctionId.ToString());
        body.Nominations.Count.ShouldBe(2);
        body.Nominations[0].Lots.LotIds.ShouldBe(settlement.Nominations[0].Lots!.Select(lot => lot.ToString()));
        body.Nominations[0].Winners.ShouldBe(1u);
        body.Nominations[0].WinnerNames.ShouldBe(["Первый"]);
        body.Nominations[1].Number.ShouldBe(60_000);
        body.Yours.Count.ShouldBe(2);
        body.Yours[0].Guessed.ShouldBeFalse();
        body.Yours[0].HasDeviation.ShouldBeFalse();
        body.Yours[1].Nomination.ShouldBe(PredictionNomination.TotalSales);
        body.Yours[1].Deviation.ShouldBe(2);
    }

    [Fact]
    public void When_SettledByHand_Expect_ManualAndNoPoison()
    {
        var message = EventFactory.PredictionResultsSettled(EventFactory.AuctionOfMeetup());
        message.State.Nominations.Clear();
        message.State.Manual = true;

        var settlement = AuctionMapping.Decode(Subject, EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Predictions>().Value;

        settlement.Manual.ShouldBeTrue();
        settlement.Participants.ShouldBeEmpty();
    }

    /// <summary>
    /// Auction пишет ответившему промах и на номинацию, которую не разыграли: у неё
    /// нет итога, и в свой результат факта она не попадает.
    /// </summary>
    [Fact]
    public void When_AnswerToUnplayedNomination_Expect_AbsentFromOwnResult()
    {
        var participant = EventFactory.NewId();
        var message = EventFactory.PredictionResultsSettled(EventFactory.AuctionOfMeetup(), participant);
        message.State.Nominations.RemoveAt(1);
        var settlement = AuctionMapping.Decode(Subject, EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Predictions>().Value;

        var fact = AuctionFacts.PredictionResults(Guid.CreateVersion7(), settlement.Participants[0], settlement,
            EventFactory.Committed, EventFactory.Committed.AddHours(24));

        fact.PredictionResults.Nominations.Count.ShouldBe(1);
        fact.PredictionResults.Yours.Select(own => own.Nomination).ShouldBe([PredictionNomination.MostExpensiveLot]);
    }

    /// <summary>
    /// Факт итогов один на аукцион: пустое имя угадавшего не делает его ядом для
    /// всех, а пропускается, и число угадавших его по-прежнему считает.
    /// </summary>
    [Fact]
    public void When_WinnerNameBlank_Expect_NameSkippedAndWinnersKept()
    {
        var message = EventFactory.PredictionResultsSettled(EventFactory.AuctionOfMeetup(), EventFactory.NewId());
        message.State.Nominations[0].WinnerNames[0].Name = " ";

        var settlement = AuctionMapping.Decode(Subject, EventFactory.Bytes(message))
            .ShouldBeOfType<AuctionDecoded.Predictions>().Value;

        settlement.Nominations[0].WinnerNames.ShouldBeEmpty();
        settlement.Nominations[0].Winners.ShouldBe(1);
    }

    [Fact]
    public void When_OccasionMissing_Expect_Poison()
    {
        var message = EventFactory.PredictionResultsSettled(EventFactory.AuctionOfMeetup(), EventFactory.NewId());
        message.ClearOccasion();
        AuctionMapping.Decode(Subject, EventFactory.Bytes(message)).ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_StateNamesAnotherAuction_Expect_Poison()
    {
        var message = EventFactory.PredictionResultsSettled(EventFactory.AuctionOfMeetup(), EventFactory.NewId());
        message.State.AuctionId = EventFactory.AuctionOfMeetup();
        AuctionMapping.Decode(Subject, EventFactory.Bytes(message)).ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_ParticipantRepeatedOrInvalid_Expect_Poison()
    {
        var participant = EventFactory.NewId();
        var repeated = EventFactory.PredictionResultsSettled(EventFactory.AuctionOfMeetup(), participant, participant);
        var invalid = EventFactory.PredictionResultsSettled(EventFactory.AuctionOfMeetup(), "not-a-uuid");
        AuctionMapping.Decode(Subject, EventFactory.Bytes(repeated)).ShouldBeOfType<AuctionDecoded.Poison>();
        AuctionMapping.Decode(Subject, EventFactory.Bytes(invalid)).ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_NominationWithoutValueOrUnspecified_Expect_Poison()
    {
        var withoutValue = EventFactory.PredictionResultsSettled(EventFactory.AuctionOfMeetup(), EventFactory.NewId());
        withoutValue.State.Nominations[1].ClearValue();
        var unspecified = EventFactory.PredictionResultsSettled(EventFactory.AuctionOfMeetup(), EventFactory.NewId());
        unspecified.State.Nominations[1].Nomination = PredictionNomination.Unspecified;
        AuctionMapping.Decode(Subject, EventFactory.Bytes(withoutValue)).ShouldBeOfType<AuctionDecoded.Poison>();
        AuctionMapping.Decode(Subject, EventFactory.Bytes(unspecified)).ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_ParticipationWithoutResult_Expect_Poison()
    {
        var message = EventFactory.PredictionResultsSettled(EventFactory.AuctionOfMeetup(), EventFactory.NewId());
        message.State.Participants[0].Participation[0].ClearResult();
        AuctionMapping.Decode(Subject, EventFactory.Bytes(message)).ShouldBeOfType<AuctionDecoded.Poison>();
    }

    [Fact]
    public void When_PayloadBroken_Expect_Poison() =>
        AuctionMapping.Decode(Subject, new byte[] { 0xff }).ShouldBeOfType<AuctionDecoded.Poison>();
}
