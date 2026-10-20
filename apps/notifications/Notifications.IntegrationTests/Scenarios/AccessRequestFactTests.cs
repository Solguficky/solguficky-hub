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
    private const string CircleChangedSubject = "events.identity.circle_changed";
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

        var byDefault = await Person(db, AdminHolding);
        var explicitlyOn = await Person(db, AdminHolding);
        var switchedOff = await Person(db, AdminHolding);
        var otherQueueOff = await Person(db, AdminHolding);
        var blockedAdmin = await Person(db, blocked: true, AdminHolding);
        var maintainer = await Person(db, MaintainerHolding);
        var member = await Person(db, MemberHolding);
        var auctionModerator = await Person(db, MemberHolding.With("admit_bidders"));
        await Preference(db, explicitlyOn, null, "access_request_community", enabled: true);
        await Preference(db, switchedOff, null, "access_request_community", enabled: false);
        // Выключенная очередь аукциона заявку в сообщество не гасит (PER-635).
        await Preference(db, otherQueueOff, null, "access_request_auction", enabled: false);

        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var telemetry = silo.Service<FactTelemetry>();

        var applicant = EventFactory.NewId();
        var application = EventFactory.Application(applicant, version: 2, Circle.Member);
        await nats.Publish(ApplicationSubmittedSubject, application);

        var facts = await Eventually(nats.PublishedFacts, facts => facts.Count == 3);

        // Модератор аукциона заявку в сообщество не решает и её не получает.
        facts.Select(fact => Guid.Parse(fact.Fact.RecipientId))
            .ShouldBe([byDefault, explicitlyOn, otherQueueOff], ignoreOrder: true);
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
            fact.AccessRequested.Queue.ShouldBe(ApplicationQueue.Community);
            // Курсор заявки — тот, что прислал Identity: по нему бот читает карточку.
            fact.AccessRequested.ApplicationId.ShouldBe(application.ApplicationSubmitted.ApplicationId);
            fact.AccessRequested.CreatedAt.ShouldBe(application.ApplicationSubmitted.CreatedAt);
            fact.HasNotAfter.ShouldBeTrue();
            fact.HasRequestId.ShouldBeFalse();
        }

        telemetry.Total("created").ShouldBe(3);
        telemetry.Total("suppressed").ShouldBe(1);
    }

    /// <summary>
    /// Заявка в аукцион уходит держателям права допуска к торгам: участнику,
    /// которому его выдали записью, и администратору, у которого оно по
    /// набору. Участник без права и мейнтейнер без набора admin её не
    /// получают (ADR-064, пункт 14; RFC-016).
    /// </summary>
    [Fact]
    public async Task When_AuctionApplicationSubmitted_Expect_FactsForAuctionModeratorsOnly()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();

        var admin = await Person(db, AdminHolding);
        var auctionModerator = await Person(db, MemberHolding.With("admit_bidders"));
        var communityOff = await Person(db, AdminHolding);
        var auctionOff = await Person(db, AdminHolding);
        var member = await Person(db, MemberHolding);
        var maintainer = await Person(db, MaintainerHolding);
        var guest = await Person(db, GuestHolding);
        // Выключенная очередь сообщества заявку в аукцион не гасит, а своя —
        // гасит (PER-635).
        await Preference(db, communityOff, null, "access_request_community", enabled: false);
        await Preference(db, auctionOff, null, "access_request_auction", enabled: false);

        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);

        var application = EventFactory.Application(EventFactory.NewId(), version: 2, Circle.Guest);
        await nats.Publish(ApplicationSubmittedSubject, application);

        var facts = await Eventually(nats.PublishedFacts, facts => facts.Count == 3);

        facts.Select(fact => Guid.Parse(fact.Fact.RecipientId))
            .ShouldBe([admin, auctionModerator, communityOff], ignoreOrder: true);
        var recipients = facts.Select(fact => fact.Fact.RecipientId).ToList();
        recipients.ShouldNotContain(auctionOff.ToString());
        recipients.ShouldNotContain(member.ToString());
        recipients.ShouldNotContain(maintainer.ToString());
        recipients.ShouldNotContain(guest.ToString());
        facts.ShouldAllBe(fact => fact.Fact.AccessRequested.Queue == ApplicationQueue.Auction);
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
        await Apply(nats, replica, CircleChangedSubject, EventFactory.CircleChange(moderator, version: 1, Circle.Member));
        await Apply(nats, replica, RightGrantedSubject, EventFactory.RightGrant(moderator, version: 2, Circle.Member, AccessRight.AdmitBidders));

        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(EventFactory.NewId(), version: 2, Circle.Guest));
        (await Recipients(db)).ShouldBe([Guid.Parse(moderator)]);

        await Apply(nats, replica, RightRevokedSubject, EventFactory.RightRevoke(moderator, version: 3, Circle.Member, AccessRight.AdmitBidders));
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(EventFactory.NewId(), version: 2, Circle.Guest));

        // Второй заявке адресатов нет: факт остался один, у первой.
        (await Facts(db)).ShouldBe(1);
    }

    /// <summary>
    /// Модератор, который сам подаёт заявку в очередь, которую модерирует, о
    /// ней не узнаёт: о собственном действии человеку не сообщают. Снимок
    /// заявки несёт его право модерации, поэтому выпадает он по правилу
    /// исполнителя, а не по пустым правам.
    /// </summary>
    [Fact]
    public async Task When_ModeratorAppliesToOwnQueue_Expect_NotAddressed()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        var other = await Person(db, AdminHolding);
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, HeldRelay);
        var replica = silo.Service<ReplicaTelemetry>();

        // Гость без права аукциона, но с правом его модерации: заявку ставить
        // ему есть на что, а адресатом своей заявки он быть не должен.
        var applicant = EventFactory.NewId();
        await Apply(
            nats,
            replica,
            ApplicationSubmittedSubject,
            EventFactory.Application(applicant, version: 2, Circle.Guest, held: Circle.Guest, granted: AccessRight.AdmitBidders));

        (await Scalar(db, $"SELECT count(*) FROM identity_replica WHERE 'admit_bidders' = ANY(rights) AND identity_id = '{applicant}';")).ShouldBe(1);
        (await Recipients(db)).ShouldBe([other]);
    }

    /// <summary>
    /// Гость с правом аукциона, подавший заявку в сообщество, ещё ждёт: заявку
    /// закрывает право хаба, а не любое право.
    /// </summary>
    [Fact]
    public async Task When_AuctionGuestAppliesToCommunity_Expect_MembershipManagersCalled()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        var admin = await Person(db, AdminHolding);
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, HeldRelay);
        var replica = silo.Service<ReplicaTelemetry>();

        await Apply(
            nats,
            replica,
            ApplicationSubmittedSubject,
            EventFactory.Application(EventFactory.NewId(), version: 2, Circle.Member, held: Circle.Guest, granted: AccessRight.PlaceBids));

        (await Recipients(db)).ShouldBe([admin]);
    }

    [Fact]
    public async Task When_ApplicationRedelivered_Expect_FactsNotDoubled()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await Person(db, AdminHolding);
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var replica = silo.Service<ReplicaTelemetry>();

        var application = EventFactory.Application(EventFactory.NewId(), version: 2, Circle.Member);
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
        await Person(db, AdminHolding);
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var replica = silo.Service<ReplicaTelemetry>();

        var applicant = EventFactory.NewId();
        await nats.Publish(CircleChangedSubject, EventFactory.Identity(applicant, version: 3));
        await nats.Publish(ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 2, Circle.Member));

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
        await Person(db, AdminHolding);
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, HeldRelay);
        var replica = silo.Service<ReplicaTelemetry>();
        var telemetry = silo.Service<FactTelemetry>();

        var applicant = EventFactory.NewId();
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 2, Circle.Member));
        (await Pending(db)).ShouldBe(1);

        await Apply(nats, replica, CircleChangedSubject, EventFactory.Identity(applicant, version: 3));

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
        await Person(db, AdminHolding);
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, HeldRelay);
        var replica = silo.Service<ReplicaTelemetry>();

        var applicant = EventFactory.NewId();
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 2, Circle.Guest));
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 3, Circle.Member));
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
        await Person(db, AdminHolding);
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, HeldRelay);
        var replica = silo.Service<ReplicaTelemetry>();

        var applicant = EventFactory.NewId();
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 2, Circle.Guest));
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 3, Circle.Member));

        await Apply(nats, replica, CircleChangedSubject, EventFactory.CircleChange(applicant, version: 4, Circle.Guest));

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
        await Person(db, AdminHolding);
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, HeldRelay);
        var replica = silo.Service<ReplicaTelemetry>();

        var applicant = EventFactory.NewId();
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 2, Circle.Guest));
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 3, Circle.Member));

        await Apply(nats, replica, RightGrantedSubject, EventFactory.RightGrant(applicant, version: 4, Circle.Guest, AccessRight.PlaceBids));

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
        await Person(db, AdminHolding);
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, HeldRelay);
        var replica = silo.Service<ReplicaTelemetry>();

        var applicant = EventFactory.NewId();
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 2, Circle.Guest));
        await Apply(nats, replica, RightGrantedSubject, EventFactory.RightGrant(applicant, version: 3, Circle.Guest, AccessRight.AdmitBidders));

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
        await Person(db, AdminHolding);
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, HeldRelay);
        var replica = silo.Service<ReplicaTelemetry>();

        var applicant = EventFactory.NewId();
        await Apply(nats, replica, ApplicationSubmittedSubject, EventFactory.Application(applicant, version: 3, Circle.Member));
        await nats.Publish(CircleChangedSubject, EventFactory.Identity(applicant, version: 2));
        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.IdentitySource, "stale")), count => count == 1);

        (await Rows(db)).Single().WithdrawnAt.ShouldBeNull();
    }

    /// <summary>
    /// Кто получает факт, тот видит переключатель, и только своей очереди:
    /// администратору видны обе, модератору аукциона — его (ADR-064, PER-635).
    /// </summary>
    [Theory]
    [InlineData("admin", true, true)]
    [InlineData("auction moderator", false, true)]
    public async Task When_QueueModeratorReadsGlobalPreferences_Expect_OwnQueuesOnly(
        string who,
        bool communityVisible,
        bool auctionVisible)
    {
        await using var service = await PreferencesUnderTest.Start();
        var moderator = await Person(service.Database, who == "admin" ? AdminHolding : MemberHolding.With("admit_bidders"));

        var snapshot = await service.Client.GetGlobalNotificationPreferencesAsync(
            new GetGlobalNotificationPreferencesRequest { IdentityId = moderator.ToString("D") });

        var seen = snapshot.Categories.Select(preference => preference.Category).ToList();
        seen.Contains(NotificationCategory.AccessRequestCommunity).ShouldBe(communityVisible);
        seen.Contains(NotificationCategory.AccessRequestAuction).ShouldBe(auctionVisible);
        snapshot.Categories.Where(preference => preference.Category is
                NotificationCategory.AccessRequestCommunity or NotificationCategory.AccessRequestAuction)
            .ShouldAllBe(preference => preference.Enabled);
    }

    /// <summary>
    /// Модератор только очереди аукциона ставит свою категорию сам: это и есть
    /// кнопка под оповещением, и отказ по чужому праву её не останавливает.
    /// </summary>
    [Fact]
    public async Task When_AuctionOnlyModeratorSwitchesItsQueueOff_Expect_ItOffAndCommunityHidden()
    {
        await using var service = await PreferencesUnderTest.Start();
        var moderator = await Person(service.Database, MemberHolding.With("admit_bidders"));

        var snapshot = await service.Client.SetGlobalCategoryPreferenceAsync(new SetGlobalCategoryPreferenceRequest
        {
            IdentityId = moderator.ToString("D"),
            Category = NotificationCategory.AccessRequestAuction,
            Enabled = false,
        });

        snapshot.Categories.Single(preference => preference.Category == NotificationCategory.AccessRequestAuction)
            .Enabled.ShouldBeFalse();
        snapshot.Categories.Select(preference => preference.Category)
            .ShouldNotContain(NotificationCategory.AccessRequestCommunity);
    }

    /// <summary>
    /// Администратор держит оба права, и выключение одной очереди вторую не
    /// гасит (PER-635).
    /// </summary>
    [Fact]
    public async Task When_BothQueuesModeratorSwitchesOneOff_Expect_OtherStaysOn()
    {
        await using var service = await PreferencesUnderTest.Start();
        var moderator = await Person(service.Database, AdminHolding);

        var snapshot = await service.Client.SetGlobalCategoryPreferenceAsync(new SetGlobalCategoryPreferenceRequest
        {
            IdentityId = moderator.ToString("D"),
            Category = NotificationCategory.AccessRequestAuction,
            Enabled = false,
        });

        snapshot.Categories.Single(preference => preference.Category == NotificationCategory.AccessRequestAuction)
            .Enabled.ShouldBeFalse();
        snapshot.Categories.Single(preference => preference.Category == NotificationCategory.AccessRequestCommunity)
            .Enabled.ShouldBeTrue();
    }

    /// <summary>
    /// Держатель права одной очереди вторую не видит и не ставит: чужой
    /// переключатель он бы выключил вслепую (PER-635).
    /// </summary>
    [Fact]
    public async Task When_CommunityModeratorTouchesAuctionQueue_Expect_PermissionDenied()
    {
        await using var service = await PreferencesUnderTest.Start();
        var moderator = await Person(service.Database, MemberHolding.With("manage_members"));

        var snapshot = await service.Client.GetGlobalNotificationPreferencesAsync(
            new GetGlobalNotificationPreferencesRequest { IdentityId = moderator.ToString("D") });
        // Своя строка в снимке есть, чужая — нет: пустой снимок прошёл бы
        // проверку отсутствия и ничего не доказывал.
        snapshot.Categories.Select(preference => preference.Category)
            .ShouldContain(NotificationCategory.AccessRequestCommunity);
        snapshot.Categories.Select(preference => preference.Category)
            .ShouldNotContain(NotificationCategory.AccessRequestAuction);

        var refused = await Should.ThrowAsync<RpcException>(() =>
            service.Client.SetGlobalCategoryPreferenceAsync(new SetGlobalCategoryPreferenceRequest
            {
                IdentityId = moderator.ToString("D"),
                Category = NotificationCategory.AccessRequestAuction,
                Enabled = false,
            }).ResponseAsync);
        refused.StatusCode.ShouldBe(StatusCode.PermissionDenied);
    }

    /// <summary>
    /// Человек без права модерации категорий не видит и поставить их не может:
    /// ни участник хаба, ни мейнтейнер, ни гость, ни человек, которого реплика
    /// не знает.
    /// </summary>
    /// <param name="role">Кто это: круг или набор человека; пусто — реплика человека не знает.</param>
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
            "member" => await Person(service.Database, MemberHolding),
            "maintainer" => await Person(service.Database, MaintainerHolding),
            _ => await Person(service.Database, GuestHolding),
        };

        var snapshot = await service.Client.GetGlobalNotificationPreferencesAsync(
            new GetGlobalNotificationPreferencesRequest { IdentityId = person.ToString("D") });
        snapshot.Categories.Select(preference => preference.Category)
            .ShouldNotContain(NotificationCategory.AccessRequestCommunity);
        snapshot.Categories.Select(preference => preference.Category)
            .ShouldNotContain(NotificationCategory.AccessRequestAuction);

        foreach (var category in new[]
                 {
                     NotificationCategory.AccessRequestCommunity,
                     NotificationCategory.AccessRequestAuction,
                 })
        {
            var refused = await Should.ThrowAsync<RpcException>(() =>
                service.Client.SetGlobalCategoryPreferenceAsync(new SetGlobalCategoryPreferenceRequest
                {
                    IdentityId = person.ToString("D"),
                    Category = category,
                    Enabled = true,
                }).ResponseAsync);
            refused.StatusCode.ShouldBe(StatusCode.PermissionDenied);
        }

        (await Scalar(service.Database, "SELECT count(*) FROM notification_preference;")).ShouldBe(0);
    }

    [Fact]
    public async Task When_BlockedAdminTouchesAccessRequests_Expect_PermissionDenied()
    {
        await using var service = await PreferencesUnderTest.Start();
        var blocked = await Person(service.Database, blocked: true, AdminHolding);

        var refused = await Should.ThrowAsync<RpcException>(() =>
            service.Client.SetGlobalCategoryPreferenceAsync(new SetGlobalCategoryPreferenceRequest
            {
                IdentityId = blocked.ToString("D"),
                Category = NotificationCategory.AccessRequestCommunity,
                Enabled = false,
            }).ResponseAsync);
        refused.StatusCode.ShouldBe(StatusCode.PermissionDenied);
    }

    [Theory]
    [InlineData(NotificationCategory.AccessRequestCommunity)]
    [InlineData(NotificationCategory.AccessRequestAuction)]
    public async Task When_AccessRequestsSetPerMeetup_Expect_InvalidArgument(NotificationCategory category)
    {
        await using var service = await PreferencesUnderTest.Start();
        var admin = await Person(service.Database, AdminHolding);

        var refused = await Should.ThrowAsync<RpcException>(() =>
            service.Client.SetMeetupCategoryPreferenceAsync(new SetMeetupCategoryPreferenceRequest
            {
                IdentityId = admin.ToString("D"),
                MeetupId = Guid.CreateVersion7().ToString("D"),
                Category = category,
                Enabled = false,
            }).ResponseAsync);
        refused.StatusCode.ShouldBe(StatusCode.InvalidArgument);
    }

    /// <summary>
    /// Сохранённое выключение прежней общей категории миграция переносит на обе
    /// новые: кто выключал её, тот выключал и ту, и другую (PER-635).
    /// </summary>
    [Fact]
    public async Task When_LegacyAccessRequestSettingMigrated_Expect_BothQueuesOff()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);

        // Состояние до миграции: строки прежнего ключа и ограничение, которое
        // их допускало.
        var person = Guid.CreateVersion7();
        var keptOn = Guid.CreateVersion7();
        await Execute(db, """
            ALTER TABLE notification_preference DROP CONSTRAINT notification_preference_category_known;
            INSERT INTO notification_preference (identity_id, meetup_id, category, enabled, updated_at)
            VALUES (@Person, NULL, 'access_request', false, now()),
                   (@KeptOn, NULL, 'access_request', true, now());
            """, new { Person = person, KeptOn = keptOn });

        await Execute(db, Migrations.List().Single(migration => migration.Version == 37).Sql, new { });

        await using var connection = new NpgsqlConnection(db.ConnectionString);
        var stored = (await connection.QueryAsync<PreferenceRow>(
                "SELECT identity_id AS IdentityId, category AS Category, enabled AS Enabled FROM notification_preference ORDER BY identity_id, category;"))
            .ToList();

        stored.ShouldBe(
            [
                new PreferenceRow(person, "access_request_auction", false),
                new PreferenceRow(person, "access_request_community", false),
                new PreferenceRow(keptOn, "access_request_auction", true),
                new PreferenceRow(keptOn, "access_request_community", true),
            ],
            ignoreOrder: true);
    }

    private sealed record PreferenceRow(Guid IdentityId, string Category, bool Enabled);

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
