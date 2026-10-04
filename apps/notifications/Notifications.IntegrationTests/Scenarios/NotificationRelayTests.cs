using Dapper;
using Google.Protobuf;
using Notifications.Facts;
using Notifications.Infrastructure;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.V1;
using Npgsql;
using Shouldly;
using Xunit;
using static Notifications.IntegrationTests.Infrastructure.FactFixtures;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Выход Notifications: строка, которую шина отвергает всегда, не держит
/// очередь, временный отказ шины строку не вычёркивает, а закрытые строки
/// старше горизонта удаляются.
/// </summary>
/// <remarks>
/// Строки кладутся в таблицу прямой вставкой, а не разворотом повода: срезу
/// важен релей, а не то, кому факт положен. Отказ «всегда» даёт настоящий
/// JetStream — стрим фактов с пределом размера сообщения, — а не подставной
/// публикатор: так проверяется и то, каким исключением шина отказывает.
/// </remarks>
public class NotificationRelayTests
{
    private const int MaxMessageSize = 1024;

    [Fact]
    public async Task When_BusRejectsRowAlways_Expect_RowRejectedAfterLimitAndNextFactsPublished()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start(factsMaxMessageSize: MaxMessageSize);

        // Крупная строка старше обычной: очередь идёт по created_at, и без
        // предела попыток обычная за ней не ушла бы никогда.
        var oversized = await Pending(db, new byte[MaxMessageSize * 2], DateTime.UtcNow.AddMinutes(-2));
        var regular = await Pending(db, Fact(), DateTime.UtcNow.AddMinutes(-1));

        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url);
        var telemetry = silo.Service<FactTelemetry>();

        var row = await Eventually(() => Row(db, oversized), row => row.RejectedAt is not null);
        row.Attempts.ShouldBe(new DispatchOptions().MaxAttempts);
        row.RejectionError.ShouldNotBeNullOrWhiteSpace();
        row.DispatchedAt.ShouldBeNull();
        row.WithdrawnAt.ShouldBeNull();

        var published = await Eventually(() => nats.PublishedFacts(), facts => facts.Count > 0);
        published.Single().MessageId.ShouldBe(regular.ToString());
        (await Row(db, regular)).DispatchedAt.ShouldNotBeNull();

        telemetry.Total("relay_rejected").ShouldBe(1);
        telemetry.Total("relay_refused").ShouldBe(new DispatchOptions().MaxAttempts - 1);
        (await silo.Service<NotificationStore>().OldestPending(TestContext.Current.CancellationToken)).ShouldBeNull();
    }

    /// <summary>
    /// Временный отказ попытку не тратит: предел в одну попытку вычеркнул бы
    /// строку на первом же проходе, если бы отказ замёрзшей шины считался.
    /// </summary>
    [Fact]
    public async Task When_BusUnavailableThenRestored_Expect_RowKeptAndPublished()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();

        await using var silo = await SiloUnderTest.StartOnBus(
            db.ConnectionString, nats.Url, "--Notifications:Dispatch:MaxAttempts=1");
        var telemetry = silo.Service<FactTelemetry>();

        await nats.Pause();
        var id = await Pending(db, Fact(), DateTime.UtcNow);

        await Eventually(() => Task.FromResult(telemetry.Total("dispatch_failures")), failures => failures > 0);
        var held = await Row(db, id);
        held.Attempts.ShouldBe(0);
        held.RejectedAt.ShouldBeNull();
        held.DispatchedAt.ShouldBeNull();

        await nats.Unpause();

        await Eventually(() => Row(db, id), row => row.DispatchedAt is not null);
        (await nats.PublishedFacts()).Single().MessageId.ShouldBe(id.ToString());
        telemetry.Total("relay_rejected").ShouldBe(0);
    }

    /// <summary>
    /// Возраст закрытой строки считается от исхода, а неотправленная остаётся
    /// при любом возрасте.
    /// </summary>
    [Fact]
    public async Task When_PrunedPastHorizon_Expect_ClosedRowsDeletedPendingKept()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);

        var now = DateTime.UtcNow;
        var old = now.AddDays(-40);
        var ancient = now.AddDays(-100);

        var oldDispatched = await Closed(db, ancient, dispatchedAt: old);
        var oldWithdrawn = await Closed(db, ancient, withdrawnAt: old);
        var oldRejected = await Closed(db, ancient, rejectedAt: old);

        // Родилась давно, а вынесена вчера — после недели простоя шины.
        var recentlyDispatched = await Closed(db, ancient, dispatchedAt: now.AddDays(-1));
        var pending = await Pending(db, Fact(), ancient);

        await using var source = NpgsqlDataSource.Create(db.ConnectionString);
        var removed = await new NotificationStore(source).Prune(
            new DateTimeOffset(now.AddDays(-30)), TestContext.Current.CancellationToken);

        removed.ShouldBe(3);
        var left = await Ids(db);
        left.ShouldBe([recentlyDispatched, pending], ignoreOrder: true);
        left.ShouldNotContain(oldDispatched);
        left.ShouldNotContain(oldWithdrawn);
        left.ShouldNotContain(oldRejected);
    }

    /// <summary>
    /// Горизонт короче срока жизни ключей событий сломал бы дедупликацию
    /// повода, и сервис отказывает на старте, а не на первой чистке.
    /// </summary>
    [Fact]
    public async Task When_RetentionShorterThanKeyRetention_Expect_StartFails()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);

        await Should.ThrowAsync<Microsoft.Extensions.Options.OptionsValidationException>(() =>
            SiloUnderTest.Start(db.ConnectionString, "--Notifications:Dispatch:Retention=1.00:00:00"));
    }

    /// <summary>Один исход у строки держит схема, а не порядок операций в коде.</summary>
    [Fact]
    public async Task When_OutcomesContradictRow_Expect_SchemaRejects()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);

        var now = DateTime.UtcNow;

        await Should.ThrowAsync<PostgresException>(() => Closed(db, now, dispatchedAt: now, rejectedAt: now));
        await Should.ThrowAsync<PostgresException>(() => Closed(db, now, withdrawnAt: now, rejectedAt: now));
        await Should.ThrowAsync<PostgresException>(() => Closed(db, now, dispatchedAt: now, withdrawnAt: now));

        var id = await Pending(db, Fact(), now);
        await Should.ThrowAsync<PostgresException>(() =>
            Execute(db, "UPDATE notification SET rejected_at = now() WHERE notification_id = @Id;", new { Id = id }));
        await Should.ThrowAsync<PostgresException>(() =>
            Execute(db, "UPDATE notification SET dispatch_attempts = -1 WHERE notification_id = @Id;", new { Id = id }));

        await Closed(db, now, rejectedAt: now);
    }

    private static byte[] Fact() =>
        new Notification { NotificationId = Guid.NewGuid().ToString(), RecipientId = Guid.NewGuid().ToString() }
            .ToByteArray();

    private static async Task<Guid> Pending(IsolatedDatabase db, byte[] payload, DateTime createdAt)
    {
        var id = Guid.CreateVersion7();
        await Execute(db, Insert, new
        {
            Id = id,
            Payload = payload,
            CreatedAt = createdAt,
            DispatchedAt = (DateTime?)null,
            WithdrawnAt = (DateTime?)null,
            Reason = (string?)null,
            RejectedAt = (DateTime?)null,
            Error = (string?)null,
        });

        return id;
    }

    private static async Task<Guid> Closed(
        IsolatedDatabase db,
        DateTime createdAt,
        DateTime? dispatchedAt = null,
        DateTime? withdrawnAt = null,
        DateTime? rejectedAt = null)
    {
        var id = Guid.CreateVersion7();
        await Execute(db, Insert, new
        {
            Id = id,
            Payload = Fact(),
            CreatedAt = createdAt,
            DispatchedAt = dispatchedAt,
            WithdrawnAt = withdrawnAt,
            Reason = withdrawnAt is null ? null : NotificationFacts.WithdrawnExpired,
            RejectedAt = rejectedAt,
            Error = rejectedAt is null ? null : "message size exceeds maximum allowed",
        });

        return id;
    }

    private const string Insert = """
        INSERT INTO notification (
            notification_id, recipient_id, type, cause_kind, cause_id, payload, created_at,
            dispatched_at, withdrawn_at, withdrawal_reason, rejected_at, rejection_error)
        VALUES (@Id, gen_random_uuid(), 'meetup_changed', 'meetup_event', gen_random_uuid()::text,
                @Payload, @CreatedAt, @DispatchedAt, @WithdrawnAt, @Reason, @RejectedAt, @Error);
        """;

    private static async Task<RelayRow> Row(IsolatedDatabase db, Guid id)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        return await connection.QuerySingleAsync<RelayRow>(
            """
            SELECT dispatch_attempts AS Attempts, dispatched_at AS DispatchedAt, withdrawn_at AS WithdrawnAt,
                   rejected_at AS RejectedAt, rejection_error AS RejectionError
            FROM notification WHERE notification_id = @Id;
            """,
            new { Id = id });
    }

    private static async Task<IReadOnlyList<Guid>> Ids(IsolatedDatabase db)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        return (await connection.QueryAsync<Guid>("SELECT notification_id FROM notification;")).ToList();
    }

    private sealed class RelayRow
    {
        public int Attempts { get; init; }

        public DateTime? DispatchedAt { get; init; }

        public DateTime? WithdrawnAt { get; init; }

        public DateTime? RejectedAt { get; init; }

        public string? RejectionError { get; init; }

        public override string ToString() =>
            $"attempts={Attempts} dispatched={DispatchedAt} withdrawn={WithdrawnAt} rejected={RejectedAt}";
    }
}
