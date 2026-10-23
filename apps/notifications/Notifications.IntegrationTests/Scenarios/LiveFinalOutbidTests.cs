using Notifications.Auction;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.TestKit;
using Notifications.V1;
using Npgsql;
using Shouldly;
using Xunit;
using static Notifications.IntegrationTests.Infrastructure.AuctionFixtures;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// «Перебили» и ответ своей автоставки в живом финале (PER-645) на настоящей
/// базе: частота там не действует, решает выключатель перебитий в финале, по
/// умолчанию выключенный.
/// </summary>
public class LiveFinalOutbidTests
{
    private static readonly DateTimeOffset Now = EventFactory.Committed;

    [Fact]
    public async Task When_LiveFinalNeverTouched_Expect_NoOutbidAndNoDigestLine()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var person = EventFactory.NewId();
        // Частота с окном в финале не действует: ставка зала в сводку не попадает.
        await SetOutbid(db, person, OutbidFrequency.AtMostEvery5Minutes);

        var applied = await store.Apply(
            Decode(Live(EventFactory.Bid(EventFactory.NewId(), person))), Now, Cancellation);

        applied.Outcome.ShouldBe(AuctionOutcome.Suppressed);
        (await Count(db, "notification")).ShouldBe(0);
        (await Count(db, "outbid_digest_line")).ShouldBe(0);
    }

    [Fact]
    public async Task When_LiveFinalOnAndFrequencyOff_Expect_EveryOutbidSent()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var lot = EventFactory.NewId();
        var person = EventFactory.NewId();
        var rival = EventFactory.NewId();
        await SetOutbid(db, person, OutbidFrequency.Off);
        await SetLiveFinalOutbids(db, person, true);

        await store.Apply(Decode(Live(EventFactory.Bid(lot, person, rival, version: 3))), Now, Cancellation);
        await store.Apply(Decode(Live(EventFactory.Bid(lot, rival, person, version: 4))), Now, Cancellation);
        var second = await store.Apply(Decode(Live(EventFactory.Bid(lot, person, rival, version: 5))), Now,
            Cancellation);

        second.Outcome.ShouldBe(AuctionOutcome.Outbid);
        var facts = await StoredFacts(db);
        facts.Count(fact => fact.RecipientId == person).ShouldBe(2);
        facts.ShouldAllBe(fact => fact.TypeCase == Notification.TypeOneofCase.LotOutbid);
    }

    [Theory]
    [InlineData(false, 0)]
    [InlineData(true, 1)]
    public async Task When_ProxyAnswersInLiveFinal_Expect_LeaderToldOnlyWithLiveFinalOn(bool enabled, int raised)
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var leader = EventFactory.NewId();
        var rival = EventFactory.NewId();
        await SetLiveFinalOutbids(db, leader, enabled);

        await store.Apply(
            Decode(Live(EventFactory.Bid(EventFactory.NewId(), rival, leader, version: 5, proxy: true, answers: true))),
            Now, Cancellation);

        (await StoredFacts(db)).Count(fact => fact.TypeCase == Notification.TypeOneofCase.LotProxyRaised)
            .ShouldBe(raised);
    }

    [Fact]
    public async Task When_OnlineBidAndLiveFinalOff_Expect_OutbidAsBefore()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var person = EventFactory.NewId();
        await SetLiveFinalOutbids(db, person, false);

        var applied = await store.Apply(Decode(EventFactory.Bid(EventFactory.NewId(), person)), Now, Cancellation);

        applied.Outcome.ShouldBe(AuctionOutcome.Outbid);
        (await StoredFacts(db)).ShouldHaveSingleItem().RecipientId.ShouldBe(person);
    }
}
