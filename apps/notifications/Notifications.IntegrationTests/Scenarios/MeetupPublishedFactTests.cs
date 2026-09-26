using Dapper;
using Meetups.V1;
using Notifications.Facts;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.Replica;
using Notifications.TestKit;
using Npgsql;
using Shouldly;
using Xunit;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Адресный факт «новая сходка» от события в стриме Meetups до сообщения в
/// стриме уведомлений: разворот аудитории, подавление повтора и вынос релеем.
/// </summary>
/// <remarks>
/// Люди и их настройки кладутся в базу напрямую, а не событиями Identity:
/// путь события в реплику проверяет <see cref="FactReplicaTests" />, а здесь
/// предмет — решение «кому положено», и порядок двух стримов между собой
/// сделал бы его гонкой.
/// </remarks>
public class MeetupPublishedFactTests
{
    private const string MeetupPublishedSubject = "events.meetups.meetup_published";
    private const string MeetupChangedSubject = "events.meetups.meetup_changed";
    private const string MeetupUnpublishedSubject = "events.meetups.meetup_unpublished";
    private const string MeetupRepublishedSubject = "events.meetups.meetup_republished";

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(30);

    [Fact]
    public async Task When_MeetupPublished_Expect_OneFactPerPersonWithCategoryOn()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();

        var byDefault = await Person(db, "member");
        var explicitlyOn = await Person(db, "admin", "member", "public");
        var switchedOff = await Person(db, "member");
        var auctionOnly = await Person(db, "public");
        var blocked = await Person(db, blocked: true, "member");
        await Preference(db, explicitlyOn, enabled: true);
        await Preference(db, switchedOff, enabled: false);

        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var telemetry = silo.Service<FactTelemetry>();

        var meetupId = EventFactory.NewId();
        var published = EventFactory.Meetup(meetupId, version: 2, title: "Пятничная", requestId: "req-216");
        await nats.Publish(MeetupPublishedSubject, published);

        var facts = await Eventually(nats.PublishedFacts, facts => facts.Count == 2);

        facts.Select(fact => Guid.Parse(fact.Fact.RecipientId)).ShouldBe([byDefault, explicitlyOn], ignoreOrder: true);
        facts.Select(fact => fact.Fact.RecipientId).ShouldNotContain(switchedOff.ToString());
        facts.Select(fact => fact.Fact.RecipientId).ShouldNotContain(auctionOnly.ToString());
        facts.Select(fact => fact.Fact.RecipientId).ShouldNotContain(blocked.ToString());

        foreach (var (fact, messageId) in facts)
        {
            messageId.ShouldBe(fact.NotificationId);
            fact.Cause.MeetupEventId.ShouldBe(published.EventId);
            fact.RequestId.ShouldBe("req-216");
            fact.HasNotAfter.ShouldBeTrue();
            fact.MeetupPublished.Meetup.Id.ShouldBe(meetupId);
            fact.MeetupPublished.Meetup.Title.ShouldBe("Пятничная");
        }

        telemetry.Total("created").ShouldBe(2);
        telemetry.Total("suppressed").ShouldBe(1);
        await Eventually(() => Pending(db), pending => pending == 0);
    }

    [Fact]
    public async Task When_PublicationRedelivered_Expect_FactsNotDoubled()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await Person(db, "member");
        await Person(db, "member");
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var replica = silo.Service<ReplicaTelemetry>();

        var published = EventFactory.Meetup(EventFactory.NewId(), version: 2);
        await nats.Publish(MeetupPublishedSubject, published);
        await Eventually(() => Facts(db), count => count == 2);

        // Тот же event_id под другим Nats-Msg-Id: сервер его не отсекает, и
        // повтор доходит до потребителя.
        await nats.Publish(MeetupPublishedSubject, published, messageId: Guid.NewGuid().ToString());
        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.MeetupsSource, "duplicate")), count => count == 1);

        (await Facts(db)).ShouldBe(2);
        (await Eventually(nats.PublishedFacts, facts => facts.Count == 2)).Count.ShouldBe(2);
    }

    [Fact]
    public async Task When_UnpublishedAndRepublished_Expect_NoSecondNewMeetupFact()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await Person(db, "member");
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var replica = silo.Service<ReplicaTelemetry>();

        var meetupId = EventFactory.NewId();
        await nats.Publish(MeetupPublishedSubject, EventFactory.Meetup(meetupId, version: 2));
        await Eventually(() => Facts(db), count => count == 1);

        var unpublished = EventFactory.Meetup(meetupId, version: 3);
        unpublished.MeetupUnpublished = new MeetupUnpublished();
        unpublished.State.Visibility = MeetupVisibility.Hidden;
        await nats.Publish(MeetupUnpublishedSubject, unpublished);

        var republished = EventFactory.Meetup(meetupId, version: 4);
        republished.MeetupRepublished = new MeetupRepublished();
        await nats.Publish(MeetupRepublishedSubject, republished);

        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.MeetupsSource, "applied")), count => count == 3);
        (await Facts(db)).ShouldBe(1);
    }

    /// <summary>
    /// Вторая «первая публикация» той же сходки под новым event_id — нарушение
    /// словаря producer'а, а не повод: обещание «одна новая сходка на человека»
    /// держит схема, а не только Meetups.
    /// </summary>
    [Fact]
    public async Task When_FirstPublicationArrivesTwiceUnderNewEventId_Expect_OneFactPerPerson()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await Person(db, "member");
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var replica = silo.Service<ReplicaTelemetry>();

        var meetupId = EventFactory.NewId();
        await nats.Publish(MeetupPublishedSubject, EventFactory.Meetup(meetupId, version: 2));
        await nats.Publish(MeetupPublishedSubject, EventFactory.Meetup(meetupId, version: 3));

        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.MeetupsSource, "applied")), count => count == 2);
        (await Facts(db)).ShouldBe(1);
    }

    /// <summary>
    /// Запоздавшая первая публикация реплику не двигает, но поводом остаётся:
    /// сходка всё равно стала видна впервые.
    /// </summary>
    [Fact]
    public async Task When_FirstPublicationArrivesAfterNewerEvent_Expect_FactStillCreated()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        var person = await Person(db, "member");
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var replica = silo.Service<ReplicaTelemetry>();

        var meetupId = EventFactory.NewId();
        var changed = EventFactory.Meetup(meetupId, version: 3, title: "Новое имя");
        changed.MeetupChanged = new MeetupChanged();
        await nats.Publish(MeetupChangedSubject, changed);
        await nats.Publish(MeetupPublishedSubject, EventFactory.Meetup(meetupId, version: 2, title: "Старое имя"));

        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.MeetupsSource, "stale")), count => count == 1);

        var facts = await Eventually(nats.PublishedFacts, facts => facts.Count == 1);
        facts[0].Fact.RecipientId.ShouldBe(person.ToString());

        // Карточка — значение на момент повода, а не текущий снимок реплики.
        facts[0].Fact.MeetupPublished.Meetup.Title.ShouldBe("Старое имя");
    }

    /// <summary>
    /// Первая публикация, вернувшаяся после Nak, когда снятие уже применено,
    /// реплику не двигает и сходку не объявляет: люди её уже не видят.
    /// </summary>
    [Fact]
    public async Task When_FirstPublicationArrivesAfterUnpublish_Expect_NoFact()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await Person(db, "member");
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var replica = silo.Service<ReplicaTelemetry>();

        var meetupId = EventFactory.NewId();
        var unpublished = EventFactory.Meetup(meetupId, version: 3);
        unpublished.MeetupUnpublished = new MeetupUnpublished();
        unpublished.State.Visibility = MeetupVisibility.Hidden;
        await nats.Publish(MeetupUnpublishedSubject, unpublished);
        await nats.Publish(MeetupPublishedSubject, EventFactory.Meetup(meetupId, version: 2));

        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.MeetupsSource, "stale")), count => count == 1);
        (await Facts(db)).ShouldBe(0);
    }

    /// <summary>
    /// Первая публикация со скрытой сходкой противоречит сама себе; объявлять
    /// то, чего никто не видит, сервис не станет.
    /// </summary>
    [Fact]
    public async Task When_FirstPublicationCarriesHiddenMeetup_Expect_NoFact()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await Person(db, "member");
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var replica = silo.Service<ReplicaTelemetry>();

        var hidden = EventFactory.Meetup(EventFactory.NewId(), version: 2);
        hidden.State.Visibility = MeetupVisibility.Hidden;
        await nats.Publish(MeetupPublishedSubject, hidden);

        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.MeetupsSource, "applied")), count => count == 1);
        (await Facts(db)).ShouldBe(0);
    }

    private static async Task<Guid> Person(IsolatedDatabase db, params string[] roles) =>
        await Person(db, blocked: false, roles);

    private static async Task<Guid> Person(IsolatedDatabase db, bool blocked, params string[] roles)
    {
        var id = Guid.CreateVersion7();
        await Execute(
            db,
            """
            INSERT INTO identity_replica (identity_id, version, global_roles, blocked, occurred_at, applied_at)
            VALUES (@Id, 1, @Roles, @Blocked, now(), now());
            """,
            new { Id = id, Roles = roles, Blocked = blocked });

        return id;
    }

    private static Task Preference(IsolatedDatabase db, Guid person, bool enabled) =>
        Execute(
            db,
            """
            INSERT INTO notification_preference (identity_id, meetup_id, category, enabled, updated_at)
            VALUES (@Person, NULL, 'meetup_published', @Enabled, now());
            """,
            new { Person = person, Enabled = enabled });

    private static Task<long> Facts(IsolatedDatabase db) => Scalar(db, "SELECT count(*) FROM notification;");

    private static Task<long> Pending(IsolatedDatabase db) =>
        Scalar(db, "SELECT count(*) FROM notification WHERE dispatched_at IS NULL;");

    private static async Task<long> Scalar(IsolatedDatabase db, string sql)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        return await connection.ExecuteScalarAsync<long>(sql);
    }

    private static async Task Execute(IsolatedDatabase db, string sql, object parameters)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        await connection.ExecuteAsync(sql, parameters);
    }

    private static async Task<T> Eventually<T>(Func<Task<T>> probe, Func<T, bool> done)
    {
        var deadline = DateTime.UtcNow + Patience;

        while (true)
        {
            var value = await probe();
            if (done(value))
            {
                return value;
            }

            if (DateTime.UtcNow > deadline)
            {
                throw new TimeoutException($"condition not reached within {Patience}; last value: {value}");
            }

            await Task.Delay(TimeSpan.FromMilliseconds(100), TestContext.Current.CancellationToken);
        }
    }
}
