using Dapper;
using Grpc.Net.Client;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.Infrastructure;
using Notifications.Replica;
using Notifications.TestKit;
using Notifications.V1;
using Npgsql;
using Shouldly;
using Xunit;
using static Notifications.IntegrationTests.Infrastructure.FactFixtures;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Вход в состав организаторов подписывает человека на его сходку (PER-909,
/// ADR-076, п. 5, дополнение 2026-11-21). События публикуются в настоящий
/// JetStream, реплику собирает силос на том же composition root, что и сервис.
/// </summary>
/// <remarks>
/// Явная отписка сильнее входа: повторный вход в состав — снятие и новое
/// назначение — подписку не возвращает. Выход и снятие её не трогают.
/// </remarks>
public class OrganizerSubscriptionTests
{
    private const string MeetupCreated = "events.meetups.meetup_created";
    private const string MeetupChanged = "events.meetups.meetup_changed";
    private const string OrganizerAppointed = "events.meetups.meetup_organizer_appointed";
    private const string OrganizerDismissed = "events.meetups.meetup_organizer_dismissed";

    [Fact]
    public async Task When_MeetupCreatedInStream_Expect_AuthorSubscribed()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);

        var meetupId = EventFactory.NewId();
        var creation = EventFactory.Creation(meetupId);
        var author = Guid.Parse(creation.State.Author);

        await nats.Publish(MeetupCreated, creation);

        (await Eventually(() => FactFixtures.IsSubscribed(db, author, meetupId), subscribed => subscribed))
            .ShouldBeTrue();
        await Eventually(() => nats.Unacknowledged(ReplicaFeeds.Meetups), pending => pending == 0);
    }

    [Fact]
    public async Task When_OrganizerAppointedInStream_Expect_PersonSubscribed()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);

        var meetupId = EventFactory.NewId();
        var creation = EventFactory.Creation(meetupId);
        var author = Guid.Parse(creation.State.Author);
        var appointed = Guid.CreateVersion7();

        await nats.Publish(MeetupCreated, creation);
        await nats.Publish(
            OrganizerAppointed,
            EventFactory.OrganizerChange(
                meetupId, version: 2, appointed.ToString(), appointed: true, author.ToString(), author: author.ToString()));

        (await Eventually(() => FactFixtures.IsSubscribed(db, appointed, meetupId), subscribed => subscribed))
            .ShouldBeTrue();
        await Eventually(() => nats.Unacknowledged(ReplicaFeeds.Meetups), pending => pending == 0);
    }

    /// <summary>
    /// Снятие из состава подписку не снимает: человек перестал вести сходку, но
    /// следить за ней не переставал.
    /// </summary>
    [Fact]
    public async Task When_OrganizerDismissedInStream_Expect_SubscriptionKept()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);

        var meetupId = EventFactory.NewId();
        var creation = EventFactory.Creation(meetupId);
        var author = creation.State.Author;
        var appointed = Guid.CreateVersion7();

        await nats.Publish(MeetupCreated, creation);
        await nats.Publish(
            OrganizerAppointed,
            EventFactory.OrganizerChange(
                meetupId, version: 2, appointed.ToString(), appointed: true, author, author: author));
        await Eventually(() => FactFixtures.IsSubscribed(db, appointed, meetupId), subscribed => subscribed);

        await nats.Publish(
            OrganizerDismissed,
            EventFactory.OrganizerChange(
                meetupId, version: 3, appointed.ToString(), appointed: false, author, author: author));
        await Eventually(() => ReplicaVersion(db, meetupId), version => version == 3);

        (await FactFixtures.IsSubscribed(db, appointed, meetupId)).ShouldBeTrue();
    }

    /// <summary>
    /// Явная отписка сильнее входа в состав: снятый и назначенный заново
    /// организатор подписку не получает — её возвращает только явная подписка.
    /// </summary>
    [Fact]
    public async Task When_OrganizerUnsubscribedAndAppointedAgain_Expect_NoSubscription()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);

        var meetupId = EventFactory.NewId();
        var creation = EventFactory.Creation(meetupId);
        var author = creation.State.Author;
        var appointed = Guid.CreateVersion7();

        await nats.Publish(MeetupCreated, creation);
        await nats.Publish(
            OrganizerAppointed,
            EventFactory.OrganizerChange(
                meetupId, version: 2, appointed.ToString(), appointed: true, author, author: author));
        await Eventually(() => FactFixtures.IsSubscribed(db, appointed, meetupId), subscribed => subscribed);

        var client = new NotificationsService.NotificationsServiceClient(
            SiloUnderTest.AsBot(GrpcChannel.ForAddress(silo.Address)));
        await client.UnsubscribeFromMeetupAsync(
            new UnsubscribeFromMeetupRequest { IdentityId = appointed.ToString(), MeetupId = meetupId },
            cancellationToken: TestContext.Current.CancellationToken);
        (await FactFixtures.IsSubscribed(db, appointed, meetupId)).ShouldBeFalse();

        await nats.Publish(
            OrganizerDismissed,
            EventFactory.OrganizerChange(
                meetupId, version: 3, appointed.ToString(), appointed: false, author, author: author));
        await Eventually(() => ReplicaVersion(db, meetupId), version => version == 3);

        await nats.Publish(
            OrganizerAppointed,
            EventFactory.OrganizerChange(
                meetupId, version: 4, appointed.ToString(), appointed: true, author, author: author));
        await Eventually(() => ReplicaVersion(db, meetupId), version => version == 4);

        (await FactFixtures.IsSubscribed(db, appointed, meetupId)).ShouldBeFalse();
        await Eventually(() => nats.Unacknowledged(ReplicaFeeds.Meetups), pending => pending == 0);

        // Вернуть подписку может только явная команда человека.
        await client.SubscribeToMeetupAsync(
            new SubscribeToMeetupRequest { IdentityId = appointed.ToString(), MeetupId = meetupId },
            cancellationToken: TestContext.Current.CancellationToken);
        (await FactFixtures.IsSubscribed(db, appointed, meetupId)).ShouldBeTrue();
    }

    /// <summary>
    /// Вне состава не подписывается никто: правка сходки, которая состав не
    /// трогает, подписки не заводит — даже автору, который в этом событии есть
    /// только как атрибут снимка (ADR-076, п. 3).
    /// </summary>
    [Fact]
    public async Task When_MeetupChangedWithoutRosterEntry_Expect_NoSubscription()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);

        var meetupId = EventFactory.NewId();
        var later = EventFactory.Meetup(meetupId, version: 3);
        later.MeetupChanged = new Meetups.V1.MeetupChanged();

        await nats.Publish(MeetupChanged, later);
        await Eventually(() => ReplicaVersion(db, meetupId), version => version == 3);
        await Eventually(() => nats.Unacknowledged(ReplicaFeeds.Meetups), pending => pending == 0);

        (await FactFixtures.SubscribedPeople(db)).ShouldBeEmpty();
    }

    /// <summary>
    /// Запоздавшее назначение остаётся входом в состав, даже когда снимок уже
    /// сдвинула более поздняя правка: иначе повтор после `Nak` терял бы
    /// подписку действующего организатора.
    /// </summary>
    [Fact]
    public async Task When_OrganizerAppointedAfterLaterEvent_Expect_PersonSubscribed()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);

        var meetupId = EventFactory.NewId();
        var appointed = Guid.CreateVersion7();

        // Правка версии 3 применяется первой; назначение версии 2 придёт
        // запоздавшим и снимок не сдвинет.
        var later = EventFactory.Meetup(meetupId, version: 3);
        later.MeetupChanged = new Meetups.V1.MeetupChanged();
        await nats.Publish(MeetupChanged, later);
        await Eventually(() => ReplicaVersion(db, meetupId), version => version == 3);

        await nats.Publish(
            OrganizerAppointed,
            EventFactory.OrganizerChange(meetupId, version: 2, appointed.ToString(), appointed: true, performedBy: null));

        (await Eventually(() => FactFixtures.IsSubscribed(db, appointed, meetupId), subscribed => subscribed))
            .ShouldBeTrue();
        (await ReplicaVersion(db, meetupId)).ShouldBe(3);
    }

    /// <summary>
    /// Отписка и вход в состав у одной пары «человек и сходка» сериализованы:
    /// автоподписка, вставшая за незакоммиченной отпиской, видит её память и
    /// подписку не возвращает. Без общей блокировки обе строки остались бы
    /// живыми, и человек получал бы сообщения вопреки отписке.
    /// </summary>
    [Fact]
    public async Task When_UnsubscribeCommitsWhileOrganizerEntersRoster_Expect_NoSubscription()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var silo = await SiloUnderTest.Start(db.ConnectionString);

        var subscriptions = silo.Service<SubscriptionStore>();
        var person = Guid.CreateVersion7();
        var meetupId = Guid.CreateVersion7();
        var cancellation = TestContext.Current.CancellationToken;
        await using var source = NpgsqlDataSource.Create(db.ConnectionString);

        await using var unsubscribe = await UnitOfWork.Begin(source, cancellation);
        await subscriptions.Unsubscribe(unsubscribe, person, meetupId, cancellation);

        await using var subscribe = await UnitOfWork.Begin(source, cancellation);
        var entered = SubscriptionStore.AutoSubscribe(subscribe, person, meetupId, DateTimeOffset.UtcNow, cancellation);

        // Положительное доказательство, что автоподписка встала за блокировкой
        // пары, а не разминулась с отпиской: пока отписка не закоммичена, её
        // backend ждёт транзакционную блокировку.
        await Eventually(() => FactFixtures.WaitingOnPairLock(db), waiting => waiting == 1);
        entered.IsCompleted.ShouldBeFalse();

        await unsubscribe.Commit(cancellation);
        await entered;
        await subscribe.Commit(cancellation);

        (await FactFixtures.IsSubscribed(db, person, meetupId.ToString())).ShouldBeFalse();
    }

    private static async Task<long> ReplicaVersion(IsolatedDatabase db, string meetupId)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);

        return await connection.ExecuteScalarAsync<long>(
            "SELECT version FROM meetup_replica WHERE meetup_id = @Id;",
            new { Id = Guid.Parse(meetupId) });
    }
}
