using Dapper;
using Meetups.V1;
using Notifications.Facts;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.Replica;
using Notifications.TestKit;
using Notifications.V1;
using Npgsql;
using Shouldly;
using Xunit;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Адресные факты изменения, нового материала и снятия с публикации: от
/// события в стриме Meetups до сообщения в стриме уведомлений.
/// </summary>
/// <remarks>
/// Люди, подписки и настройки кладутся в базу напрямую, как в
/// <see cref="MeetupPublishedFactTests" />: предмет здесь — решение «кому
/// положено», а не путь событий Identity в реплику.
///
/// Каждый сценарий начинает с первой публикации: она кладёт в реплику снимок,
/// с которым сравниваются следующие события. Аудитория у неё — все с
/// включённой «новой сходкой», поэтому сценарии считают только факты своего
/// типа.
/// </remarks>
public class MeetupChangeFactTests
{
    private const string MeetupPublishedSubject = "events.meetups.meetup_published";
    private const string MeetupChangedSubject = "events.meetups.meetup_changed";
    private const string MeetupCancelledSubject = "events.meetups.meetup_cancelled";
    private const string MeetupUnpublishedSubject = "events.meetups.meetup_unpublished";
    private const string MaterialAttachedSubject = "events.meetups.meetup_material_attached";

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(30);

    /// <summary>
    /// Одна категория продукта, два вида факта: правка сведений и отмена
    /// приходят одним типом «изменена» и различаются аспектами.
    /// </summary>
    [Fact]
    public async Task When_InformationThenStateChanged_Expect_ChangedFactsWithDistinctAspects()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();

        var meetupId = EventFactory.NewId();
        var subscriber = await Person(db, "member");
        var bystander = await Person(db, "member");
        var blocked = await Person(db, blocked: true, "member");
        var auctionOnly = await Person(db, "public");
        await Subscribe(db, subscriber, meetupId);
        await Subscribe(db, blocked, meetupId);
        await Subscribe(db, auctionOnly, meetupId);

        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var replica = silo.Service<ReplicaTelemetry>();
        await Publish(nats, replica, meetupId);

        var renamed = Changed(meetupId, version: 3, title: "Пятничная", requestId: "req-218");
        await nats.Publish(MeetupChangedSubject, renamed);

        var cancelled = Changed(meetupId, version: 4, title: "Пятничная");
        cancelled.State.Lifecycle = MeetupLifecycle.Cancelled;
        cancelled.MeetupCancelled = new Meetups.V1.MeetupCancelled();
        await nats.Publish(MeetupCancelledSubject, cancelled);

        var facts = await Eventually(
            () => OfType(nats, Notification.TypeOneofCase.MeetupChanged),
            facts => facts.Count == 2);

        facts.ShouldAllBe(fact => fact.RecipientId == subscriber.ToString());
        facts.Select(fact => fact.RecipientId).ShouldNotContain(bystander.ToString());

        var byEvent = facts.ToDictionary(fact => fact.Cause.MeetupEventId);
        var information = byEvent[renamed.EventId].MeetupChanged;
        information.ChangedAspects.ShouldBe([MeetupAspect.Title]);
        information.ChangedAspects.ShouldAllBe(aspect => MeetupDiff.Information.Contains(aspect));
        information.Meetup.Title.ShouldBe("Пятничная");
        byEvent[renamed.EventId].RequestId.ShouldBe("req-218");

        var state = byEvent[cancelled.EventId].MeetupChanged;
        state.ChangedAspects.ShouldBe([MeetupAspect.Lifecycle]);
        state.ChangedAspects.ShouldAllBe(aspect => MeetupDiff.State.Contains(aspect));
        state.Meetup.Lifecycle.ShouldBe(MeetupLifecycle.Cancelled);
    }

    /// <summary>
    /// Событие, не меняющее ничего по сравнению с репликой, поводом не
    /// является: ни одного факта, ни записи повода в журнале применения.
    /// </summary>
    [Fact]
    public async Task When_ChangeRepeatsReplica_Expect_NoFact()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();

        var meetupId = EventFactory.NewId();
        await Subscribe(db, await Person(db, "member"), meetupId);

        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var replica = silo.Service<ReplicaTelemetry>();
        var telemetry = silo.Service<FactTelemetry>();
        await Publish(nats, replica, meetupId);
        var createdAfterPublication = telemetry.Total("created");

        await nats.Publish(MeetupChangedSubject, Changed(meetupId, version: 3));

        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.MeetupsSource, "applied")), count => count == 2);
        (await Facts(db, NotificationFacts.MeetupChangedType)).ShouldBe(0);
        telemetry.Total("created").ShouldBe(createdAfterPublication);
    }

    /// <summary>
    /// Перенос отдельного типа события не имеет: он приходит поводом
    /// «изменена» и узнаётся по расписанию в теле.
    /// </summary>
    [Fact]
    public async Task When_ScheduleMoved_Expect_ScheduleAspect()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();

        var meetupId = EventFactory.NewId();
        var subscriber = await Person(db, "member");
        await Subscribe(db, subscriber, meetupId);

        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        await Publish(nats, silo.Service<ReplicaTelemetry>(), meetupId);

        var moved = Changed(meetupId, version: 3);
        moved.State.Schedule.Fixed.DayStart.Date.Day = 16;
        await nats.Publish(MeetupChangedSubject, moved);

        var facts = await Eventually(
            () => OfType(nats, Notification.TypeOneofCase.MeetupChanged),
            facts => facts.Count == 1);

        facts[0].MeetupChanged.ChangedAspects.ShouldBe([MeetupAspect.Schedule]);
        facts[0].MeetupChanged.Meetup.Schedule.Fixed.DayStart.Date.Day.ShouldBe(16);
    }

    /// <summary>
    /// Переопределение у сходки перекрывает глобальную настройку в обе
    /// стороны, а без него действует глобальная или значение продукта.
    /// </summary>
    [Fact]
    public async Task When_MeetupOverrideDisagreesWithGlobal_Expect_OverrideWins()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();

        var meetupId = EventFactory.NewId();
        var globalOffOverrideOn = await Person(db, "member");
        var globalOnOverrideOff = await Person(db, "member");
        var globalOff = await Person(db, "member");
        var byDefault = await Person(db, "member");

        foreach (var person in new[] { globalOffOverrideOn, globalOnOverrideOff, globalOff, byDefault })
        {
            await Subscribe(db, person, meetupId);
        }

        await Preference(db, globalOffOverrideOn, null, "meetup_changed", enabled: false);
        await Preference(db, globalOffOverrideOn, meetupId, "meetup_changed", enabled: true);
        await Preference(db, globalOnOverrideOff, null, "meetup_changed", enabled: true);
        await Preference(db, globalOnOverrideOff, meetupId, "meetup_changed", enabled: false);
        await Preference(db, globalOff, null, "meetup_changed", enabled: false);

        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var telemetry = silo.Service<FactTelemetry>();
        await Publish(nats, silo.Service<ReplicaTelemetry>(), meetupId);
        var suppressedAfterPublication = telemetry.Total("suppressed");

        await nats.Publish(MeetupChangedSubject, Changed(meetupId, version: 3, title: "Пятничная"));

        var facts = await Eventually(
            () => OfType(nats, Notification.TypeOneofCase.MeetupChanged),
            facts => facts.Count == 2);

        facts.Select(fact => Guid.Parse(fact.RecipientId)).ShouldBe([globalOffOverrideOn, byDefault], ignoreOrder: true);
        telemetry.Total("suppressed").ShouldBe(suppressedAfterPublication + 2);
    }

    /// <summary>
    /// Служебное сообщение о снятии получают только подписчики с разрешённой
    /// категорией изменений. Получатель глобального анонса без подписки не
    /// получает ничего — расширение аудитории отвергнуто владельцем.
    /// </summary>
    [Fact]
    public async Task When_Unpublished_Expect_OnlySubscribersWithChangeCategory()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();

        var meetupId = EventFactory.NewId();
        var subscriber = await Person(db, "member");
        var switchedOff = await Person(db, "member");
        var announcedOnly = await Person(db, "member");
        await Subscribe(db, subscriber, meetupId);
        await Subscribe(db, switchedOff, meetupId);
        await Preference(db, switchedOff, meetupId, "meetup_changed", enabled: false);

        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var replica = silo.Service<ReplicaTelemetry>();
        await Publish(nats, replica, meetupId);

        var unpublished = Changed(meetupId, version: 3);
        unpublished.State.Visibility = MeetupVisibility.Hidden;
        unpublished.MeetupUnpublished = new Meetups.V1.MeetupUnpublished();
        await nats.Publish(MeetupUnpublishedSubject, unpublished);

        var facts = await Eventually(
            () => OfType(nats, Notification.TypeOneofCase.MeetupUnpublished),
            facts => facts.Count == 1);

        facts[0].RecipientId.ShouldBe(subscriber.ToString());
        facts[0].MeetupUnpublished.Meetup.Id.ShouldBe(meetupId);
        facts.Select(fact => fact.RecipientId).ShouldNotContain(announcedOnly.ToString());

        // Снятие — свой тип, а не заодно изменение видимости.
        (await Facts(db, NotificationFacts.MeetupChangedType)).ShouldBe(0);
    }

    [Fact]
    public async Task When_MaterialAttached_Expect_MaterialFactToSubscribersWithCategoryOn()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();

        var meetupId = EventFactory.NewId();
        var subscriber = await Person(db, "member");
        var switchedOff = await Person(db, "member");
        await Person(db, "member");
        await Subscribe(db, subscriber, meetupId);
        await Subscribe(db, switchedOff, meetupId);
        await Preference(db, switchedOff, null, "meetup_material", enabled: false);

        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        await Publish(nats, silo.Service<ReplicaTelemetry>(), meetupId);

        var materialId = EventFactory.NewId();
        await nats.Publish(MaterialAttachedSubject, EventFactory.Material(meetupId, version: 3, materialId, "Афиша"));

        var facts = await Eventually(
            () => OfType(nats, Notification.TypeOneofCase.MeetupMaterial),
            facts => facts.Count == 1);

        facts[0].RecipientId.ShouldBe(subscriber.ToString());
        facts[0].MeetupMaterial.MaterialId.ShouldBe(materialId);
        facts[0].MeetupMaterial.MaterialTitle.ShouldBe("Афиша");
        (await Facts(db, NotificationFacts.MeetupChangedType)).ShouldBe(0);
    }

    /// <summary>
    /// Повтор события изменения не удваивает факты, а изменение, пришедшее
    /// после более позднего, фактов не даёт: сравнивать его с более новой
    /// репликой значило бы объявить откат, которого не было.
    /// </summary>
    [Fact]
    public async Task When_ChangeRedeliveredOrStale_Expect_NoExtraFacts()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();

        var meetupId = EventFactory.NewId();
        await Subscribe(db, await Person(db, "member"), meetupId);

        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var replica = silo.Service<ReplicaTelemetry>();
        await Publish(nats, replica, meetupId);

        var later = Changed(meetupId, version: 4, title: "Позднее имя");
        await nats.Publish(MeetupChangedSubject, later);
        await Eventually(() => Facts(db, NotificationFacts.MeetupChangedType), count => count == 1);

        await nats.Publish(MeetupChangedSubject, later, messageId: Guid.NewGuid().ToString());
        await nats.Publish(MeetupChangedSubject, Changed(meetupId, version: 3, title: "Раннее имя"));

        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.MeetupsSource, "duplicate")), count => count == 1);
        await Eventually(() => Task.FromResult(replica.Total(ReplicaFeeds.MeetupsSource, "stale")), count => count == 1);
        (await Facts(db, NotificationFacts.MeetupChangedType)).ShouldBe(1);
    }

    private static MeetupEvent Changed(string meetupId, long version, string title = "Сходка", string? requestId = null)
    {
        var message = EventFactory.Meetup(meetupId, version, title: title, requestId: requestId);
        message.MeetupChanged = new Meetups.V1.MeetupChanged();
        return message;
    }

    // Первая публикация кладёт снимок в реплику; следующее событие сравнивается
    // уже с ним, поэтому сценарий ждёт её применения, а не только отправки.
    private static async Task Publish(NatsUnderTest nats, ReplicaTelemetry replica, string meetupId)
    {
        var applied = replica.Total(ReplicaFeeds.MeetupsSource, "applied");
        await nats.Publish(MeetupPublishedSubject, EventFactory.Meetup(meetupId, version: 2));
        await Eventually(
            () => Task.FromResult(replica.Total(ReplicaFeeds.MeetupsSource, "applied")),
            count => count == applied + 1);
    }

    private static async Task<IReadOnlyList<Notification>> OfType(NatsUnderTest nats, Notification.TypeOneofCase type) =>
        (await nats.PublishedFacts()).Select(fact => fact.Fact).Where(fact => fact.TypeCase == type).ToArray();

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

    private static Task Subscribe(IsolatedDatabase db, Guid person, string meetupId) =>
        Execute(
            db,
            """
            INSERT INTO meetup_subscription (identity_id, meetup_id, subscribed_at)
            VALUES (@Person, @MeetupId, now());
            """,
            new { Person = person, MeetupId = Guid.Parse(meetupId) });

    private static Task Preference(IsolatedDatabase db, Guid person, string? meetupId, string category, bool enabled) =>
        Execute(
            db,
            """
            INSERT INTO notification_preference (identity_id, meetup_id, category, enabled, updated_at)
            VALUES (@Person, @MeetupId, @Category, @Enabled, now());
            """,
            new { Person = person, MeetupId = meetupId is null ? (Guid?)null : Guid.Parse(meetupId), Category = category, Enabled = enabled });

    private static async Task<long> Facts(IsolatedDatabase db, string type)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        return await connection.ExecuteScalarAsync<long>(
            "SELECT count(*) FROM notification WHERE type = @Type;",
            new { Type = type });
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
