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

/// <summary>
/// Снятие участника с лота (ADR-072, п. 5, PER-672): сообщение новому лидеру,
/// реплика лота по снимку после снятия и повтор, который второго не даёт.
/// Снятому не пишется ничего, и кто снял, факт не несёт.
/// </summary>
public class AuctionParticipantRemovalTests
{
    [Theory]
    [InlineData("member", "events.notifications.notification_created.hub")]
    [InlineData("guest", "events.notifications.notification_created.auction")]
    public async Task When_RemovalChangesLead_Expect_FactToNewLeaderOnCircleSubject(string circle, string subject)
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        var leader = await Person(db, circle == "member" ? MemberHolding : GuestHolding);
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var removed = EventFactory.NewId();
        var message = EventFactory.ParticipantRemoved(EventFactory.NewId(), removed, leader.ToString());

        await nats.Publish(AuctionFeed.ParticipantRemovedSubject, message);

        var published = await Eventually(nats.PublishedFacts, facts => facts.Count == 1);
        published.Single().Subject.ShouldBe(subject);
        var (fact, messageId) = published.Single();
        fact.TypeCase.ShouldBe(Notification.TypeOneofCase.LotLeadRestored);
        fact.RecipientId.ShouldBe(leader.ToString());
        fact.Cause.AuctionLotEventId.ShouldBe(message.EventId);
        fact.LotLeadRestored.LotId.ShouldBe(message.LotId);
        fact.LotLeadRestored.CurrentPrice.ShouldBe(message.State.Trading.CurrentPrice);
        messageId.ShouldBe(fact.NotificationId);
        // Снятому не пишется ничего: факт ровно один и он не его.
        (await Count(db, "notification")).ShouldBe(1);
        (await StoredFact(db)).RecipientId.ShouldBe(leader.ToString());
    }

    [Fact]
    public async Task When_RemovalKeepsLeadOrRemovesTheOnlyParticipant_Expect_NoFactButReplicaWritten()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var lot = EventFactory.NewId();
        var leader = EventFactory.NewId();

        // Снят не тот, кто ведёт: лидерство не меняется.
        var kept = await store.Apply(DecodeRemoval(EventFactory.ParticipantRemoved(lot, leader, leader)),
            EventFactory.Committed, Cancellation);
        kept.Outcome.ShouldBe(AuctionOutcome.LotReplicated);
        kept.FactsCreated.ShouldBe(0);

        // Снят единственный участник: лот остаётся без лидера.
        var only = await store.Apply(
            DecodeRemoval(EventFactory.ParticipantRemoved(lot, leader, leader: null, version: 9)),
            EventFactory.Committed, Cancellation);
        only.FactsCreated.ShouldBe(0);

        (await Count(db, "notification")).ShouldBe(0);
        (await ReplicaLeader(db, lot)).ShouldBeNull();
    }

    [Fact]
    public async Task When_RemovalChangesLead_Expect_ReplicaCarriesNewLeaderAndPrice()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var lot = EventFactory.NewId();
        var leader = EventFactory.NewId();

        var outcome = await store.Apply(
            DecodeRemoval(EventFactory.ParticipantRemoved(lot, EventFactory.NewId(), leader, price: 6400)),
            EventFactory.Committed, Cancellation);

        outcome.Outcome.ShouldBe(AuctionOutcome.LeadRestored);
        outcome.FactsCreated.ShouldBe(1);
        // По реплике адресуются напоминание и следующее «перебили»: лидер в ней новый.
        (await ReplicaLeader(db, lot)).ShouldBe(Guid.Parse(leader));
        (await StoredFact(db)).LotLeadRestored.CurrentPrice.MinorUnits.ShouldBe(6400);
    }

    [Fact]
    public async Task When_RemovalOfHeldLotChangesLead_Expect_FactWithHeldPrice()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var leader = EventFactory.NewId();

        var outcome = await store.Apply(
            DecodeRemoval(EventFactory.ParticipantRemoved(EventFactory.NewId(), EventFactory.NewId(), leader,
                held: true, price: 8800)),
            EventFactory.Committed, Cancellation);

        outcome.FactsCreated.ShouldBe(1);
        var fact = await StoredFact(db);
        fact.RecipientId.ShouldBe(leader);
        fact.LotLeadRestored.CurrentPrice.MinorUnits.ShouldBe(8800);
    }

    [Fact]
    public async Task When_RemovalAlreadyApplied_Expect_NoSecondFactOnRedelivery()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var message = EventFactory.ParticipantRemoved(EventFactory.NewId(), EventFactory.NewId(), EventFactory.NewId());

        await nats.Publish(AuctionFeed.ParticipantRemovedSubject, message);
        await Eventually(nats.PublishedFacts, facts => facts.Count == 1);
        // Повтор под другим Nats-Msg-Id отсекает ключ события, а не окно шины.
        await nats.Publish(AuctionFeed.ParticipantRemovedSubject, message, messageId: Guid.NewGuid().ToString());
        await Eventually(() => Task.FromResult(silo.Service<AuctionTelemetry>().Total("duplicate")), count => count == 1);

        (await Count(db, "notification")).ShouldBe(1);
        (await Count(db, "consumed_event")).ShouldBe(1);
        (await nats.PublishedFacts()).Count.ShouldBe(1);
    }

    [Fact]
    public async Task When_RemovalEventKeyPruned_Expect_PersistentCauseKeyStillPreventsSecondFact()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var removal = DecodeRemoval(EventFactory.ParticipantRemoved(EventFactory.NewId(), EventFactory.NewId(),
            EventFactory.NewId()));

        (await store.Apply(removal, EventFactory.Committed, Cancellation)).FactsCreated.ShouldBe(1);
        await PruneEventKeys(db, EventFactory.Committed.AddDays(9));
        (await store.Apply(removal, EventFactory.Committed.AddDays(10), Cancellation)).FactsCreated.ShouldBe(0);

        (await Count(db, "notification")).ShouldBe(1);
    }

    [Fact]
    public async Task When_RemovalOfEndedAuctionArrives_Expect_NoReplicaAndNoFact()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var auction = EventFactory.AuctionOfMeetup();
        var lot = EventFactory.NewId();
        var leader = EventFactory.NewId();

        await nats.Publish("events.auction.auction_cancelled",
            EventFactory.AuctionCancelled(auction, EventFactory.NewId(), lot));
        await Eventually(() => Count(db, "auction_ended"), ended => ended == 1);

        await nats.Publish(AuctionFeed.ParticipantRemovedSubject,
            EventFactory.ParticipantRemoved(lot, EventFactory.NewId(), leader, auction: auction));
        await Eventually(() => nats.Unacknowledged(AuctionFeed.Feed), pending => pending == 0);

        (await Count(db, "notification")).ShouldBe(0);
        (await ReplicaLeader(db, lot)).ShouldBeNull();
    }

    // Удержание лота помнит лидера и цену на момент удержания: состав финала и
    // весть «твой лот следующий» читают их оттуда, и без правки после снятия
    // они достались бы снятому.
    [Fact]
    public async Task When_RemovalFromHeldLotChangesLead_Expect_HoldCarriesNewLeaderAndPrice()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var lot = EventFactory.NewId();
        var held = EventFactory.NewId();
        var leader = EventFactory.NewId();

        await store.Apply(DecodeLot("events.auction.lot_held_for_final",
            EventFactory.HeldForFinal(lot, leader: held, price: 70000)), EventFactory.Committed, Cancellation);
        (await Hold(db, lot)).ShouldBe((Guid.Parse(held), 70000L));

        var outcome = await store.Apply(
            DecodeRemoval(EventFactory.ParticipantRemoved(lot, held, leader, held: true, price: 50000, version: 9)),
            EventFactory.Committed, Cancellation);

        outcome.FactsCreated.ShouldBe(1);
        (await Hold(db, lot)).ShouldBe((Guid.Parse(leader), 50000L));
    }

    // Снятие меняет лидера и цену лота, а строка открытого окна перебитий
    // несёт их на момент последней ставки: без правки сводка сказала бы «лот
    // за тобой» тому, кто лот уже не ведёт, и назвала бы старую цену.
    [Fact]
    public async Task When_RemovalChangesLeadWhileDigestOpen_Expect_LineCarriesNewLeaderAndPrice()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var lot = EventFactory.NewId();
        var person = EventFactory.NewId();
        var rival = EventFactory.NewId();
        await SetOutbid(db, person, OutbidFrequency.AtMostEvery5Minutes);

        await store.Apply(Decode(PricedBid(lot, person, rival, version: 3, minorUnits: 10000)),
            EventFactory.Committed, Cancellation);
        // Снят соперник: ведение вернулось к тому, кого перебили.
        await store.Apply(DecodeRemoval(EventFactory.ParticipantRemoved(lot, rival, person, price: 9000, version: 4)),
            EventFactory.Committed, Cancellation);
        (await CloseDueWindows(store, EventFactory.Committed.AddMinutes(5))).ShouldBe(1);

        var line = (await StoredDigests(db)).ShouldHaveSingleItem().LotActivityDigest.Lines.ShouldHaveSingleItem();
        line.CurrentPrice.MinorUnits.ShouldBe(9000);
        line.RecipientLeads.ShouldBeTrue();
    }
}
