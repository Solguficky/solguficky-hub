using Dapper;
using Grpc.Core;
using Identity.V1;
using Notifications.Facts;
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
/// Оповещение администраторов о новой заявке (PER-435): событие Identity
/// <c>application_submitted</c> в стриме, разворот на администраторов по
/// реплике, снятие неотправленного при закрытой заявке и видимость категории
/// только администратору.
/// </summary>
/// <remarks>
/// Администраторы и их настройки кладутся в базу напрямую, как в
/// <see cref="MeetupPublishedFactTests" />: предмет здесь — решение «кому
/// положено», а не путь события в реплику. Заявитель приходит в реплику самим
/// событием заявки.
/// </remarks>
public class AccessRequestFactTests
{
    private const string ApplicationSubmittedSubject = "events.identity.application_submitted";
    private const string RoleGrantedSubject = "events.identity.role_granted";
    private const string ProfileBlockedSubject = "events.identity.profile_blocked";

    private const string HeldRelay = "--Notifications:Dispatch:Period=01:00:00";

    [Fact]
    public async Task When_ApplicationSubmitted_Expect_OneFactPerAdminWithCategoryOn()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();

        var byDefault = await Person(db, "admin", "member", "public");
        var explicitlyOn = await Person(db, "admin", "member", "public");
        var switchedOff = await Person(db, "admin", "member", "public");
        var blockedAdmin = await Person(db, blocked: true, "admin");
        var maintainer = await Person(db, "maintainer", "member", "public");
        var member = await Person(db, "member", "public");
        await Preference(db, explicitlyOn, null, "access_request", enabled: true);
        await Preference(db, switchedOff, null, "access_request", enabled: false);

        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var telemetry = silo.Service<FactTelemetry>();

        var applicant = EventFactory.NewId();
        var application = EventFactory.Application(applicant, version: 2, GlobalRole.Public);
        await nats.Publish(ApplicationSubmittedSubject, application);

        var facts = await Eventually(nats.PublishedFacts, facts => facts.Count == 2);

        facts.Select(fact => Guid.Parse(fact.Fact.RecipientId)).ShouldBe([byDefault, explicitlyOn], ignoreOrder: true);
        var recipients = facts.Select(fact => fact.Fact.RecipientId).ToList();
        recipients.ShouldNotContain(switchedOff.ToString());
        recipients.ShouldNotContain(blockedAdmin.ToString());
        recipients.ShouldNotContain(maintainer.ToString());
        recipients.ShouldNotContain(member.ToString());
        recipients.ShouldNotContain(applicant);

        foreach (var (fact, messageId) in facts)
        {
            messageId.ShouldBe(fact.NotificationId);
            fact.Cause.IdentityEventId.ShouldBe(application.EventId);
            fact.TypeCase.ShouldBe(Notification.TypeOneofCase.AccessRequested);
            fact.AccessRequested.Circle.ShouldBe(GlobalRole.Public);
            fact.HasNotAfter.ShouldBeTrue();
            fact.HasRequestId.ShouldBeFalse();
        }

        telemetry.Total("created").ShouldBe(2);
        telemetry.Total("suppressed").ShouldBe(1);
    }

    [Fact]
    public async Task When_ApplicationRedelivered_Expect_FactsNotDoubled()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await Person(db, "admin", "member", "public");
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var replica = silo.Service<ReplicaTelemetry>();

        var application = EventFactory.Application(EventFactory.NewId(), version: 2, GlobalRole.Member);
        await nats.Publish(ApplicationSubmittedSubject, application);
        await Eventually(() => Facts(db), count => count == 1);

        // Тот же event_id под другим Nats-Msg-Id: сервер его не отсекает.
        await nats.Publish(ApplicationSubmittedSubject, application, messageId: Guid.NewGuid().ToString());
        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.IdentitySource, "duplicate")), count => count == 1);

        (await Facts(db)).ShouldBe(1);
    }

    /// <summary>
    /// Заявка, вернувшаяся после Nak, когда допуск уже применён, реплику не
    /// двигает и никого не зовёт: решать уже нечего.
    /// </summary>
    [Fact]
    public async Task When_ApplicationArrivesAfterAdmission_Expect_NoFact()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await Person(db, "admin", "member", "public");
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var replica = silo.Service<ReplicaTelemetry>();

        var applicant = EventFactory.NewId();
        await nats.Publish(RoleGrantedSubject, EventFactory.Identity(applicant, version: 3));
        await nats.Publish(ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 2, GlobalRole.Member));

        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.IdentitySource, "stale")), count => count == 1);
        (await Facts(db)).ShouldBe(0);
    }

    /// <summary>
    /// Допуск, пришедший, пока факт ждал релея, его снимает: администратор
    /// пошёл бы решать то, что уже решено. Отправленное не трогается.
    /// </summary>
    [Fact]
    public async Task When_AdmittedWhileFactPending_Expect_FactWithdrawn()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await Person(db, "admin", "member", "public");
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, HeldRelay);
        var replica = silo.Service<ReplicaTelemetry>();
        var telemetry = silo.Service<FactTelemetry>();

        var applicant = EventFactory.NewId();
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 2, GlobalRole.Member));
        (await Pending(db)).ShouldBe(1);

        await Apply(nats, replica, RoleGrantedSubject, EventFactory.Identity(applicant, version: 3));

        var row = (await Rows(db)).Single();
        row.WithdrawalReason.ShouldBe(NotificationFacts.WithdrawnOnApplicationClosed);
        row.DispatchedAt.ShouldBeNull();
        telemetry.Total("withdrawn").ShouldBe(1);
    }

    /// <summary>
    /// Блокировка закрывает все заявки человека — и в хаб, и в аукцион.
    /// </summary>
    [Fact]
    public async Task When_BlockedWhileFactsPending_Expect_EveryFactWithdrawn()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await Person(db, "admin", "member", "public");
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, HeldRelay);
        var replica = silo.Service<ReplicaTelemetry>();

        var applicant = EventFactory.NewId();
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 2, GlobalRole.Public));
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 3, GlobalRole.Member));
        (await Pending(db)).ShouldBe(2);

        await Apply(nats, replica, ProfileBlockedSubject, EventFactory.Identity(applicant, version: 4, blocked: true));

        (await Rows(db)).ShouldAllBe(row => row.WithdrawalReason == NotificationFacts.WithdrawnOnApplicationClosed);
    }

    /// <summary>
    /// Выдача public закрывает только заявку в аукцион: заявка в хаб ждёт
    /// дальше, и оповещение о ней остаётся (ADR-060, пункт 8).
    /// </summary>
    [Fact]
    public async Task When_AuctionGrantedWhileHubFactPending_Expect_HubFactKept()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await Person(db, "admin", "member", "public");
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, HeldRelay);
        var replica = silo.Service<ReplicaTelemetry>();

        var applicant = EventFactory.NewId();
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 2, GlobalRole.Public));
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 3, GlobalRole.Member));

        var granted = EventFactory.Identity(applicant, version: 4);
        granted.State.GlobalRoles.Clear();
        granted.State.GlobalRoles.Add(GlobalRole.Public);
        granted.RoleGranted = new RoleGranted { Role = GlobalRole.Public };
        await Apply(nats, replica, RoleGrantedSubject, granted);

        var rows = await Rows(db);
        rows.Single(row => row.AccessCircle == "public").WithdrawalReason.ShouldBe(NotificationFacts.WithdrawnOnApplicationClosed);
        rows.Single(row => row.AccessCircle == "member").WithdrawnAt.ShouldBeNull();
    }

    /// <summary>
    /// Выдача, которая старше заявки, её не закрывает: запоздавшее событие
    /// снимает только факты о заявках, поданных до него.
    /// </summary>
    [Fact]
    public async Task When_OlderGrantArrivesAfterApplication_Expect_FactKept()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await Person(db, "admin", "member", "public");
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, HeldRelay);
        var replica = silo.Service<ReplicaTelemetry>();

        var applicant = EventFactory.NewId();
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 3, GlobalRole.Member));
        await nats.Publish(RoleGrantedSubject, EventFactory.Identity(applicant, version: 2));
        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.IdentitySource, "stale")), count => count == 1);

        (await Rows(db)).Single().WithdrawnAt.ShouldBeNull();
    }

    [Fact]
    public async Task When_AdminReadsGlobalPreferences_Expect_AccessRequestsOnByDefault()
    {
        await using var service = await PreferencesUnderTest.Start();
        var admin = await Person(service.Database, "admin", "member", "public");

        var snapshot = await service.Client.GetGlobalNotificationPreferencesAsync(
            new GetGlobalNotificationPreferencesRequest { IdentityId = admin.ToString("D") });

        snapshot.Categories.Single(preference => preference.Category == NotificationCategory.AccessRequest)
            .Enabled.ShouldBeTrue();
    }

    [Fact]
    public async Task When_AdminSwitchesAccessRequestsOff_Expect_SnapshotCarriesItOff()
    {
        await using var service = await PreferencesUnderTest.Start();
        var admin = await Person(service.Database, "admin", "member", "public");

        var snapshot = await service.Client.SetGlobalCategoryPreferenceAsync(new SetGlobalCategoryPreferenceRequest
        {
            IdentityId = admin.ToString("D"),
            Category = NotificationCategory.AccessRequest,
            Enabled = false,
        });

        snapshot.Categories.Single(preference => preference.Category == NotificationCategory.AccessRequest)
            .Enabled.ShouldBeFalse();
    }

    /// <summary>
    /// Не-администратор категории не видит и поставить её не может: ни
    /// участник хаба, ни мейнтейнер, ни человек, которого реплика не знает.
    /// </summary>
    /// <param name="roles">Роли через запятую; пусто — реплика человека не знает.</param>
    [Theory]
    [InlineData("member,public")]
    [InlineData("maintainer,member,public")]
    [InlineData("")]
    public async Task When_NonAdminTouchesAccessRequests_Expect_HiddenAndPermissionDenied(string roles)
    {
        await using var service = await PreferencesUnderTest.Start();
        var person = roles == "" ? Guid.CreateVersion7() : await Person(service.Database, roles.Split(','));

        var snapshot = await service.Client.GetGlobalNotificationPreferencesAsync(
            new GetGlobalNotificationPreferencesRequest { IdentityId = person.ToString("D") });
        snapshot.Categories.Select(preference => preference.Category).ShouldNotContain(NotificationCategory.AccessRequest);

        var refused = await Should.ThrowAsync<RpcException>(() =>
            service.Client.SetGlobalCategoryPreferenceAsync(new SetGlobalCategoryPreferenceRequest
            {
                IdentityId = person.ToString("D"),
                Category = NotificationCategory.AccessRequest,
                Enabled = true,
            }).ResponseAsync);
        refused.StatusCode.ShouldBe(StatusCode.PermissionDenied);

        (await Scalar(service.Database, "SELECT count(*) FROM notification_preference;")).ShouldBe(0);
    }

    [Fact]
    public async Task When_BlockedAdminTouchesAccessRequests_Expect_PermissionDenied()
    {
        await using var service = await PreferencesUnderTest.Start();
        var blocked = await Person(service.Database, blocked: true, "admin");

        var refused = await Should.ThrowAsync<RpcException>(() =>
            service.Client.SetGlobalCategoryPreferenceAsync(new SetGlobalCategoryPreferenceRequest
            {
                IdentityId = blocked.ToString("D"),
                Category = NotificationCategory.AccessRequest,
                Enabled = false,
            }).ResponseAsync);
        refused.StatusCode.ShouldBe(StatusCode.PermissionDenied);
    }

    [Fact]
    public async Task When_AccessRequestsSetPerMeetup_Expect_InvalidArgument()
    {
        await using var service = await PreferencesUnderTest.Start();
        var admin = await Person(service.Database, "admin", "member", "public");

        var refused = await Should.ThrowAsync<RpcException>(() =>
            service.Client.SetMeetupCategoryPreferenceAsync(new SetMeetupCategoryPreferenceRequest
            {
                IdentityId = admin.ToString("D"),
                MeetupId = Guid.CreateVersion7().ToString("D"),
                Category = NotificationCategory.AccessRequest,
                Enabled = false,
            }).ResponseAsync);
        refused.StatusCode.ShouldBe(StatusCode.InvalidArgument);
    }

    private static async Task Apply(NatsUnderTest nats, ReplicaTelemetry replica, string subject, IdentityEvent message)
    {
        var applied = replica.Total(ReplicaFeeds.IdentitySource, "applied");
        await nats.Publish(subject, message);
        await Eventually(
            () => Task.FromResult(replica.Total(ReplicaFeeds.IdentitySource, "applied")),
            count => count == applied + 1);
    }

    private static Task<long> Facts(IsolatedDatabase db) => Scalar(db, "SELECT count(*) FROM notification;");

    private static Task<long> Pending(IsolatedDatabase db) =>
        Scalar(db, "SELECT count(*) FROM notification WHERE dispatched_at IS NULL AND withdrawn_at IS NULL;");

    private static async Task<long> Scalar(IsolatedDatabase db, string sql)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        return await connection.ExecuteScalarAsync<long>(sql);
    }

    private static async Task<IReadOnlyList<NotificationRow>> Rows(IsolatedDatabase db)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        return (await connection.QueryAsync<NotificationRow>(
            """
            SELECT access_circle AS AccessCircle, dispatched_at AS DispatchedAt, withdrawn_at AS WithdrawnAt,
                   withdrawal_reason AS WithdrawalReason
            FROM notification
            ORDER BY created_at;
            """)).ToList();
    }

    private sealed class NotificationRow
    {
        public string? AccessCircle { get; init; }

        public DateTime? DispatchedAt { get; init; }

        public DateTime? WithdrawnAt { get; init; }

        public string? WithdrawalReason { get; init; }
    }
}
