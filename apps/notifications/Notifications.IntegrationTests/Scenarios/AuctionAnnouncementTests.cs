using Dapper;
using Notifications.Auction;
using Notifications.Facts;
using Notifications.Infrastructure;
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
/// Вести о новом аукционе и об открытии торгов (PER-646) через настоящие
/// JetStream, PostgreSQL и composition root. Адресат — держатель права ставок:
/// участник несёт его набором круга, допущенный гость — записью, гость без права
/// и заблокированный не получают ничего.
/// </summary>
/// <remarks>
/// Люди и их настройки кладутся в базу напрямую: путь события Identity в
/// реплику проверяет <see cref="FactReplicaTests" />, а здесь предмет — решение
/// «кому положено».
/// </remarks>
public class AuctionAnnouncementTests
{
    private const string PublishedSubject = "events.auction.auction_published";
    private const string HiddenSubject = "events.auction.auction_hidden";
    private const string StartedSubject = "events.auction.prebidding_started";

    private const string HeldRelay = "--Notifications:Dispatch:Period=01:00:00";

    /// <summary>
    /// Публикация: по одному факту каждому держателю права ставок, повтор того же
    /// события второго факта не даёт, а сходка и её название приезжают из реплики.
    /// </summary>
    [Fact]
    public async Task When_AuctionPublished_Expect_OneFactPerPlaceBidsHolder()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var auction = EventFactory.AuctionOfMeetup();
        var meetup = EventFactory.NewId();
        await Meetup(db, title: "Пятничная", meetupId: meetup);
        var (member, guest, outsider, blocked) =
            (await Person(db, MemberHolding), await Person(db, GuestHolding),
                await Person(db, new Holding("guest", [], [])), await Person(db, blocked: true, MemberHolding));

        var published = EventFactory.AuctionPublished(auction, meetup);
        await nats.Publish(PublishedSubject, published);

        var facts = await Eventually(nats.PublishedFacts, facts => facts.Count == 2);
        facts.Select(entry => Guid.Parse(entry.Fact.RecipientId))
            .ShouldBe([member, guest], ignoreOrder: true);
        facts.Select(entry => entry.Fact.RecipientId).ShouldNotContain(outsider.ToString());
        facts.Select(entry => entry.Fact.RecipientId).ShouldNotContain(blocked.ToString());

        foreach (var (fact, messageId) in facts)
        {
            messageId.ShouldBe(fact.NotificationId);
            fact.TypeCase.ShouldBe(Notification.TypeOneofCase.AuctionPublished);
            fact.Cause.AuctionEventId.ShouldBe(published.EventId);
            fact.AuctionPublished.AuctionId.ShouldBe(auction);
            fact.AuctionPublished.MeetupId.ShouldBe(meetup);
            fact.AuctionPublished.MeetupTitle.ShouldBe("Пятничная");
            // Черновик недели не имеет: поле отсутствует, а не пусто.
            fact.AuctionPublished.OnlinePhase.ShouldBeNull();
        }
        facts.Single(entry => Guid.Parse(entry.Fact.RecipientId) == member).Subject
            .ShouldBe(NotificationSubjects.For(NotificationSubjects.Hub));
        facts.Single(entry => Guid.Parse(entry.Fact.RecipientId) == guest).Subject
            .ShouldBe(NotificationSubjects.For(NotificationSubjects.Auction));

        await nats.Publish(PublishedSubject, published, messageId: Guid.NewGuid().ToString());
        await Eventually(() => Task.FromResult(silo.Service<AuctionTelemetry>().Total("duplicate")), count => count == 1);
        (await nats.PublishedFacts()).Count.ShouldBe(2);
    }

    /// <summary>
    /// Открытие онлайн-недели: весть с дедлайном недели, тот же круг адресатов.
    /// </summary>
    [Fact]
    public async Task When_TradingStarted_Expect_TradingOpenedFactWithDeadline()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var auction = EventFactory.AuctionOfMeetup();
        var meetup = EventFactory.NewId();
        await Meetup(db, title: "Неделя", meetupId: meetup);
        var guest = await Person(db, GuestHolding);
        var phase = new global::Auction.V1.OnlinePhase
        {
            OpensAt = EventFactory.Committed.AddDays(-1).ToString("O"),
            ClosesAt = EventFactory.Committed.AddDays(6).ToString("O"),
            ClosesLots = true,
        };

        var started = EventFactory.PrebiddingStarted(auction, meetup, phase);
        await nats.Publish(StartedSubject, started);

        var facts = await Eventually(nats.PublishedFacts, facts => facts.Count == 1);
        var fact = facts.Single().Fact;
        fact.RecipientId.ShouldBe(guest.ToString());
        fact.TypeCase.ShouldBe(Notification.TypeOneofCase.AuctionTradingOpened);
        fact.Cause.AuctionEventId.ShouldBe(started.EventId);
        fact.AuctionTradingOpened.MeetupTitle.ShouldBe("Неделя");
        fact.AuctionTradingOpened.OnlinePhase.ClosesAt.ShouldBe(phase.ClosesAt);
        silo.Service<AuctionTelemetry>().Total("announcement").ShouldBe(1);
    }

    /// <summary>
    /// Выключенный выключатель вестей гасит обе вести: строк в базе нет и в шину
    /// ничего не уходит.
    /// </summary>
    [Fact]
    public async Task When_AnnouncementsSwitchedOff_Expect_NoFacts()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var auction = EventFactory.AuctionOfMeetup();
        var meetup = EventFactory.NewId();
        await Meetup(db, meetupId: meetup);
        var switcher = await Person(db, MemberHolding);
        await SetAuctionAnnouncements(db, switcher.ToString(), enabled: false);

        await nats.Publish(PublishedSubject, EventFactory.AuctionPublished(auction, meetup));
        await nats.Publish(StartedSubject, EventFactory.PrebiddingStarted(auction, meetup,
            new global::Auction.V1.OnlinePhase { OpensAt = EventFactory.Committed.ToString("O") }));

        await Eventually(() => Task.FromResult(silo.Service<AuctionTelemetry>().Total("announcement")), count => count == 2);
        (await Count(db, "notification")).ShouldBe(0);
        (await nats.PublishedFacts()).ShouldBeEmpty();
    }

    /// <summary>
    /// Аукцион сняли с публикации, пока весть о нём ждала релея: строка снята с
    /// причиной <c>auction_hidden</c>, и следующий проход в шину ничего не выносит.
    /// </summary>
    [Fact]
    public async Task When_AuctionHiddenBeforeRelay_Expect_PendingFactWithdrawn()
    {
        using var db = Database();
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, HeldRelay);
        var auction = EventFactory.AuctionOfMeetup();
        var meetup = EventFactory.NewId();
        await Meetup(db, meetupId: meetup);
        await Person(db, MemberHolding);
        var store = silo.Service<NotificationStore>();

        await nats.Publish(PublishedSubject, EventFactory.AuctionPublished(auction, meetup));
        await Eventually(() => Task.FromResult(silo.Service<AuctionTelemetry>().Total("announcement")), count => count == 1);
        var row = (await Rows(db)).Single();
        row.Type.ShouldBe(AuctionFacts.PublishedType);
        row.DispatchedAt.ShouldBeNull();
        row.WithdrawnAt.ShouldBeNull();

        await nats.Publish(HiddenSubject, EventFactory.AuctionHidden(auction, meetup));

        await Eventually(() => Task.FromResult(silo.Service<AuctionTelemetry>().Total("announcement_withdrawn")),
            count => count == 1);
        var withdrawn = (await Rows(db)).Single();
        withdrawn.WithdrawnAt.ShouldNotBeNull();
        withdrawn.WithdrawalReason.ShouldBe(NotificationFacts.WithdrawnOnAuctionHidden);
        withdrawn.DispatchedAt.ShouldBeNull();

        (await Relay(store)).ShouldBeEmpty();
        (await nats.PublishedFacts()).ShouldBeEmpty();
    }

    private static async Task<IReadOnlyList<Notification>> Relay(NotificationStore store)
    {
        var facts = new List<Notification>();
        await store.Dispatch(100, 3, (pending, _) =>
        {
            facts.Add(Notification.Parser.ParseFrom(pending.Payload));
            return Task.CompletedTask;
        }, DateTimeOffset.UtcNow, Cancellation);
        return facts;
    }

    private static async Task<IReadOnlyList<AnnouncementRow>> Rows(IsolatedDatabase db)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        return (await connection.QueryAsync<AnnouncementRow>(
            """
            SELECT type AS Type, dispatched_at AS DispatchedAt, withdrawn_at AS WithdrawnAt,
                   withdrawal_reason AS WithdrawalReason
            FROM notification
            ORDER BY created_at, type;
            """)).ToList();
    }

    private sealed class AnnouncementRow
    {
        public string Type { get; init; } = "";

        public DateTime? DispatchedAt { get; init; }

        public DateTime? WithdrawnAt { get; init; }

        public string? WithdrawalReason { get; init; }
    }
}
