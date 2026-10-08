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
/// Оповещение о новой заявке (PER-435, PER-529): событие Identity
/// <c>application_submitted</c> в стриме, разворот на держателей права
/// модерации очереди заявки по реплике, снятие неотправленного при закрытой
/// заявке и видимость категории только модераторам очередей.
/// </summary>
/// <remarks>
/// Модераторы и их настройки кладутся в базу напрямую, как в
/// <see cref="MeetupPublishedFactTests" />: предмет здесь — решение «кому
/// положено», а не путь события в реплику. Заявитель приходит в реплику самим
/// событием заявки.
/// </remarks>
public class AccessRequestFactTests
{
    private const string ApplicationSubmittedSubject = "events.identity.application_submitted";
    private const string RoleGrantedSubject = "events.identity.role_granted";
    private const string ProfileBlockedSubject = "events.identity.profile_blocked";
    private const string RightGrantedSubject = "events.identity.right_granted";
    private const string RightRevokedSubject = "events.identity.right_revoked";

    private const string HeldRelay = "--Notifications:Dispatch:Period=01:00:00";

    [Fact]
    public async Task When_CommunityApplicationSubmitted_Expect_OneFactPerMembershipManagerWithCategoryOn()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();

        var byDefault = await Person(db, AdminCircle);
        var explicitlyOn = await Person(db, AdminCircle);
        var switchedOff = await Person(db, AdminCircle);
        var blockedAdmin = await Person(db, blocked: true, AdminCircle);
        var maintainer = await Person(db, MaintainerCircle);
        var member = await Person(db, MemberCircle);
        var auctionModerator = await Person(db, MemberCircle.With("moderate_auction"));
        await Preference(db, explicitlyOn, null, "access_request", enabled: true);
        await Preference(db, switchedOff, null, "access_request", enabled: false);

        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var telemetry = silo.Service<FactTelemetry>();

        var applicant = EventFactory.NewId();
        var application = EventFactory.Application(applicant, version: 2, GlobalRole.Member);
        await nats.Publish(ApplicationSubmittedSubject, application);

        var facts = await Eventually(nats.PublishedFacts, facts => facts.Count == 2);

        // Модератор аукциона заявку в сообщество не решает и её не получает.
        facts.Select(fact => Guid.Parse(fact.Fact.RecipientId)).ShouldBe([byDefault, explicitlyOn], ignoreOrder: true);
        var recipients = facts.Select(fact => fact.Fact.RecipientId).ToList();
        recipients.ShouldNotContain(switchedOff.ToString());
        recipients.ShouldNotContain(blockedAdmin.ToString());
        recipients.ShouldNotContain(maintainer.ToString());
        recipients.ShouldNotContain(member.ToString());
        recipients.ShouldNotContain(auctionModerator.ToString());
        recipients.ShouldNotContain(applicant);

        foreach (var (fact, messageId) in facts)
        {
            messageId.ShouldBe(fact.NotificationId);
            fact.Cause.IdentityEventId.ShouldBe(application.EventId);
            fact.TypeCase.ShouldBe(Notification.TypeOneofCase.AccessRequested);
            fact.AccessRequested.Circle.ShouldBe(GlobalRole.Member);
            fact.HasNotAfter.ShouldBeTrue();
            fact.HasRequestId.ShouldBeFalse();
        }

        telemetry.Total("created").ShouldBe(2);
        telemetry.Total("suppressed").ShouldBe(1);
    }

    /// <summary>
    /// Заявка в аукцион уходит держателям права модерации аукциона: участнику,
    /// которому его выдали, и администратору, у которого оно по кругу.
    /// Участник без права, мейнтейнер без него и управляющий составом без него
    /// её не получают (ADR-064, пункт 14).
    /// </summary>
    [Fact]
    public async Task When_AuctionApplicationSubmitted_Expect_FactsForAuctionModeratorsOnly()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();

        var admin = await Person(db, AdminCircle);
        var auctionModerator = await Person(db, MemberCircle.With("moderate_auction"));
        var member = await Person(db, MemberCircle);
        var maintainer = await Person(db, MaintainerCircle);
        var membershipManager = await Person(db, MaintainerCircle.With("manage_membership"));
        var guest = await Person(db, GuestCircle);

        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);

        var application = EventFactory.Application(EventFactory.NewId(), version: 2, GlobalRole.Guest);
        await nats.Publish(ApplicationSubmittedSubject, application);

        var facts = await Eventually(nats.PublishedFacts, facts => facts.Count == 2);

        facts.Select(fact => Guid.Parse(fact.Fact.RecipientId)).ShouldBe([admin, auctionModerator], ignoreOrder: true);
        var recipients = facts.Select(fact => fact.Fact.RecipientId).ToList();
        recipients.ShouldNotContain(member.ToString());
        recipients.ShouldNotContain(maintainer.ToString());
        recipients.ShouldNotContain(membershipManager.ToString());
        recipients.ShouldNotContain(guest.ToString());
        facts.ShouldAllBe(fact => fact.Fact.AccessRequested.Circle == GlobalRole.Guest);
    }

    /// <summary>
    /// Право модерации, выданное и отозванное событиями Identity, решает
    /// адресатов следующей заявки: реплика пишет права из снимка события.
    /// </summary>
    [Fact]
    public async Task When_ModerationRightRevoked_Expect_NextApplicationSkipsFormerModerator()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, HeldRelay);
        var replica = silo.Service<ReplicaTelemetry>();

        var moderator = EventFactory.NewId();
        await Apply(nats, replica, RoleGrantedSubject, EventFactory.RoleGrant(moderator, version: 1, GlobalRole.Member));
        await Apply(nats, replica, RightGrantedSubject, EventFactory.RightGrant(moderator, version: 2, GlobalRole.Member, AccessRight.ModerateAuction));

        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(EventFactory.NewId(), version: 2, GlobalRole.Guest));
        (await Recipients(db)).ShouldBe([Guid.Parse(moderator)]);

        await Apply(nats, replica, RightRevokedSubject, EventFactory.RightRevoke(moderator, version: 3, GlobalRole.Member, AccessRight.ModerateAuction));
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(EventFactory.NewId(), version: 2, GlobalRole.Guest));

        // Второй заявке адресатов нет: факт остался один, у первой.
        (await Facts(db)).ShouldBe(1);
    }

    /// <summary>
    /// Модератор, который сам подаёт заявку в очередь, которую модерирует, о
    /// ней не узнаёт: о собственном действии человеку не сообщают.
    /// </summary>
    [Fact]
    public async Task When_ModeratorAppliesToOwnQueue_Expect_NotAddressed()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        var other = await Person(db, AdminCircle);
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, HeldRelay);
        var replica = silo.Service<ReplicaTelemetry>();

        // Гость без права аукциона, но с правом его модерации: заявку ставить
        // ему есть на что, а адресатом своей заявки он быть не должен.
        var applicant = EventFactory.NewId();
        await Apply(nats, replica, RightGrantedSubject, EventFactory.RightGrant(applicant, version: 1, GlobalRole.Guest, AccessRight.ModerateAuction));
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 2, GlobalRole.Guest));

        (await Recipients(db)).ShouldBe([other]);
    }

    [Fact]
    public async Task When_ApplicationRedelivered_Expect_FactsNotDoubled()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await Person(db, AdminCircle);
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
        await Person(db, AdminCircle);
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
        await Person(db, AdminCircle);
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
        await Person(db, AdminCircle);
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, HeldRelay);
        var replica = silo.Service<ReplicaTelemetry>();

        var applicant = EventFactory.NewId();
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 2, GlobalRole.Guest));
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 3, GlobalRole.Member));
        (await Pending(db)).ShouldBe(2);

        await Apply(nats, replica, ProfileBlockedSubject, EventFactory.Identity(applicant, version: 4, blocked: true));

        (await Rows(db)).ShouldAllBe(row => row.WithdrawalReason == NotificationFacts.WithdrawnOnApplicationClosed);
    }

    /// <summary>
    /// Выдача круга гостя закрывает только заявку в аукцион: заявка в хаб ждёт
    /// дальше, и оповещение о ней остаётся (ADR-060, пункт 8).
    /// </summary>
    [Fact]
    public async Task When_AuctionGrantedWhileHubFactPending_Expect_HubFactKept()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await Person(db, AdminCircle);
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, HeldRelay);
        var replica = silo.Service<ReplicaTelemetry>();

        var applicant = EventFactory.NewId();
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 2, GlobalRole.Guest));
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 3, GlobalRole.Member));

        await Apply(nats, replica, RoleGrantedSubject, EventFactory.RoleGrant(applicant, version: 4, GlobalRole.Guest));

        var rows = await Rows(db);
        rows.Single(row => row.AccessCircle == "public").WithdrawalReason.ShouldBe(NotificationFacts.WithdrawnOnApplicationClosed);
        rows.Single(row => row.AccessCircle == "member").WithdrawnAt.ShouldBeNull();
    }

    /// <summary>
    /// Выдача права аукциона закрывает заявку в аукцион так же, как выдача
    /// круга (ADR-062, пункт 7 в редакции ADR-064): участник с заявкой в
    /// сообщество получает право отдельно, и оповещение о ней остаётся.
    /// </summary>
    [Fact]
    public async Task When_AuctionRightGrantedWhileFactsPending_Expect_OnlyAuctionFactWithdrawn()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await Person(db, AdminCircle);
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, HeldRelay);
        var replica = silo.Service<ReplicaTelemetry>();

        var applicant = EventFactory.NewId();
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 2, GlobalRole.Guest));
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 3, GlobalRole.Member));

        await Apply(nats, replica, RightGrantedSubject, EventFactory.RightGrant(applicant, version: 4, GlobalRole.Guest, AccessRight.Auction));

        var rows = await Rows(db);
        rows.Single(row => row.AccessCircle == "public").WithdrawalReason.ShouldBe(NotificationFacts.WithdrawnOnApplicationClosed);
        rows.Single(row => row.AccessCircle == "member").WithdrawnAt.ShouldBeNull();
    }

    /// <summary>
    /// Выдача права модерации заявку не закрывает: оно не допускает в очередь.
    /// </summary>
    [Fact]
    public async Task When_ModerationRightGrantedWhileFactPending_Expect_FactKept()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await Person(db, AdminCircle);
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, HeldRelay);
        var replica = silo.Service<ReplicaTelemetry>();

        var applicant = EventFactory.NewId();
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 2, GlobalRole.Guest));
        await Apply(nats, replica, RightGrantedSubject, EventFactory.RightGrant(applicant, version: 3, GlobalRole.Guest, AccessRight.ModerateAuction));

        (await Rows(db)).Single().WithdrawnAt.ShouldBeNull();
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
        await Person(db, AdminCircle);
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, HeldRelay);
        var replica = silo.Service<ReplicaTelemetry>();

        var applicant = EventFactory.NewId();
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 3, GlobalRole.Member));
        await nats.Publish(RoleGrantedSubject, EventFactory.Identity(applicant, version: 2));
        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.IdentitySource, "stale")), count => count == 1);

        (await Rows(db)).Single().WithdrawnAt.ShouldBeNull();
    }

    /// <summary>
    /// Кто получает факт, тот видит переключатель: администратор и участник с
    /// правом модерации аукциона (ADR-064).
    /// </summary>
    [Theory]
    [InlineData("admin")]
    [InlineData("auction moderator")]
    public async Task When_QueueModeratorReadsGlobalPreferences_Expect_AccessRequestsOnByDefault(string who)
    {
        await using var service = await PreferencesUnderTest.Start();
        var moderator = await Person(service.Database, who == "admin" ? AdminCircle : MemberCircle.With("moderate_auction"));

        var snapshot = await service.Client.GetGlobalNotificationPreferencesAsync(
            new GetGlobalNotificationPreferencesRequest { IdentityId = moderator.ToString("D") });

        snapshot.Categories.Single(preference => preference.Category == NotificationCategory.AccessRequest)
            .Enabled.ShouldBeTrue();
    }

    [Fact]
    public async Task When_AuctionModeratorSwitchesAccessRequestsOff_Expect_SnapshotCarriesItOff()
    {
        await using var service = await PreferencesUnderTest.Start();
        var moderator = await Person(service.Database, MemberCircle.With("moderate_auction"));

        var snapshot = await service.Client.SetGlobalCategoryPreferenceAsync(new SetGlobalCategoryPreferenceRequest
        {
            IdentityId = moderator.ToString("D"),
            Category = NotificationCategory.AccessRequest,
            Enabled = false,
        });

        snapshot.Categories.Single(preference => preference.Category == NotificationCategory.AccessRequest)
            .Enabled.ShouldBeFalse();
    }

    /// <summary>
    /// Человек без права модерации категории не видит и поставить её не может:
    /// ни участник хаба, ни мейнтейнер, ни гость, ни человек, которого реплика
    /// не знает.
    /// </summary>
    /// <param name="role">Круг человека; пусто — реплика человека не знает.</param>
    [Theory]
    [InlineData("member")]
    [InlineData("maintainer")]
    [InlineData("guest")]
    [InlineData("")]
    public async Task When_NonModeratorTouchesAccessRequests_Expect_HiddenAndPermissionDenied(string role)
    {
        await using var service = await PreferencesUnderTest.Start();
        var person = role switch
        {
            "" => Guid.CreateVersion7(),
            "member" => await Person(service.Database, MemberCircle),
            "maintainer" => await Person(service.Database, MaintainerCircle),
            _ => await Person(service.Database, GuestCircle),
        };

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
        var blocked = await Person(service.Database, blocked: true, AdminCircle);

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
        var admin = await Person(service.Database, AdminCircle);

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

    private static async Task<IReadOnlyList<Guid>> Recipients(IsolatedDatabase db)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        return (await connection.QueryAsync<Guid>("SELECT recipient_id FROM notification ORDER BY recipient_id;")).ToList();
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
