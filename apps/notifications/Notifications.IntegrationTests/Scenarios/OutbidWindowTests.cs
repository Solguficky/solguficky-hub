using Notifications.Auction;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.TestKit;
using Notifications.V1;
using Npgsql;
using Shouldly;
using Xunit;
using static Notifications.IntegrationTests.Infrastructure.AuctionFixtures;
using static Notifications.IntegrationTests.Infrastructure.FactFixtures;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Настройка перебитий и окно частоты (PER-514) на настоящей базе. Время
/// двигается моментом, который сценарий передаёт хранилищу, а в хосте — сдвигом
/// <c>due_at</c> в базе.
/// </summary>
public class OutbidWindowTests
{
    private static readonly DateTimeOffset Opened = EventFactory.Committed;
    private static readonly DateTimeOffset Closes = Opened.AddMinutes(5);

    [Fact]
    public async Task When_FiveOutbidsWithinWindow_Expect_OneFactWithLastPrice()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var lot = EventFactory.NewId();
        var person = EventFactory.NewId();
        var rival = EventFactory.NewId();
        await SetOutbid(db, person, OutbidFrequency.AtMostEvery5Minutes);
        await SetOutbid(db, rival, OutbidFrequency.AtMostEvery5Minutes);

        // Лидерство переходит туда и обратно: человек перебит пять раз, соперник
        // четыре, и к закрытию окна лидирует соперник.
        global::Auction.V1.LotEvent last = null!;
        for (var round = 0; round < 5; round++)
        {
            last = PricedBid(lot, person, rival, version: 2 * round + 1, minorUnits: 10000 * (round + 1));
            (await store.Apply(Decode(last), Opened.AddSeconds(round), Cancellation)).Outcome
                .ShouldBe(AuctionOutcome.Collected);
            if (round < 4)
            {
                await store.Apply(Decode(PricedBid(lot, rival, person, version: 2 * round + 2,
                    minorUnits: 10000 * (round + 1) + 5000)), Opened.AddSeconds(round), Cancellation);
            }
        }

        (await Count(db, "notification")).ShouldBe(0);
        (await CloseDueWindows(store, Closes.AddSeconds(-1))).ShouldBe(0);
        (await CloseDueWindows(store, Closes)).ShouldBe(1);

        var fact = (await StoredFacts(db)).ShouldHaveSingleItem();
        fact.RecipientId.ShouldBe(person);
        fact.LotOutbid.LotId.ShouldBe(lot);
        fact.LotOutbid.CurrentPrice.MinorUnits.ShouldBe(50000);
        fact.Cause.AuctionLotEventId.ShouldBe(last.EventId);
        (await Count(db, "outbid_window")).ShouldBe(0);
    }

    [Fact]
    public async Task When_ThirdPartiesBidAfterOutbid_Expect_MessageWithCurrentPrice()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var lot = EventFactory.NewId();
        var person = EventFactory.NewId();
        var first = EventFactory.NewId();
        var second = EventFactory.NewId();
        await SetOutbid(db, person, OutbidFrequency.AtMostEvery5Minutes);

        await store.Apply(Decode(PricedBid(lot, person, first, version: 3, minorUnits: 10000)), Opened, Cancellation);
        // Дальше ставят другие: человек в этих ставках ни лидер, ни перебитый,
        // а цена растёт.
        await store.Apply(Decode(PricedBid(lot, first, second, version: 4, minorUnits: 12000)), Opened, Cancellation);
        var latest = PricedBid(lot, second, first, version: 5, minorUnits: 15000);
        await store.Apply(Decode(latest), Opened, Cancellation);
        (await CloseDueWindows(store, Closes)).ShouldBe(1);

        var fact = (await StoredFacts(db)).Single(fact => fact.RecipientId == person);
        fact.LotOutbid.CurrentPrice.MinorUnits.ShouldBe(15000);
        fact.Cause.AuctionLotEventId.ShouldBe(latest.EventId);
    }

    [Fact]
    public async Task When_OutbidsOff_Expect_NoOutbidButPurchaseStillSent()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var lot = EventFactory.NewId();
        var person = EventFactory.NewId();
        await SetOutbid(db, person, OutbidFrequency.Off);

        (await store.Apply(Decode(EventFactory.Bid(lot, person, version: 3)), Opened, Cancellation)).Outcome
            .ShouldBe(AuctionOutcome.Suppressed);
        await store.Apply(DecodeSale(EventFactory.Sold(lot, person, version: 7)), Opened, Cancellation);

        var fact = (await StoredFacts(db)).ShouldHaveSingleItem();
        fact.TypeCase.ShouldBe(Notification.TypeOneofCase.LotPurchased);
        fact.RecipientId.ShouldBe(person);
        (await Count(db, "outbid_window")).ShouldBe(0);
    }

    [Fact]
    public async Task When_LeadRegainedBeforeWindowCloses_Expect_NoMessage()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var lot = EventFactory.NewId();
        var person = EventFactory.NewId();
        var rival = EventFactory.NewId();
        await SetOutbid(db, person, OutbidFrequency.AtMostEvery5Minutes);

        await store.Apply(Decode(EventFactory.Bid(lot, person, rival, version: 3)), Opened, Cancellation);
        // Соперник настройку не трогал и получает своё «перебили» сразу.
        await store.Apply(Decode(EventFactory.Bid(lot, rival, person, version: 4)), Opened, Cancellation);
        (await CloseDueWindows(store, Closes)).ShouldBe(0);

        var fact = (await StoredFacts(db)).ShouldHaveSingleItem();
        fact.RecipientId.ShouldBe(rival);
        (await Count(db, "outbid_window")).ShouldBe(0);
    }

    [Fact]
    public async Task When_OlderOutbidArrivesAfterRegain_Expect_NoMessage()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var lot = EventFactory.NewId();
        var person = EventFactory.NewId();
        await SetOutbid(db, person, OutbidFrequency.AtMostEvery5Minutes);

        await store.Apply(Decode(EventFactory.Bid(lot, person, version: 3)), Opened, Cancellation);
        await store.Apply(Decode(EventFactory.Bid(lot, EventFactory.NewId(), person, version: 6)), Opened, Cancellation);
        // Перебитие пятой версии пришло после возврата лидерства шестой и
        // отметку обратно не ставит.
        await store.Apply(Decode(EventFactory.Bid(lot, person, version: 5)), Opened, Cancellation);
        (await CloseDueWindows(store, Closes)).ShouldBe(0);

        (await StoredFacts(db)).Where(fact => fact.RecipientId == person).ShouldBeEmpty();
    }

    [Fact]
    public async Task When_LotSoldWithOpenWindow_Expect_OutbidAtOnceWithSalePrice()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var lot = EventFactory.NewId();
        var person = EventFactory.NewId();
        var winner = EventFactory.NewId();
        await SetOutbid(db, person, OutbidFrequency.AtMostEvery60Minutes);

        await store.Apply(Decode(EventFactory.Bid(lot, person, winner, version: 3)), Opened, Cancellation);
        var sold = EventFactory.Sold(lot, winner, version: 7);
        var application = await store.Apply(DecodeSale(sold), Opened.AddMinutes(1), Cancellation);

        application.Created[AuctionFacts.OutbidType].ShouldBe(1);
        var outbid = (await StoredFacts(db)).Single(fact => fact.TypeCase == Notification.TypeOneofCase.LotOutbid);
        outbid.RecipientId.ShouldBe(person);
        outbid.Cause.AuctionLotEventId.ShouldBe(sold.EventId);
        outbid.LotOutbid.CurrentPrice.ShouldBe(sold.State.Sold.Price);
        (await Count(db, "outbid_window")).ShouldBe(0);
        (await CloseDueWindows(store, Opened.AddHours(2))).ShouldBe(0);
    }

    [Fact]
    public async Task When_OutbidsTurnedOffDuringWindow_Expect_NoMessage()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var person = EventFactory.NewId();
        await SetOutbid(db, person, OutbidFrequency.AtMostEvery5Minutes);

        await store.Apply(Decode(EventFactory.Bid(EventFactory.NewId(), person)), Opened, Cancellation);
        await SetOutbid(db, person, OutbidFrequency.Off);

        (await CloseDueWindows(store, Closes)).ShouldBe(0);
        (await Count(db, "notification")).ShouldBe(0);
        (await Count(db, "outbid_window")).ShouldBe(0);
    }

    [Fact]
    public async Task When_WindowClosedConcurrently_Expect_OneFact()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var person = EventFactory.NewId();
        await SetOutbid(db, person, OutbidFrequency.AtMostEvery5Minutes);
        await store.Apply(Decode(EventFactory.Bid(EventFactory.NewId(), person)), Opened, Cancellation);
        var key = (await store.DueWindows(Closes, 256, Cancellation)).ShouldHaveSingleItem();

        var created = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => store.CloseWindow(key, Closes, Cancellation)));

        created.Sum().ShouldBe(1);
        (await Count(db, "notification")).ShouldBe(1);
    }

    [Fact]
    public async Task When_WindowDueInRunningService_Expect_SweeperPublishesOneFact()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url,
            "--Notifications:OutbidWindows:SweepPeriod=00:00:01");
        var person = EventFactory.NewId();
        await SetOutbid(db, person, OutbidFrequency.AtMostEvery15Minutes);

        await nats.Publish(AuctionFeed.BidPlacedSubject, EventFactory.Bid(EventFactory.NewId(), person));
        await Eventually(() => Task.FromResult(silo.Service<AuctionTelemetry>().Total("collected")), count => count == 1);
        (await nats.PublishedFacts()).ShouldBeEmpty();

        await ExpireWindows(db);
        var (fact, _) = (await Eventually(nats.PublishedFacts, facts => facts.Count == 1)).Single();
        fact.TypeCase.ShouldBe(Notification.TypeOneofCase.LotOutbid);
        fact.RecipientId.ShouldBe(person);
        await Eventually(() => Count(db, "outbid_window"), count => count == 0);
    }
}
