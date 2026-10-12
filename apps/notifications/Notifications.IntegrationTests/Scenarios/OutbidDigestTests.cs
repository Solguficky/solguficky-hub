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
/// Настройка перебитий и сводка окна (PER-514, PER-596) на настоящей базе.
/// Время двигается моментом, который сценарий передаёт хранилищу, а в хосте —
/// сдвигом <c>due_at</c> в базе.
/// </summary>
public class OutbidDigestTests
{
    private static readonly DateTimeOffset Opened = EventFactory.Committed;
    private static readonly DateTimeOffset Closes = Opened.AddMinutes(5);

    [Fact]
    public async Task When_ThreeOutbidsOnTwoLots_Expect_OneDigestWithBothLotsAndLastPrices()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var first = EventFactory.NewId();
        var second = EventFactory.NewId();
        var person = EventFactory.NewId();
        var rival = EventFactory.NewId();
        await SetOutbid(db, person, OutbidFrequency.AtMostEvery5Minutes);
        await SetOutbid(db, rival, OutbidFrequency.Off);

        // Окно открывает первое перебитие на первом лоте; перебитие на втором
        // лоте минутой позже его срока не сдвигает.
        (await store.Apply(Decode(PricedBid(first, person, rival, version: 3, minorUnits: 10000)), Opened,
            Cancellation)).Outcome.ShouldBe(AuctionOutcome.Collected);
        await store.Apply(Decode(PricedBid(first, rival, person, version: 4, minorUnits: 11000)), Opened, Cancellation);
        await store.Apply(Decode(PricedBid(first, person, rival, version: 5, minorUnits: 12000)), Opened, Cancellation);
        await store.Apply(Decode(PricedBid(second, person, rival, version: 3, minorUnits: 30000)),
            Opened.AddMinutes(1), Cancellation);

        (await Count(db, "notification")).ShouldBe(0);
        (await CloseDueWindows(store, Closes.AddSeconds(-1))).ShouldBe(0);
        (await CloseDueWindows(store, Closes)).ShouldBe(1);

        var fact = (await StoredFacts(db)).ShouldHaveSingleItem();
        fact.RecipientId.ShouldBe(person);
        fact.Cause.RefCase.ShouldBe(Cause.RefOneofCase.OutbidDigestId);
        fact.LotActivityDigest.Lines.Select(line => (line.LotId, line.Kind, line.CurrentPrice.MinorUnits, line.RecipientLeads))
            .ShouldBe(
            [
                (first, LotActivityKind.Outbid, 12000L, false),
                (second, LotActivityKind.Outbid, 30000L, false),
            ]);
        (await Count(db, "outbid_digest")).ShouldBe(0);
        (await Count(db, "outbid_digest_line")).ShouldBe(0);
    }

    [Fact]
    public async Task When_ThirdPartiesBidAfterOutbid_Expect_LineWithCurrentPrice()
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
        await store.Apply(Decode(PricedBid(lot, second, first, version: 5, minorUnits: 15000)), Opened, Cancellation);
        (await CloseDueWindows(store, Closes)).ShouldBe(1);

        var fact = (await StoredDigests(db)).Single(fact => fact.RecipientId == person);
        fact.LotActivityDigest.Lines.ShouldHaveSingleItem().CurrentPrice.MinorUnits.ShouldBe(15000);
    }

    [Fact]
    public async Task When_LeadRegainedBeforeWindowCloses_Expect_LotStillInDigest()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var lot = EventFactory.NewId();
        var person = EventFactory.NewId();
        var rival = EventFactory.NewId();
        await SetOutbid(db, person, OutbidFrequency.AtMostEvery5Minutes);

        await store.Apply(Decode(PricedBid(lot, person, rival, version: 3, minorUnits: 10000)), Opened, Cancellation);
        // Соперник настройку не трогал и получает своё «перебили» сразу.
        await store.Apply(Decode(PricedBid(lot, rival, person, version: 4, minorUnits: 11000)), Opened, Cancellation);
        (await CloseDueWindows(store, Closes)).ShouldBe(1);

        var line = (await StoredDigests(db)).ShouldHaveSingleItem().LotActivityDigest.Lines.ShouldHaveSingleItem();
        line.LotId.ShouldBe(lot);
        line.Kind.ShouldBe(LotActivityKind.Outbid);
        line.RecipientLeads.ShouldBeTrue();
        line.CurrentPrice.MinorUnits.ShouldBe(11000);
        (await StoredFacts(db)).Single(fact => fact.RecipientId == rival).TypeCase
            .ShouldBe(Notification.TypeOneofCase.LotOutbid);
    }

    [Fact]
    public async Task When_OlderOutbidArrivesAfterRegain_Expect_LineKeepsNewerLead()
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
        // строку обратно не переписывает.
        await store.Apply(Decode(EventFactory.Bid(lot, person, version: 5)), Opened, Cancellation);
        (await CloseDueWindows(store, Closes)).ShouldBe(1);

        (await StoredDigests(db)).ShouldHaveSingleItem().LotActivityDigest.Lines.ShouldHaveSingleItem()
            .RecipientLeads.ShouldBeTrue();
    }

    [Fact]
    public async Task When_OlderProxyAnswerArrivesAfterNewerOutbid_Expect_LineStartsFromNewerState()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var lot = EventFactory.NewId();
        var person = EventFactory.NewId();
        var rival = EventFactory.NewId();
        await SetOutbid(db, person, OutbidFrequency.AtMostEvery5Minutes);
        await SetOutbid(db, rival, OutbidFrequency.Off);

        // Шестая версия перебила автоставку человека раньше, чем пришла пятая,
        // в которой эта автоставка ответила сопернику.
        await store.Apply(Decode(PricedBid(lot, person, rival, version: 6, minorUnits: 20000)), Opened, Cancellation);
        var answered = EventFactory.Bid(lot, rival, person, version: 5, proxy: true, answers: true);
        answered.State.Trading.CurrentPrice.MinorUnits = 15000;
        await store.Apply(Decode(answered), Opened.AddSeconds(1), Cancellation);
        (await CloseDueWindows(store, Closes)).ShouldBe(1);

        // Поводом строка автоставки осталась, но лидер и цена — шестой версии.
        (await StoredDigests(db)).ShouldHaveSingleItem().LotActivityDigest.Lines
            .Select(line => (line.Kind, line.CurrentPrice.MinorUnits, line.RecipientLeads))
            .ShouldBe(
            [
                (LotActivityKind.Outbid, 20000L, false),
                (LotActivityKind.ProxyRaised, 20000L, false),
            ]);
    }

    [Fact]
    public async Task When_ProxyAnswersInWindowMode_Expect_ProxyLineInsteadOfOwnFact()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var first = EventFactory.NewId();
        var second = EventFactory.NewId();
        var person = EventFactory.NewId();
        var rival = EventFactory.NewId();
        await SetOutbid(db, person, OutbidFrequency.AtMostEvery15Minutes);

        // Перебитий у человека нет: окно открывает ответ его автоставки.
        await store.Apply(Decode(EventFactory.Bid(first, rival, person, version: 3, proxy: true, answers: true)),
            Opened, Cancellation);
        await store.Apply(Decode(EventFactory.Bid(second, person, rival, version: 3)), Opened.AddSeconds(1),
            Cancellation);

        // Соперник настройку не трогал: его «перебили» пришло сразу, а
        // отдельного «автоставка ответила» человеку нет.
        var immediate = (await StoredFacts(db)).ShouldHaveSingleItem();
        immediate.RecipientId.ShouldBe(rival);
        immediate.TypeCase.ShouldBe(Notification.TypeOneofCase.LotOutbid);

        (await CloseDueWindows(store, Opened.AddMinutes(15))).ShouldBe(1);
        (await StoredDigests(db)).ShouldHaveSingleItem().LotActivityDigest.Lines
            .Select(line => (line.LotId, line.Kind, line.RecipientLeads))
            .ShouldBe(
            [
                (first, LotActivityKind.ProxyRaised, true),
                (second, LotActivityKind.Outbid, false),
            ]);
    }

    [Fact]
    public async Task When_EveryOutbid_Expect_OutbidAndProxyAnswerOneByOne()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var lot = EventFactory.NewId();
        var person = EventFactory.NewId();
        var rival = EventFactory.NewId();
        await SetOutbid(db, person, OutbidFrequency.Every);

        await store.Apply(Decode(EventFactory.Bid(lot, person, rival, version: 3)), Opened, Cancellation);
        await store.Apply(Decode(EventFactory.Bid(lot, rival, person, version: 4, proxy: true, answers: true)),
            Opened, Cancellation);

        (await StoredFacts(db)).Where(fact => fact.RecipientId == person).Select(fact => fact.TypeCase).ShouldBe(
            [Notification.TypeOneofCase.LotOutbid, Notification.TypeOneofCase.LotProxyRaised], ignoreOrder: true);
        (await Count(db, "outbid_digest")).ShouldBe(0);
    }

    [Fact]
    public async Task When_OutbidsOff_Expect_NoOutbidNoProxyAnswerButPurchaseStillSent()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var lot = EventFactory.NewId();
        var person = EventFactory.NewId();
        var rival = EventFactory.NewId();
        await SetOutbid(db, person, OutbidFrequency.Off);
        await SetOutbid(db, rival, OutbidFrequency.Off);

        (await store.Apply(Decode(EventFactory.Bid(lot, person, rival, version: 3)), Opened, Cancellation)).Outcome
            .ShouldBe(AuctionOutcome.Suppressed);
        await store.Apply(Decode(EventFactory.Bid(lot, rival, person, version: 4, proxy: true, answers: true)),
            Opened, Cancellation);
        await store.Apply(DecodeSale(EventFactory.Sold(lot, person, version: 7)), Opened, Cancellation);

        var fact = (await StoredFacts(db)).ShouldHaveSingleItem();
        fact.TypeCase.ShouldBe(Notification.TypeOneofCase.LotPurchased);
        fact.RecipientId.ShouldBe(person);
        (await Count(db, "outbid_digest")).ShouldBe(0);
    }

    [Fact]
    public async Task When_LotSoldWithOpenWindow_Expect_DigestAtOnceWithSalePrice()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var lot = EventFactory.NewId();
        var other = EventFactory.NewId();
        var person = EventFactory.NewId();
        var winner = EventFactory.NewId();
        await SetOutbid(db, person, OutbidFrequency.AtMostEvery60Minutes);
        await SetOutbid(db, winner, OutbidFrequency.AtMostEvery60Minutes);

        await store.Apply(Decode(PricedBid(other, person, EventFactory.NewId(), version: 3, minorUnits: 7000)), Opened,
            Cancellation);
        await store.Apply(Decode(EventFactory.Bid(lot, person, winner, version: 3)), Opened.AddSeconds(1), Cancellation);
        // Победитель тоже был перебит на лоте и вернул лидерство: его окно
        // продажа не закрывает, о лоте ему скажет покупка.
        await store.Apply(Decode(EventFactory.Bid(lot, winner, person, version: 4)), Opened, Cancellation);
        await store.Apply(Decode(EventFactory.Bid(lot, person, winner, version: 5)), Opened, Cancellation);
        await store.Apply(Decode(PricedBid(other, winner, person, version: 4, minorUnits: 8000)), Opened, Cancellation);
        var sold = EventFactory.Sold(lot, winner, version: 7);
        var application = await store.Apply(DecodeSale(sold), Opened.AddMinutes(1), Cancellation);

        application.Created[AuctionFacts.DigestType].ShouldBe(1);
        var digest = (await StoredDigests(db)).ShouldHaveSingleItem();
        digest.RecipientId.ShouldBe(person);
        digest.LotActivityDigest.Lines.Select(line => (line.LotId, line.CurrentPrice.MinorUnits, line.RecipientLeads))
            .ShouldBe(
            [
                (other, 8000L, true),
                (lot, sold.State.Sold.Price.MinorUnits, false),
            ]);
        (await Count(db, "outbid_digest_line")).ShouldBe(1);

        // Окно победителя живо со строкой другого лота и закрывается в свой срок.
        (await CloseDueWindows(store, Opened.AddHours(2))).ShouldBe(1);
        (await StoredDigests(db)).Single(fact => fact.RecipientId == winner).LotActivityDigest.Lines
            .ShouldHaveSingleItem().LotId.ShouldBe(other);
    }

    [Fact]
    public async Task When_WinnerWindowHadOnlySoldLot_Expect_WindowDroppedWithoutDigest()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var lot = EventFactory.NewId();
        var winner = EventFactory.NewId();
        await SetOutbid(db, winner, OutbidFrequency.AtMostEvery60Minutes);

        await store.Apply(Decode(EventFactory.Bid(lot, winner, EventFactory.NewId(), version: 3)), Opened, Cancellation);
        await store.Apply(Decode(EventFactory.Bid(lot, EventFactory.NewId(), winner, version: 4)), Opened, Cancellation);
        await store.Apply(DecodeSale(EventFactory.Sold(lot, winner, version: 7)), Opened, Cancellation);

        (await Count(db, "outbid_digest")).ShouldBe(0);
        (await CloseDueWindows(store, Opened.AddHours(2))).ShouldBe(0);
        (await StoredFacts(db)).Where(fact => fact.RecipientId == winner).Select(fact => fact.TypeCase)
            .ShouldBe([Notification.TypeOneofCase.LotPurchased]);
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
        (await Count(db, "outbid_digest")).ShouldBe(0);
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
        var recipient = (await store.DueDigests(Closes, 256, Cancellation)).ShouldHaveSingleItem();

        var created = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => store.CloseDigest(recipient, Closes, Cancellation)));

        created.Sum().ShouldBe(1);
        (await Count(db, "notification")).ShouldBe(1);
    }

    [Fact]
    public async Task When_BidsRaceWindowClose_Expect_EveryLineInExactlyOneDigest()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var person = EventFactory.NewId();
        await SetOutbid(db, person, OutbidFrequency.AtMostEvery5Minutes);
        await store.Apply(Decode(EventFactory.Bid(EventFactory.NewId(), person)), Opened, Cancellation);

        // Перебития на новых лотах идут вместе с закрытием наступившего окна:
        // каждое попадает либо в закрываемую сводку, либо в следующее окно.
        var lots = Enumerable.Range(0, 8).Select(_ => EventFactory.NewId()).ToArray();
        var bids = lots.Select(lot => (Func<Task>)(() => store.Apply(Decode(EventFactory.Bid(lot, person)), Closes, Cancellation)));
        var close = (Func<Task>)(() => store.CloseDigest(Guid.Parse(person), Closes, Cancellation));
        await Task.WhenAll(bids.Append(close).Select(run => Task.Run(run)));
        await CloseDueWindows(store, Closes.AddMinutes(5));

        var listed = (await StoredDigests(db)).SelectMany(fact => fact.LotActivityDigest.Lines).Select(line => line.LotId)
            .ToArray();
        listed.Length.ShouldBe(lots.Length + 1);
        listed.ShouldBeUnique();
        lots.ShouldBeSubsetOf(listed);
        (await Count(db, "outbid_digest")).ShouldBe(0);
    }

    [Fact]
    public async Task When_OldWindowsMigrated_Expect_OneDigestPerPersonWithTheirLots()
    {
        using var db = Database();
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var store = Store(source);
        var person = Guid.NewGuid();
        var first = Guid.NewGuid();
        var second = Guid.NewGuid();

        // Окна прежней формы, как их оставил бы сервис до выкладки: на одном
        // лоте человек всё ещё перебит, на другом вернул лидерство.
        await Execute(db, """
            CREATE TABLE outbid_window (
                lot_id uuid NOT NULL, recipient_id uuid NOT NULL, opened_at timestamptz NOT NULL,
                due_at timestamptz NOT NULL, outbid boolean NOT NULL, last_event_id uuid NOT NULL,
                last_version bigint NOT NULL, price_minor_units bigint NOT NULL, price_currency text NOT NULL,
                PRIMARY KEY (lot_id, recipient_id));
            INSERT INTO outbid_window VALUES
                (@First, @Person, @Opened, @Early, true, gen_random_uuid(), 3, 10000, 'RUB'),
                (@Second, @Person, @Later, @Late, false, gen_random_uuid(), 4, 20000, 'RUB');
            """, new
        {
            First = first, Second = second, Person = person,
            Opened = Opened.UtcDateTime, Later = Opened.AddMinutes(1).UtcDateTime,
            Early = Closes.UtcDateTime, Late = Closes.AddMinutes(1).UtcDateTime,
        });
        await Execute(db, Migrations.List().Single(migration => migration.Version == 26).Sql, new { });

        (await Count(db, "outbid_digest")).ShouldBe(1);
        (await CloseDueWindows(store, Closes)).ShouldBe(1);
        (await StoredDigests(db)).ShouldHaveSingleItem().LotActivityDigest.Lines
            .Select(line => (line.LotId, line.CurrentPrice.MinorUnits, line.RecipientLeads))
            .ShouldBe(
            [
                (first.ToString(), 10000L, false),
                (second.ToString(), 20000L, true),
            ]);
    }

    [Fact]
    public async Task When_WindowDueInRunningService_Expect_SweeperPublishesOneDigest()
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
        fact.TypeCase.ShouldBe(Notification.TypeOneofCase.LotActivityDigest);
        fact.RecipientId.ShouldBe(person);
        await Eventually(() => Count(db, "outbid_digest"), count => count == 0);
    }

    [Fact]
    public async Task When_ServiceKilledWithOpenWindow_Expect_DigestOnceAfterRestart()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        var person = EventFactory.NewId();
        await SetOutbid(db, person, OutbidFrequency.AtMostEvery15Minutes);

        SiloEndpoint sameEndpoint;
        using (var service = await ServiceProcess.Start(db.ConnectionString, nats.Url))
        {
            sameEndpoint = service.Endpoint;
            await nats.Publish(AuctionFeed.BidPlacedSubject, EventFactory.Bid(EventFactory.NewId(), person));
            await Eventually(() => Count(db, "outbid_digest"), count => count == 1);
            service.Kill();
        }

        // Срок окна проходит, пока сервиса нет; подобрать его может только
        // проход по таблице после подъёма.
        await ExpireWindows(db);
        await using (await SiloUnderTest.StartAt(db.ConnectionString, sameEndpoint,
            "--Notifications:OutbidWindows:SweepPeriod=00:00:01"))
        {
            await Eventually(() => Count(db, "outbid_digest"), count => count == 0);
        }

        // Повторный проход после рестарта второй сводки не даёт.
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        (await CloseDueWindows(Store(source), DateTimeOffset.UtcNow.AddHours(1))).ShouldBe(0);
        var digest = (await StoredFacts(db)).ShouldHaveSingleItem();
        digest.TypeCase.ShouldBe(Notification.TypeOneofCase.LotActivityDigest);
        digest.RecipientId.ShouldBe(person);
    }
}
