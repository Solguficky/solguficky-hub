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

    [Fact]
    public async Task When_AnotherPersonDismisses_Expect_OneFactToDismissed()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var dismissed = await Person(db, MemberHolding);

        await nats.Publish(
            DismissedSubject,
            EventFactory.OrganizerChange(
                EventFactory.NewId(), version: 3, dismissed.ToString(), appointed: false, performedBy: EventFactory.NewId()));

        var facts = await Eventually(nats.PublishedFacts, facts => facts.Count == 1);

        var (fact, _) = facts.Single();
        fact.RecipientId.ShouldBe(dismissed.ToString());
        fact.TypeCase.ShouldBe(Notification.TypeOneofCase.OrganizerDismissed);
        fact.OrganizerDismissed.Meetup.Title.ShouldBe("Сходка");
    }

    /// <summary>
    /// Выход по своей воле — то же событие с performed_by, равным вышедшему:
    /// факта нет. Ожидание на реплике, а не пауза, доказывает, что событие
    /// обработано и осталось без факта.
    /// </summary>
    [Fact]
    public async Task When_PersonLeavesOnOwnWill_Expect_NoFact()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var replica = silo.Service<ReplicaTelemetry>();
        var leaver = await Person(db, MemberHolding);

        await nats.Publish(
            DismissedSubject,
            EventFactory.OrganizerChange(
                EventFactory.NewId(), version: 3, leaver.ToString(), appointed: false, performedBy: leaver.ToString()));

        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.MeetupsSource, "applied")), count => count == 1);
        (await Count(db, "organizer_dismissed")).ShouldBe(0);
        (await CountRows(db, "notification")).ShouldBe(0);
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
