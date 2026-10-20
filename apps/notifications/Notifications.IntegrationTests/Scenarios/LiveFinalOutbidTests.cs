using Notifications.Auction;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.TestKit;
using Notifications.V1;
using Npgsql;
using Shouldly;
using Xunit;
using static Notifications.IntegrationTests.Infrastructure.AuctionFixtures;

namespace Notifications.IntegrationTests.Scenarios;

public class LiveFinalOutbidTests
{
    [Theory]
    [InlineData(false, AuctionOutcome.Outbid, 1, 0)]
    [InlineData(true, AuctionOutcome.Suppressed, 0, 0)]
    public async Task When_SameBidDiffersOnlyByLivePhase_Expect_DefaultSilencesOnlyTheFinal(
        bool live, AuctionOutcome outcome, int notifications, int lines)
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var person = EventFactory.NewId();
        var rival = EventFactory.NewId();

        var applied = await store.Apply(
            Decode(EventFactory.Bid(EventFactory.NewId(), person, rival, live: live)),
            EventFactory.Committed, Cancellation);

        applied.Outcome.ShouldBe(outcome);
        (await Count(db, "notification")).ShouldBe(notifications);
        (await Count(db, "outbid_digest_line")).ShouldBe(lines);
        (await Count(db, "outbid_digest")).ShouldBe(0);
    }

    [Fact]
    public async Task When_LiveFinalIntervalAndSettingOff_Expect_NoDigestLine()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var person = EventFactory.NewId();
        var rival = EventFactory.NewId();
        await SetOutbid(db, person, OutbidFrequency.AtMostEvery5Minutes);

        var applied = await store.Apply(
            Decode(EventFactory.Bid(EventFactory.NewId(), person, rival, live: true)),
            EventFactory.Committed, Cancellation);

        applied.Outcome.ShouldBe(AuctionOutcome.Suppressed);
        (await Count(db, "notification")).ShouldBe(0);
        (await Count(db, "outbid_digest_line")).ShouldBe(0);
        (await Count(db, "outbid_digest")).ShouldBe(0);
    }

    [Fact]
    public async Task When_LiveFinalIntervalAndSettingOn_Expect_DigestLineWithoutImmediateFact()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var person = EventFactory.NewId();
        var rival = EventFactory.NewId();
        await SetOutbid(db, person, OutbidFrequency.AtMostEvery5Minutes);
        await SetFinalOutbids(db, person, true);

        var applied = await store.Apply(
            Decode(EventFactory.Bid(EventFactory.NewId(), person, rival, live: true)),
            EventFactory.Committed, Cancellation);

        applied.Outcome.ShouldBe(AuctionOutcome.Collected);
        (await Count(db, "notification")).ShouldBe(0);
        (await Count(db, "outbid_digest_line")).ShouldBe(1);
        (await Count(db, "outbid_digest")).ShouldBe(1);
    }

    [Fact]
    public async Task When_LiveFinalAndSettingOnAtEvery_Expect_ImmediateOutbid()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var person = EventFactory.NewId();
        var rival = EventFactory.NewId();
        await SetFinalOutbids(db, person, true);

        var applied = await store.Apply(
            Decode(EventFactory.Bid(EventFactory.NewId(), person, rival, live: true)),
            EventFactory.Committed, Cancellation);

        applied.Outcome.ShouldBe(AuctionOutcome.Outbid);
        (await Count(db, "notification")).ShouldBe(1);
        (await StoredFact(db)).TypeCase.ShouldBe(Notification.TypeOneofCase.LotOutbid);
    }

    [Fact]
    public async Task When_LiveFinalSilencesOutbid_Expect_ProxyAnswerStillSent()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var person = EventFactory.NewId();
        var leader = EventFactory.NewId();

        var applied = await store.Apply(
            Decode(EventFactory.Bid(EventFactory.NewId(), person, leader, proxy: true, answers: true, live: true)),
            EventFactory.Committed, Cancellation);

        applied.Outcome.ShouldBe(AuctionOutcome.Suppressed);
        var fact = await StoredFact(db);
        fact.TypeCase.ShouldBe(Notification.TypeOneofCase.LotProxyRaised);
        fact.RecipientId.ShouldBe(leader);
        (await Count(db, "outbid_digest_line")).ShouldBe(0);
    }
}
