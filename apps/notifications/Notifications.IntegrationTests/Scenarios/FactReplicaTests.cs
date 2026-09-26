using Dapper;
using Microsoft.Extensions.Hosting;
using Notifications.Infrastructure;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.Replica;
using Notifications.TestKit;
using Npgsql;
using Shouldly;
using Xunit;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Реплика чужих фактов на настоящем JetStream и настоящей PostgreSQL:
/// событие публикуется в стрим так, как его публикует producer, а силос
/// поднят тем же composition root, что и сервис.
/// </summary>
/// <remarks>
/// Клиента Meetups и Identity в сервисе нет вовсе, поэтому «без запроса в
/// Meetups» здесь держится структурно: единственный путь факта в реплику —
/// сообщение шины.
/// </remarks>
public class FactReplicaTests
{
    private const string MeetupPublished = "events.meetups.meetup_published";
    private const string MeetupChanged = "events.meetups.meetup_changed";
    private const string RoleGranted = "events.identity.role_granted";
    private const string ProfileBlocked = "events.identity.profile_blocked";

    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(30);

    [Fact]
    public async Task When_MeetupPublishedInStream_Expect_MeetupInReplica()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);

        var meetupId = EventFactory.NewId();
        await nats.Publish(MeetupPublished, EventFactory.Meetup(meetupId, version: 1, title: "Пятничная"));

        var row = await Eventually(() => Meetup(db, meetupId), row => row is not null);

        row!.version.ShouldBe(1);
        row.title.ShouldBe("Пятничная");
        row.visibility.ShouldBe("visible");
        row.schedule_precision.ShouldBe("day_start");
        row.first_published_at.ShouldNotBeNull();
        await Eventually(() => nats.Unacknowledged(ReplicaFeeds.Meetups), pending => pending == 0);
    }

    [Fact]
    public async Task When_SameEventRedelivered_Expect_ReplicaChangedOnce()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var telemetry = silo.Service<ReplicaTelemetry>();

        var meetupId = EventFactory.NewId();
        var first = EventFactory.Meetup(meetupId, version: 1);
        await nats.Publish(MeetupPublished, first);
        var applied = await Eventually(() => Meetup(db, meetupId), row => row is not null);

        // Тот же event_id под другим Nats-Msg-Id: сервер его не отсекает, и
        // повтор доходит до потребителя — ровно случай повторной публикации
        // после окна дедупликации шины.
        await nats.Publish(MeetupPublished, first, messageId: Guid.NewGuid().ToString());
        await Eventually(() => Task.FromResult(telemetry.Total(ReplicaFeeds.MeetupsSource, "duplicate")), count => count == 1);

        var after = await Meetup(db, meetupId);
        after!.applied_at.ShouldBe(applied!.applied_at);
        telemetry.Total(ReplicaFeeds.MeetupsSource, "applied").ShouldBe(1);
        (await ConsumedKeys(db)).ShouldBe(1);
    }

    [Fact]
    public async Task When_OlderEventArrivesAfterNewer_Expect_ReplicaKeepsNewer()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var telemetry = silo.Service<ReplicaTelemetry>();

        var meetupId = EventFactory.NewId();
        await nats.Publish(MeetupChanged, EventFactory.Meetup(meetupId, version: 2, title: "Новое имя"));
        await nats.Publish(MeetupPublished, EventFactory.Meetup(meetupId, version: 1, title: "Старое имя"));

        await Eventually(() => Task.FromResult(telemetry.Total(ReplicaFeeds.MeetupsSource, "stale")), count => count == 1);

        var row = await Meetup(db, meetupId);
        row!.version.ShouldBe(2);
        row.title.ShouldBe("Новое имя");

        // Устаревшее событие подтверждено вместе со своим ключом: иначе шина
        // возвращала бы его снова.
        (await ConsumedKeys(db)).ShouldBe(2);
        await Eventually(() => nats.Unacknowledged(ReplicaFeeds.Meetups), pending => pending == 0);
    }

    [Fact]
    public async Task When_PersonBlocked_Expect_ReplicaMarksBlockedAndKeepsPreferences()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);

        var identityId = EventFactory.NewId();
        await Execute(
            db,
            "INSERT INTO meetup_subscription (identity_id, meetup_id, subscribed_at) VALUES (@IdentityId, @MeetupId, now());",
            new { IdentityId = Guid.Parse(identityId), MeetupId = Guid.NewGuid() });

        await nats.Publish(RoleGranted, EventFactory.Identity(identityId, version: 1));
        await nats.Publish(ProfileBlocked, EventFactory.Identity(identityId, version: 2, blocked: true));

        var row = await Eventually(() => Identity(db, identityId), row => row is { version: 2 });

        row!.blocked.ShouldBeTrue();
        row.global_roles.ShouldBeEmpty();
        (await Scalar<long>(db, "SELECT count(*) FROM meetup_subscription;")).ShouldBe(1);
    }

    [Fact]
    public async Task When_EventsApplied_Expect_AgeOfLatestVisiblePerSource()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();

        var meetupId = EventFactory.NewId();
        var identityId = EventFactory.NewId();

        await using (var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url))
        {
            var telemetry = silo.Service<ReplicaTelemetry>();

            await nats.Publish(MeetupPublished, EventFactory.Meetup(meetupId, version: 3));
            await nats.Publish(RoleGranted, EventFactory.Identity(identityId, version: 1));

            await Eventually(() => Task.FromResult(telemetry.LastAppliedAt(ReplicaFeeds.IdentitySource)), at => at is not null);
            await Eventually(() => Task.FromResult(telemetry.LastAppliedAt(ReplicaFeeds.MeetupsSource)), at => at is not null);

            telemetry.LastAppliedAt(ReplicaFeeds.MeetupsSource).ShouldBe(EventFactory.Committed.AddMinutes(3));
            telemetry.LastAppliedAt(ReplicaFeeds.IdentitySource).ShouldBe(EventFactory.Committed.AddMinutes(1));
            telemetry.AgeSeconds(ReplicaFeeds.MeetupsSource)!.Value.ShouldBeGreaterThan(0);
        }

        // Рестарт не обнуляет возраст: отметка восстанавливается из реплики
        // до первого нового события.
        await using (var restarted = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url))
        {
            var telemetry = restarted.Service<ReplicaTelemetry>();

            await Eventually(() => Task.FromResult(telemetry.LastAppliedAt(ReplicaFeeds.MeetupsSource)), at => at is not null);
            telemetry.LastAppliedAt(ReplicaFeeds.MeetupsSource).ShouldBe(EventFactory.Committed.AddMinutes(3));
        }
    }

    [Fact]
    public async Task When_MessageBreaksContract_Expect_DroppedAndStreamKeepsFlowing()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var telemetry = silo.Service<ReplicaTelemetry>();

        var broken = EventFactory.Meetup(EventFactory.NewId(), version: 1);
        broken.Version = 0;
        var meetupId = EventFactory.NewId();

        await nats.Publish(MeetupPublished, broken);
        await nats.Publish(MeetupPublished, EventFactory.Meetup(meetupId, version: 1));

        await Eventually(() => Meetup(db, meetupId), row => row is not null);
        telemetry.Total(ReplicaFeeds.MeetupsSource, "poison").ShouldBe(1);
        (await ConsumedKeys(db)).ShouldBe(1);
        await Eventually(() => nats.Unacknowledged(ReplicaFeeds.Meetups), pending => pending == 0);
    }

    [Fact]
    public async Task When_DurableMissing_Expect_ServiceStops()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start(withDurables: false);
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);

        var stopping = new TaskCompletionSource();
        silo.Service<IHostApplicationLifetime>().ApplicationStopping.Register(() => stopping.TrySetResult());

        // Durable сервис не заводит: иначе пришедшее до первого старта было
        // бы потеряно, а настройки шины разошлись бы с топологией AppHost.
        await stopping.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);

        (await nats.JetStream.ListConsumerNamesAsync(ReplicaFeeds.Meetups.Stream).ToListAsync()).ShouldBeEmpty();
    }

    [Fact]
    public async Task When_StreamKeepsMessagesLongerThanKeys_Expect_ServiceStops()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start(streamMaxAge: TimeSpan.FromDays(30));
        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);

        var stopping = new TaskCompletionSource();
        silo.Service<IHostApplicationLifetime>().ApplicationStopping.Register(() => stopping.TrySetResult());

        // Стрим способен доставить повтор через тридцать дней, а ключ живёт
        // восемь: после чистки повтор применился бы как новое событие.
        await stopping.Task.WaitAsync(Patience, TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task When_KeysOutliveRetention_Expect_OnlyOldKeysPruned()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var silo = await SiloUnderTest.Start(db.ConnectionString);

        // Оба ключа моложе штатного окна хранения: проход чистки, который
        // силос делает сам при старте, их не трогает, и порог здесь задаёт
        // только тест.
        var now = DateTimeOffset.UtcNow;
        const string insert = "INSERT INTO consumed_event (source, event_id, consumed_at) VALUES ('meetups', @EventId, @At);";
        await Execute(db, insert, new { EventId = Guid.NewGuid(), At = now.AddDays(-5).UtcDateTime });
        await Execute(db, insert, new { EventId = Guid.NewGuid(), At = now.AddDays(-1).UtcDateTime });

        var removed = await silo.Service<ReplicaStore>().Prune(now.AddDays(-3), TestContext.Current.CancellationToken);

        removed.ShouldBe(1);
        (await ConsumedKeys(db)).ShouldBe(1);
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

    private static async Task<MeetupRow?> Meetup(IsolatedDatabase db, string meetupId)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        return await connection.QuerySingleOrDefaultAsync<MeetupRow>(
            "SELECT version, title, visibility, schedule_precision, first_published_at, applied_at FROM meetup_replica WHERE meetup_id = @Id;",
            new { Id = Guid.Parse(meetupId) });
    }

    private static async Task<IdentityRow?> Identity(IsolatedDatabase db, string identityId)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        return await connection.QuerySingleOrDefaultAsync<IdentityRow>(
            "SELECT version, global_roles, blocked FROM identity_replica WHERE identity_id = @Id;",
            new { Id = Guid.Parse(identityId) });
    }

    private static Task<long> ConsumedKeys(IsolatedDatabase db) => Scalar<long>(db, "SELECT count(*) FROM consumed_event;");

    private static async Task<T> Scalar<T>(IsolatedDatabase db, string sql)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        return await connection.ExecuteScalarAsync<T>(sql) ?? throw new InvalidOperationException(sql);
    }

    private static async Task Execute(IsolatedDatabase db, string sql, object parameters)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        await connection.ExecuteAsync(sql, parameters);
    }

    private sealed record MeetupRow(
        long version,
        string title,
        string visibility,
        string? schedule_precision,
        DateTime? first_published_at,
        DateTime applied_at);

    // Класс, а не позиционная запись: Dapper видит text[] как System.Array и
    // конструктор со string[] не подбирает, а сеттер присваивает.
    private sealed class IdentityRow
    {
        public long version { get; init; }

        public string[] global_roles { get; init; } = [];

        public bool blocked { get; init; }
    }
}
