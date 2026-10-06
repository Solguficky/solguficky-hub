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
/// Сообщение человеку о выдаче роли администратора (PER-468): событие Identity
/// <c>role_granted</c> с ролью <c>admin</c> в стриме даёт один адресный факт
/// самому человеку; выдача круга фактом не является.
/// </summary>
public class RoleGrantedFactTests
{
    private const string RoleGrantedSubject = "events.identity.role_granted";
    private const string ProfileBlockedSubject = "events.identity.profile_blocked";

    [Fact]
    public async Task When_AdminGranted_Expect_OneFactToPersonWithRole()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await Person(db, "admin", "member", "public");
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);

        var person = EventFactory.NewId();
        var grant = EventFactory.RoleGrant(person, version: 3, GlobalRole.Admin);
        await nats.Publish(RoleGrantedSubject, grant);

        var facts = await Eventually(nats.PublishedFacts, facts => facts.Count == 1);

        var (fact, messageId) = facts.Single();
        messageId.ShouldBe(fact.NotificationId);
        fact.RecipientId.ShouldBe(person);
        fact.Cause.IdentityEventId.ShouldBe(grant.EventId);
        fact.TypeCase.ShouldBe(Notification.TypeOneofCase.RoleGranted);
        fact.RoleGranted.Role.ShouldBe(GlobalRole.Admin);
        fact.HasNotAfter.ShouldBeTrue();
        fact.HasRequestId.ShouldBeFalse();
    }

    /// <summary>
    /// Выдачу круга дают и белый список, и вложенность, и о ней человеку не
    /// пишут: о допуске по заявке сообщает <c>access_granted</c>.
    /// </summary>
    [Theory]
    [InlineData(GlobalRole.Maintainer)]
    [InlineData(GlobalRole.Member)]
    [InlineData(GlobalRole.Public)]
    public async Task When_CircleGranted_Expect_NoFact(GlobalRole role)
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var replica = silo.Service<ReplicaTelemetry>();

        await nats.Publish(RoleGrantedSubject, EventFactory.RoleGrant(EventFactory.NewId(), version: 3, role));

        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.IdentitySource, "applied")), count => count == 1);
        (await Granted(db)).ShouldBe(0);
    }

    [Fact]
    public async Task When_GrantRedelivered_Expect_FactNotDoubled()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var replica = silo.Service<ReplicaTelemetry>();

        var grant = EventFactory.RoleGrant(EventFactory.NewId(), version: 3, GlobalRole.Admin);
        await nats.Publish(RoleGrantedSubject, grant);
        await Eventually(() => Granted(db), count => count == 1);

        // Тот же event_id под другим Nats-Msg-Id: сервер его не отсекает.
        await nats.Publish(RoleGrantedSubject, grant, messageId: Guid.NewGuid().ToString());
        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.IdentitySource, "duplicate")), count => count == 1);

        (await Granted(db)).ShouldBe(1);
    }

    /// <summary>
    /// Выдача, вернувшаяся после Nak, когда человека уже заблокировали, о роли
    /// не сообщает: последнее слово реплики её не держит.
    /// </summary>
    [Fact]
    public async Task When_GrantArrivesAfterBlock_Expect_NoFact()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var replica = silo.Service<ReplicaTelemetry>();

        var person = EventFactory.NewId();
        await nats.Publish(ProfileBlockedSubject, EventFactory.Identity(person, version: 5, blocked: true));
        await nats.Publish(RoleGrantedSubject, EventFactory.RoleGrant(person, version: 3, GlobalRole.Admin));

        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.IdentitySource, "stale")), count => count == 1);
        (await Granted(db)).ShouldBe(0);
    }

    private static async Task<long> Granted(IsolatedDatabase db)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        return await connection.ExecuteScalarAsync<long>("SELECT count(*) FROM notification WHERE type = 'role_granted';");
    }
}
