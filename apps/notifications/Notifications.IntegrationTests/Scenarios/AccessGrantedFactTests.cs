using Dapper;
using Identity.V1;
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
/// Сообщение заявителю о допуске (PER-442): событие Identity
/// <c>application_admitted</c> в стриме даёт адресный факт самому заявителю;
/// при переходе между кругами одновременно рождается факт смены круга прежнему.
/// </summary>
public class AccessGrantedFactTests
{
    private const string ApplicationAdmittedSubject = "events.identity.application_admitted";
    private const string RoleGrantedSubject = "events.identity.role_granted";
    private const string ProfileBlockedSubject = "events.identity.profile_blocked";

    [Fact]
    public async Task When_GuestBecomesMember_Expect_CircleChangeDeliveredToPreviousCircle()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var person = EventFactory.NewId();

        await nats.Publish(RoleGrantedSubject, EventFactory.RoleGrant(person, 2, GlobalRole.Guest));
        await Eventually(() => CountRows(db, "identity_replica"), count => count == 1);
        await nats.Publish(RoleGrantedSubject, EventFactory.RoleGrant(person, 3, GlobalRole.Member));

        var published = await Eventually(nats.PublishedFacts, facts => facts.Count == 1);
        var fact = published.Single();
        fact.Subject.ShouldBe("events.notifications.notification_created.auction");
        fact.Fact.TypeCase.ShouldBe(Notification.TypeOneofCase.CircleChanged);
        fact.Fact.CircleChanged.PreviousCircle.ShouldBe(GlobalRole.Guest);
        fact.Fact.CircleChanged.CurrentCircle.ShouldBe(GlobalRole.Member);
    }

    [Fact]
    public async Task When_MemberBecomesGuest_Expect_CircleChangeDeliveredToPreviousCircle()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var person = EventFactory.NewId();

        await nats.Publish(RoleGrantedSubject, EventFactory.RoleGrant(person, 2, GlobalRole.Member));
        await Eventually(() => CountRows(db, "identity_replica"), count => count == 1);
        var demotion = EventFactory.Identity(person, 3);
        demotion.State.Role = GlobalRole.Guest;
        demotion.State.Rights.Clear();
        demotion.State.Rights.Add(AccessRight.Auction);
        demotion.RoleRevoked = new RoleRevoked { Role = GlobalRole.Member };
        await nats.Publish("events.identity.role_revoked", demotion);

        var published = await Eventually(nats.PublishedFacts, facts => facts.Count == 1);
        var fact = published.Single();
        fact.Subject.ShouldBe("events.notifications.notification_created.hub");
        fact.Fact.TypeCase.ShouldBe(Notification.TypeOneofCase.CircleChanged);
        fact.Fact.CircleChanged.PreviousCircle.ShouldBe(GlobalRole.Member);
        fact.Fact.CircleChanged.CurrentCircle.ShouldBe(GlobalRole.Guest);
    }

    [Theory]
    [InlineData(GlobalRole.Member)]
    [InlineData(GlobalRole.Guest)]
    public async Task When_ApplicantAdmitted_Expect_OneFactToApplicantWithCircle(GlobalRole circle)
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await Person(db, AdminCircle);
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);

        var applicant = EventFactory.NewId();
        var admission = EventFactory.Admission(applicant, version: 4, circle);
        await nats.Publish(ApplicationAdmittedSubject, admission);

        var facts = await Eventually(nats.PublishedFacts, facts => facts.Count == 1);

        var (fact, messageId) = facts.Single();
        facts.Single().Subject.ShouldBe(circle == GlobalRole.Member
            ? "events.notifications.notification_created.hub"
            : "events.notifications.notification_created.auction");
        messageId.ShouldBe(fact.NotificationId);
        fact.RecipientId.ShouldBe(applicant);
        fact.Cause.IdentityEventId.ShouldBe(admission.EventId);
        fact.TypeCase.ShouldBe(Notification.TypeOneofCase.AccessGranted);
        fact.AccessGranted.Circle.ShouldBe(circle);
        fact.HasNotAfter.ShouldBeTrue();
        fact.HasRequestId.ShouldBeFalse();
    }

    [Fact]
    public async Task When_GuestAdmittedToCommunity_Expect_AccessAndCircleFactsOnTheirRoutes()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await Person(db, AdminCircle);
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var applicant = EventFactory.NewId();

        await nats.Publish("events.identity.application_submitted",
            EventFactory.Application(applicant, 2, GlobalRole.Member, held: GlobalRole.Guest));
        await Eventually(() => CountRows(db, "identity_replica"), count => count == 1);
        await nats.Publish(ApplicationAdmittedSubject, EventFactory.Admission(applicant, 3, GlobalRole.Member));

        var published = await Eventually(
            nats.PublishedFacts,
            facts => facts.Any(fact => fact.Fact.TypeCase == Notification.TypeOneofCase.AccessGranted)
                && facts.Any(fact => fact.Fact.TypeCase == Notification.TypeOneofCase.CircleChanged));
        var access = published.Single(fact => fact.Fact.TypeCase == Notification.TypeOneofCase.AccessGranted);
        var circle = published.Single(fact => fact.Fact.TypeCase == Notification.TypeOneofCase.CircleChanged);

        access.Subject.ShouldBe("events.notifications.notification_created.hub");
        circle.Subject.ShouldBe("events.notifications.notification_created.auction");
        circle.Fact.CircleChanged.PreviousCircle.ShouldBe(GlobalRole.Guest);
        circle.Fact.CircleChanged.CurrentCircle.ShouldBe(GlobalRole.Member);
    }

    [Fact]
    public async Task When_AdmissionRedelivered_Expect_FactNotDoubled()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var replica = silo.Service<ReplicaTelemetry>();

        var admission = EventFactory.Admission(EventFactory.NewId(), version: 4, GlobalRole.Guest);
        await nats.Publish(ApplicationAdmittedSubject, admission);
        await Eventually(() => Granted(db), count => count == 1);

        // Тот же event_id под другим Nats-Msg-Id: сервер его не отсекает.
        await nats.Publish(ApplicationAdmittedSubject, admission, messageId: Guid.NewGuid().ToString());
        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.IdentitySource, "duplicate")), count => count == 1);

        (await Granted(db)).ShouldBe(1);
    }

    /// <summary>
    /// Допуск, вернувшийся после Nak, когда человека уже заблокировали, о
    /// доступе не сообщает: последнее слово реплики круга не держит.
    /// </summary>
    [Fact]
    public async Task When_AdmissionArrivesAfterBlock_Expect_NoFact()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var replica = silo.Service<ReplicaTelemetry>();

        var applicant = EventFactory.NewId();
        await nats.Publish(ProfileBlockedSubject, EventFactory.Identity(applicant, version: 5, blocked: true));
        await nats.Publish(ApplicationAdmittedSubject, EventFactory.Admission(applicant, version: 4, GlobalRole.Member));

        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.IdentitySource, "stale")), count => count == 1);
        (await Granted(db)).ShouldBe(0);
    }

    /// <summary>
    /// Выдача роли сама по себе допуском по заявке не является: её дают и
    /// белый список, и вложенность, и о них заявителю не пишут.
    /// </summary>
    [Fact]
    public async Task When_RoleGrantedWithoutAdmission_Expect_NoFact()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var replica = silo.Service<ReplicaTelemetry>();

        await nats.Publish(RoleGrantedSubject, EventFactory.Identity(EventFactory.NewId(), version: 2));

        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.IdentitySource, "applied")), count => count == 1);
        (await Granted(db)).ShouldBe(0);
    }

    private static async Task<long> Granted(IsolatedDatabase db)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        return await connection.ExecuteScalarAsync<long>("SELECT count(*) FROM notification WHERE type = 'access_granted';");
    }

}
