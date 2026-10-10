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
/// Сообщение человеку о назначении администратором (PER-468): событие Identity
/// <c>preset_granted</c> с набором <c>admin</c> в стриме даёт один адресный
/// факт самому человеку; смена круга и набор <c>maintainer</c> фактом не
/// являются.
/// </summary>
public class PresetGrantedFactTests
{
    private const string PresetGrantedSubject = "events.identity.preset_granted";
    private const string CircleChangedSubject = "events.identity.circle_changed";
    private const string ProfileBlockedSubject = "events.identity.profile_blocked";

    [Fact]
    public async Task When_AdminGranted_Expect_OneFactToPersonWithPreset()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await Person(db, AdminHolding);
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);

        var person = EventFactory.NewId();
        var grant = EventFactory.PresetGrant(person, version: 3, Preset.Admin);
        await nats.Publish(PresetGrantedSubject, grant);

        var facts = await Eventually(nats.PublishedFacts, facts => facts.Count == 1);

        var (fact, messageId) = facts.Single();
        messageId.ShouldBe(fact.NotificationId);
        fact.RecipientId.ShouldBe(person);
        fact.Cause.IdentityEventId.ShouldBe(grant.EventId);
        fact.TypeCase.ShouldBe(Notification.TypeOneofCase.PresetGranted);
        fact.PresetGranted.Preset.ShouldBe(Preset.Admin);
        fact.HasNotAfter.ShouldBeTrue();
        fact.HasRequestId.ShouldBeFalse();
        facts.Single().Subject.ShouldBe("events.notifications.notification_created.hub");
    }

    /// <summary>
    /// Общий секрет делает гостя участником и выдаёт ему набор одной
    /// операцией: заявку закрывает смена круга, а о наборе человек узнаёт в
    /// боте хаба.
    /// </summary>
    [Fact]
    public async Task When_GuestBecomesMemberThenAdmin_Expect_ApplicationClosedAndPresetFactInHub()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await Person(db, AdminHolding);
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, "--Notifications:Dispatch:Period=01:00:00");
        var replica = silo.Service<ReplicaTelemetry>();
        var applicant = EventFactory.NewId();

        await nats.Publish("events.identity.application_submitted",
            EventFactory.Application(applicant, 2, Circle.Member, held: Circle.Guest, granted: AccessRight.PlaceBids));
        await Eventually(() => CountRows(db, "notification"), count => count == 1);

        await nats.Publish(CircleChangedSubject, EventFactory.CircleChange(applicant, 3, Circle.Member, previous: Circle.Guest));
        await nats.Publish(PresetGrantedSubject, EventFactory.PresetGrant(applicant, 4, Preset.Admin));
        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.IdentitySource, "applied")), count => count == 3);

        (await AccessRequestWasWithdrawn(db, Guid.Parse(applicant))).ShouldBeTrue();
        (await Granted(db)).ShouldBe(1);
        (await Surface(db, Guid.Parse(applicant), "preset_granted")).ShouldBe("hub");
    }

    /// <summary>
    /// Мейнтейнер назначает администратором себя: снимок несёт оба набора, и о
    /// назначении он узнаёт, как любой другой.
    /// </summary>
    [Fact]
    public async Task When_MaintainerAppointsThemself_Expect_OneFact()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);

        var person = EventFactory.NewId();
        var grant = EventFactory.PresetGrant(person, version: 3, Preset.Admin);
        grant.State.Presets.Add(Preset.Maintainer);
        grant.State.Rights.Add(AccessRight.GrantAdmins);
        await nats.Publish(PresetGrantedSubject, grant);

        var facts = await Eventually(nats.PublishedFacts, facts => facts.Count == 1);

        facts.Single().Fact.RecipientId.ShouldBe(person);
        facts.Single().Fact.PresetGranted.Preset.ShouldBe(Preset.Admin);
    }

    /// <summary>
    /// Смену круга дают и белый список, и допуск, и о ней пишет не этот факт;
    /// набор <c>maintainer</c> выдаёт только общий секрет.
    /// </summary>
    [Theory]
    [InlineData("member")]
    [InlineData("guest")]
    [InlineData("maintainer")]
    public async Task When_NotAnAdminGrant_Expect_NoFact(string grant)
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var replica = silo.Service<ReplicaTelemetry>();

        var person = EventFactory.NewId();
        var (subject, message) = grant switch
        {
            "member" => (CircleChangedSubject, EventFactory.CircleChange(person, version: 3, Circle.Member)),
            "guest" => (CircleChangedSubject, EventFactory.CircleChange(person, version: 3, Circle.Guest)),
            _ => (PresetGrantedSubject, EventFactory.PresetGrant(person, version: 3, Preset.Maintainer)),
        };
        await nats.Publish(subject, message);

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

        var grant = EventFactory.PresetGrant(EventFactory.NewId(), version: 3, Preset.Admin);
        await nats.Publish(PresetGrantedSubject, grant);
        await Eventually(() => Granted(db), count => count == 1);

        // Тот же event_id под другим Nats-Msg-Id: сервер его не отсекает.
        await nats.Publish(PresetGrantedSubject, grant, messageId: Guid.NewGuid().ToString());
        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.IdentitySource, "duplicate")), count => count == 1);

        (await Granted(db)).ShouldBe(1);
    }

    /// <summary>
    /// Выдача, вернувшаяся после Nak, когда человека уже заблокировали, о
    /// наборе не сообщает: последнее слово реплики его не держит.
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
        await nats.Publish(PresetGrantedSubject, EventFactory.PresetGrant(person, version: 3, Preset.Admin));

        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.IdentitySource, "stale")), count => count == 1);
        (await Granted(db)).ShouldBe(0);
    }

    private static async Task<long> Granted(IsolatedDatabase db)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        return await connection.ExecuteScalarAsync<long>("SELECT count(*) FROM notification WHERE type = 'preset_granted';");
    }

    private static async Task<string?> Surface(IsolatedDatabase db, Guid recipient, string type)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        return await connection.ExecuteScalarAsync<string?>(
            "SELECT delivery_surface FROM notification WHERE recipient_id = @Recipient AND type = @Type;",
            new { Recipient = recipient, Type = type });
    }
}
