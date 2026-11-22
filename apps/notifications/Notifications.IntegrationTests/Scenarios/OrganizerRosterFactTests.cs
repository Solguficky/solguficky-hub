using Dapper;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.Replica;
using Notifications.TestKit;
using Notifications.V1;
using Npgsql;
using Shouldly;
using Xunit;
using static Notifications.IntegrationTests.Infrastructure.FactFixtures;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Весть о составе организаторов (PER-746, ADR-076, п. 8): события Meetups
/// <c>meetup_organizer_appointed</c> и <c>meetup_organizer_dismissed</c> в
/// стриме дают один адресный факт затронутому человеку, если действовал другой;
/// выход по своей воле факта не порождает.
/// </summary>
public class OrganizerRosterFactTests
{
    private const string AppointedSubject = "events.meetups.meetup_organizer_appointed";
    private const string DismissedSubject = "events.meetups.meetup_organizer_dismissed";

    [Fact]
    public async Task When_AnotherPersonAppoints_Expect_OneFactToAppointedWithCard()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var appointed = await Person(db, MemberHolding);
        var meetupId = EventFactory.NewId();

        var appointment = EventFactory.OrganizerChange(
            meetupId, version: 3, appointed.ToString(), appointed: true, performedBy: EventFactory.NewId());
        appointment.RequestId = "req-roster";
        await nats.Publish(AppointedSubject, appointment);

        var facts = await Eventually(nats.PublishedFacts, facts => facts.Count == 1);

        var (fact, messageId) = facts.Single();
        messageId.ShouldBe(fact.NotificationId);
        fact.RecipientId.ShouldBe(appointed.ToString());
        fact.Cause.MeetupEventId.ShouldBe(appointment.EventId);
        fact.RequestId.ShouldBe("req-roster");
        fact.TypeCase.ShouldBe(Notification.TypeOneofCase.OrganizerAppointed);
        fact.OrganizerAppointed.Meetup.Id.ShouldBe(meetupId);
        fact.HasNotAfter.ShouldBeTrue();
        facts.Single().Subject.ShouldBe("events.notifications.notification_created.hub");
        (await Count(db, "organizer_appointed")).ShouldBe(1);
    }

    /// <summary>
    /// Снятие администратором (ADR-076, дополнение 2026-11-22, PER-930): снятому
    /// остаётся прежняя весть, каждому оставшемуся приходит весть о составе, а
    /// администратор вне состава не получает ничего.
    /// </summary>
    [Fact]
    public async Task When_AdministratorDismisses_Expect_DismissedFactToDismissedAndRosterFactToRemaining()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var author = await Person(db, MemberHolding);
        var remaining = await Person(db, MemberHolding);
        var dismissed = await Person(db, MemberHolding);
        var administrator = await Person(db, AdminHolding);

        await nats.Publish(
            DismissedSubject,
            EventFactory.OrganizerChange(
                EventFactory.NewId(),
                version: 3,
                dismissed.ToString(),
                appointed: false,
                performedBy: administrator.ToString(),
                author: author.ToString(),
                organizers: [remaining.ToString()]));

        var facts = await Eventually(nats.PublishedFacts, facts => facts.Count == 3);
        var notifications = facts.Select(published => published.Fact).ToArray();

        notifications.Single(fact => fact.TypeCase == Notification.TypeOneofCase.OrganizerDismissed)
            .RecipientId.ShouldBe(dismissed.ToString());

        var roster = notifications.Where(fact => fact.TypeCase == Notification.TypeOneofCase.OrganizerRosterChanged).ToArray();
        roster.Select(fact => fact.RecipientId).ShouldBe(
            [author.ToString(), remaining.ToString()], ignoreOrder: true);
        roster.ShouldAllBe(fact => fact.OrganizerRosterChanged.OrganizerCount == 2);
        roster.ShouldAllBe(fact => fact.OrganizerRosterChanged.Meetup.Title == "Сходка");
        notifications.ShouldNotContain(fact => fact.RecipientId == administrator.ToString());

        (await Count(db, "organizer_dismissed")).ShouldBe(1);
        (await Count(db, "organizer_roster_changed")).ShouldBe(2);
    }

    /// <summary>
    /// Выход по своей воле (ADR-076, дополнение 2026-11-22, PER-930): самому
    /// вышедшему — ничего, каждому оставшемуся — весть о составе с числом
    /// записей по снимку.
    /// </summary>
    [Fact]
    public async Task When_PersonLeavesOnOwnWill_Expect_RosterFactToEveryRemainingOrganizerAndNoneToLeaver()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var author = await Person(db, MemberHolding);
        var remaining = await Person(db, MemberHolding);
        var leaver = await Person(db, MemberHolding);

        await nats.Publish(
            DismissedSubject,
            EventFactory.OrganizerChange(
                EventFactory.NewId(),
                version: 3,
                leaver.ToString(),
                appointed: false,
                performedBy: leaver.ToString(),
                author: author.ToString(),
                organizers: [remaining.ToString()]));

        var facts = await Eventually(nats.PublishedFacts, facts => facts.Count == 2);
        var notifications = facts.Select(published => published.Fact).ToArray();

        notifications.ShouldAllBe(fact => fact.TypeCase == Notification.TypeOneofCase.OrganizerRosterChanged);
        notifications.Select(fact => fact.RecipientId).ShouldBe(
            [author.ToString(), remaining.ToString()], ignoreOrder: true);
        notifications.ShouldAllBe(fact => fact.OrganizerRosterChanged.OrganizerCount == 2);
        notifications.ShouldNotContain(fact => fact.RecipientId == leaver.ToString());

        (await Count(db, "organizer_dismissed")).ShouldBe(0);
        (await Count(db, "organizer_roster_changed")).ShouldBe(2);
    }

    /// <summary>
    /// Отсев тот же, что у вести затронутому: заблокированному и гостю вести о
    /// составе нет — некому открыть сходку (PER-930, ADR-076, дополнение
    /// 2026-11-22).
    /// </summary>
    [Theory]
    [InlineData("blocked")]
    [InlineData("guest")]
    public async Task When_RemainingOrganizerIsBlockedOrGuest_Expect_NoRosterFactToThem(string kind)
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var author = await Person(db, MemberHolding);
        var other = kind switch
        {
            "blocked" => await Person(db, blocked: true, MemberHolding),
            _ => await Person(db, GuestHolding),
        };
        var leaver = await Person(db, MemberHolding);

        await nats.Publish(
            DismissedSubject,
            EventFactory.OrganizerChange(
                EventFactory.NewId(),
                version: 3,
                leaver.ToString(),
                appointed: false,
                performedBy: leaver.ToString(),
                author: author.ToString(),
                organizers: [other.ToString()]));

        var facts = await Eventually(
            nats.PublishedFacts,
            facts => facts.Count(published => published.Fact.TypeCase == Notification.TypeOneofCase.OrganizerRosterChanged)
                == 1);
        var notifications = facts.Select(published => published.Fact).ToArray();

        notifications.ShouldContain(fact => fact.RecipientId == author.ToString());
        notifications.ShouldNotContain(fact => fact.RecipientId == other.ToString());
        notifications.ShouldNotContain(fact => fact.RecipientId == leaver.ToString());
        (await Count(db, "organizer_roster_changed")).ShouldBe(1);
    }

    /// <summary>
    /// Человека, которого реплика Identity ещё не знает, отсев не убирает: события
    /// двух источников приходят в разном порядке, и потерянное сообщение хуже
    /// лишнего (PER-930).
    /// </summary>
    [Fact]
    public async Task When_RemainingOrganizerIsUnknownToReplica_Expect_RosterFactToThem()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var author = await Person(db, MemberHolding);
        var unknown = Guid.CreateVersion7();
        var leaver = await Person(db, MemberHolding);

        await nats.Publish(
            DismissedSubject,
            EventFactory.OrganizerChange(
                EventFactory.NewId(),
                version: 3,
                leaver.ToString(),
                appointed: false,
                performedBy: leaver.ToString(),
                author: author.ToString(),
                organizers: [unknown.ToString()]));

        var facts = await Eventually(
            nats.PublishedFacts,
            facts => facts.Count(published => published.Fact.TypeCase == Notification.TypeOneofCase.OrganizerRosterChanged)
                == 2);
        var notifications = facts.Select(published => published.Fact).ToArray();

        notifications.ShouldContain(fact => fact.RecipientId == unknown.ToString());
        notifications.ShouldNotContain(fact => fact.RecipientId == leaver.ToString());
        (await Count(db, "organizer_roster_changed")).ShouldBe(2);
    }

    /// <summary>
    /// Пустой состав получателей факта о составе не даёт: последнего организатора
    /// снял администратор, и вещать в составе больше некого (PER-930).
    /// </summary>
    [Fact]
    public async Task When_RosterIsEmptied_Expect_DismissedFactOnly()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var author = await Person(db, MemberHolding);
        var administrator = await Person(db, AdminHolding);

        await nats.Publish(
            DismissedSubject,
            EventFactory.OrganizerChange(
                EventFactory.NewId(),
                version: 3,
                author.ToString(),
                appointed: false,
                performedBy: administrator.ToString(),
                author: author.ToString()));

        var facts = await Eventually(nats.PublishedFacts, facts => facts.Count == 1);
        var (dismissedFact, _) = facts.Single();

        dismissedFact.RecipientId.ShouldBe(author.ToString());
        dismissedFact.TypeCase.ShouldBe(Notification.TypeOneofCase.OrganizerDismissed);
        (await Count(db, "organizer_roster_changed")).ShouldBe(0);
    }

    /// <summary>Повтор события не удваивает ни одну из двух вестей (PER-930).</summary>
    [Fact]
    public async Task When_DismissalRedelivered_Expect_RosterFactNotDoubled()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var replica = silo.Service<ReplicaTelemetry>();
        var author = await Person(db, MemberHolding);
        var remaining = await Person(db, MemberHolding);
        var dismissed = await Person(db, MemberHolding);

        var message = EventFactory.OrganizerChange(
            EventFactory.NewId(),
            version: 3,
            dismissed.ToString(),
            appointed: false,
            performedBy: author.ToString(),
            author: author.ToString(),
            organizers: [remaining.ToString()]);
        await nats.Publish(DismissedSubject, message);
        await Eventually(() => Count(db, "organizer_roster_changed"), count => count == 1);

        // Тот же event_id под другим Nats-Msg-Id: сервер его не отсекает.
        await nats.Publish(DismissedSubject, message, messageId: Guid.NewGuid().ToString());
        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.MeetupsSource, "duplicate")), count => count == 1);

        (await Count(db, "organizer_roster_changed")).ShouldBe(1);
        (await Count(db, "organizer_dismissed")).ShouldBe(1);
    }

    [Fact]
    public async Task When_EventRedelivered_Expect_FactNotDoubled()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var replica = silo.Service<ReplicaTelemetry>();
        var appointed = await Person(db, MemberHolding);

        var appointment = EventFactory.OrganizerChange(
            EventFactory.NewId(), version: 3, appointed.ToString(), appointed: true, performedBy: EventFactory.NewId());
        await nats.Publish(AppointedSubject, appointment);
        await Eventually(() => Count(db, "organizer_appointed"), count => count == 1);

        // Тот же event_id под другим Nats-Msg-Id: сервер его не отсекает.
        await nats.Publish(AppointedSubject, appointment, messageId: Guid.NewGuid().ToString());
        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.MeetupsSource, "duplicate")), count => count == 1);

        (await Count(db, "organizer_appointed")).ShouldBe(1);
    }

    /// <summary>
    /// Заблокированному и гостю весть не нужна: некому открыть сходку в боте
    /// хаба. Сообщение о тех, кого реплика ещё не знает, не теряется — порядок
    /// событий двух источников не гарантирован.
    /// </summary>
    [Theory]
    [InlineData("blocked", 0)]
    [InlineData("guest", 0)]
    [InlineData("unknown", 1)]
    public async Task When_RecipientCannotReachHub_Expect_NoFactUnlessUnknown(string kind, int expected)
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var replica = silo.Service<ReplicaTelemetry>();
        var person = kind switch
        {
            "blocked" => await Person(db, blocked: true, MemberHolding),
            "guest" => await Person(db, GuestHolding),
            _ => Guid.CreateVersion7(),
        };

        await nats.Publish(
            AppointedSubject,
            EventFactory.OrganizerChange(
                EventFactory.NewId(), version: 3, person.ToString(), appointed: true, performedBy: EventFactory.NewId()));

        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.MeetupsSource, "applied")), count => count == 1);
        (await Count(db, "organizer_appointed")).ShouldBe(expected);
    }

    private static async Task<long> Count(IsolatedDatabase db, string type)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        return await connection.ExecuteScalarAsync<long>("SELECT count(*) FROM notification WHERE type = @Type;", new { Type = type });
    }
}
