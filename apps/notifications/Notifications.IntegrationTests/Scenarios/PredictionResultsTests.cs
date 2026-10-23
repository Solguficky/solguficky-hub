using Notifications.Auction;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.TestKit;
using Notifications.V1;
using Npgsql;
using Shouldly;
using Xunit;
using static Notifications.IntegrationTests.Infrastructure.FactFixtures;
using static Notifications.IntegrationTests.Infrastructure.AuctionFixtures;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>Итоги прогнозов через настоящие JetStream, PostgreSQL и composition root (PER-567).</summary>
public class PredictionResultsTests
{
    [Fact]
    public async Task When_ResultsSettled_Expect_OneFactPerParticipantAndNoneOnRedelivery()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var auction = EventFactory.AuctionOfMeetup();
        var participants = new[] { EventFactory.NewId(), EventFactory.NewId(), EventFactory.NewId() };
        var message = EventFactory.PredictionResultsSettled(auction, participants);

        await nats.Publish(AuctionFeed.PredictionResultsSettledSubject, message);
        var published = await Eventually(nats.PublishedFacts, facts => facts.Count == 3);

        var facts = published.Select(item => item.Fact).ToArray();
        facts.ShouldAllBe(fact => fact.TypeCase == Notification.TypeOneofCase.PredictionResults);
        facts.ShouldAllBe(fact => fact.Cause.AuctionPredictionResultsEventId == message.EventId);
        facts.ShouldAllBe(fact => fact.PredictionResults.AuctionId == auction);
        facts.ShouldAllBe(fact => fact.PredictionResults.Nominations.Count == 2);
        facts.Select(fact => fact.RecipientId).OrderBy(id => id).ShouldBe(participants.OrderBy(id => id));
        facts.Single(fact => fact.RecipientId == participants[0]).PredictionResults.Yours[0].Guessed.ShouldBeTrue();

        await nats.Publish(AuctionFeed.PredictionResultsSettledSubject, message, messageId: Guid.NewGuid().ToString());
        await Eventually(() => Task.FromResult(silo.Service<AuctionTelemetry>().Total("duplicate")), count => count == 1);
        (await Count(db, "notification")).ShouldBe(3);
        (await nats.PublishedFacts()).Count.ShouldBe(3);
        silo.Service<AuctionTelemetry>().Total("prediction_results_announced").ShouldBe(1);
    }

    [Theory]
    [InlineData("member", "events.notifications.notification_created.hub")]
    [InlineData("guest", "events.notifications.notification_created.auction")]
    public async Task When_ParticipantHasCircle_Expect_ResultsOnCircleSubject(string circle, string subject)
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        var participant = (await Person(db, circle == "member" ? MemberHolding : GuestHolding)).ToString();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);

        await nats.Publish(AuctionFeed.PredictionResultsSettledSubject,
            EventFactory.PredictionResultsSettled(EventFactory.AuctionOfMeetup(), participant));

        var published = await Eventually(nats.PublishedFacts, facts => facts.Count == 1);
        published.Single().Subject.ShouldBe(subject);
    }

    /// <summary>
    /// Ручная отметка подсчитанных итогов не несёт: событие принято и
    /// подтверждено, но адресатов у него нет, даже если строки участников пришли.
    /// </summary>
    [Fact]
    public async Task When_SettledByHand_Expect_NoFactAndEventConsumed()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var message = EventFactory.PredictionResultsSettled(EventFactory.AuctionOfMeetup(), EventFactory.NewId());
        message.State.Nominations.Clear();
        message.State.Manual = true;

        await nats.Publish(AuctionFeed.PredictionResultsSettledSubject, message);

        await Eventually(() => Task.FromResult(silo.Service<AuctionTelemetry>().Total("prediction_results_announced")),
            count => count == 1);
        (await Count(db, "notification")).ShouldBe(0);
        (await Count(db, "consumed_event")).ShouldBe(1);
        (await nats.PublishedFacts()).ShouldBeEmpty();
    }

    [Fact]
    public async Task When_ResultsKeyPruned_Expect_PersistentCauseKeyStillPreventsSecondFact()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var settlement = AuctionMapping.Decode(AuctionFeed.PredictionResultsSettledSubject, EventFactory.Bytes(
                EventFactory.PredictionResultsSettled(EventFactory.AuctionOfMeetup(), EventFactory.NewId(),
                    EventFactory.NewId())))
            .ShouldBeOfType<AuctionDecoded.Predictions>().Value;
        (await store.Apply(settlement, EventFactory.Committed, Cancellation)).FactsCreated.ShouldBe(2);
        await PruneEventKeys(db, EventFactory.Committed.AddDays(9));
        (await store.Apply(settlement, EventFactory.Committed.AddDays(10), Cancellation)).FactsCreated.ShouldBe(0);
        (await Count(db, "notification")).ShouldBe(2);
    }
}
