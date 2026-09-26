using Dapper;
using Meetups.V1;
using Notifications.Facts;
using Notifications.Infrastructure;
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
/// Снятие неотправленных адресных фактов: отмена сходки и истёкший срок
/// годности. Отправленное не трогается, снятое отличимо от застрявшего.
/// </summary>
/// <remarks>
/// Релей придержан периодом в час: первый проход он делает на старте, когда
/// очередь пуста, и дальше молчит — так факты остаются неотправленными, как
/// при лежащей шине. Проход, который нужен сценарию, тест вызывает сам через
/// <see cref="NotificationStore.Dispatch" />, записывая публикации в список, —
/// шина здесь нужна только потребителю реплики.
/// </remarks>
public class NotificationWithdrawalTests
{
    private const string MeetupPublishedSubject = "events.meetups.meetup_published";
    private const string MeetupChangedSubject = "events.meetups.meetup_changed";
    private const string MeetupCancelledSubject = "events.meetups.meetup_cancelled";
    private const string MeetupUnpublishedSubject = "events.meetups.meetup_unpublished";
    private const string MaterialAttachedSubject = "events.meetups.meetup_material_attached";

    private const string HeldRelay = "--Notifications:Dispatch:Period=01:00:00";

    /// <summary>
    /// Отмена снимает то, что ещё ждёт релея, и оставляет отправленное
    /// отправленным. Факт самой отмены не снимается: о ней подписчик и должен
    /// узнать.
    /// </summary>
    [Fact]
    public async Task When_CancelledWithPendingFacts_Expect_PendingWithdrawnDispatchedKept()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();

        var meetupId = EventFactory.NewId();
        await Subscribe(db, await Person(db, "member"), meetupId);

        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, HeldRelay);
        var replica = silo.Service<ReplicaTelemetry>();
        var store = silo.Service<NotificationStore>();
        var telemetry = silo.Service<FactTelemetry>();

        // Новая сходка уходит в шину до отмены: её снятие не касается.
        await Apply(nats, replica, MeetupPublishedSubject, EventFactory.Meetup(meetupId, version: 2));
        (await Relay(store)).Published.ShouldBe(["meetup_published"]);

        await Apply(nats, replica, MeetupChangedSubject, Changed(meetupId, version: 3, title: "Пятничная"));
        await Apply(nats, replica, MeetupCancelledSubject, Cancelled(meetupId, version: 4, title: "Пятничная"));

        var rows = await Rows(db);
        rows.Single(row => row.Type == NotificationFacts.MeetupPublishedType).ShouldSatisfyAllConditions(
            row => row.DispatchedAt.ShouldNotBeNull(),
            row => row.WithdrawnAt.ShouldBeNull());

        var changes = rows.Where(row => row.Type == NotificationFacts.MeetupChangedType).ToList();
        changes.Count.ShouldBe(2);
        var withdrawn = changes.Single(row => row.WithdrawnAt is not null);
        withdrawn.WithdrawalReason.ShouldBe(NotificationFacts.WithdrawnOnCancellation);
        withdrawn.DispatchedAt.ShouldBeNull();

        // Следующий проход выносит только отмену.
        var pass = await Relay(store);
        pass.Published.ShouldBe(["meetup_changed"]);
        pass.Facts.Single().MeetupChanged.ChangedAspects.ShouldBe([MeetupAspect.Lifecycle]);

        telemetry.Total("withdrawn").ShouldBe(1);
        (await store.OldestPending(TestContext.Current.CancellationToken)).ShouldBeNull();
    }

    /// <summary>
    /// Служебное сообщение о снятии с публикации отмена не снимает: отмена
    /// скрытой сходки своего факта не даёт, и подписчик остался бы без вести.
    /// </summary>
    [Fact]
    public async Task When_CancelledAfterUnpublication_Expect_UnpublishedFactKept()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();

        var meetupId = EventFactory.NewId();
        await Subscribe(db, await Person(db, "member"), meetupId);

        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, HeldRelay);
        var replica = silo.Service<ReplicaTelemetry>();

        await Apply(nats, replica, MeetupPublishedSubject, EventFactory.Meetup(meetupId, version: 2));

        var unpublished = EventFactory.Meetup(meetupId, version: 3);
        unpublished.State.Visibility = MeetupVisibility.Hidden;
        unpublished.MeetupUnpublished = new Meetups.V1.MeetupUnpublished();
        await Apply(nats, replica, MeetupUnpublishedSubject, unpublished);

        var cancelled = Cancelled(meetupId, version: 4);
        cancelled.State.Visibility = MeetupVisibility.Hidden;
        await Apply(nats, replica, MeetupCancelledSubject, cancelled);

        var rows = await Rows(db);
        rows.Single(row => row.Type == NotificationFacts.MeetupUnpublishedType).WithdrawnAt.ShouldBeNull();
        rows.Single(row => row.Type == NotificationFacts.MeetupPublishedType).WithdrawalReason
            .ShouldBe(NotificationFacts.WithdrawnOnCancellation);
    }

    /// <summary>
    /// Материал, пришедший после отмены — повтор после Nak, доставленный уже
    /// за ней, — факта не даёт: отмена сняла бы его, приди он вовремя, и
    /// исход не должен зависеть от порядка доставки.
    /// </summary>
    [Fact]
    public async Task When_MaterialArrivesAfterCancellation_Expect_NoMaterialFact()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();

        var meetupId = EventFactory.NewId();
        await Subscribe(db, await Person(db, "member"), meetupId);

        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, HeldRelay);
        var replica = silo.Service<ReplicaTelemetry>();

        await Apply(nats, replica, MeetupPublishedSubject, EventFactory.Meetup(meetupId, version: 2));
        await Apply(nats, replica, MeetupCancelledSubject, Cancelled(meetupId, version: 4));

        // Версия материала ниже отмены: реплику он не двигает и применяется
        // как устаревший.
        var stale = replica.Total(ReplicaFeeds.MeetupsSource, "stale");
        await nats.Publish(MaterialAttachedSubject, EventFactory.Material(meetupId, version: 3, EventFactory.NewId(), "Афиша"));
        await Eventually(
            () => Task.FromResult(replica.Total(ReplicaFeeds.MeetupsSource, "stale")),
            count => count == stale + 1);

        (await Rows(db)).ShouldNotContain(row => row.Type == NotificationFacts.MeetupMaterialType);
    }

    /// <summary>
    /// Каждый факт рождается со сроком годности из настройки: колонка для
    /// релея и поле контракта для канала несут один и тот же момент.
    /// </summary>
    [Fact]
    public async Task When_FactProduced_Expect_NotAfterInColumnAndPayload()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();

        await Person(db, "member");

        await using var silo = await SiloUnderTest.StartOnBus(
            db.ConnectionString,
            nats.Url,
            HeldRelay,
            "--Notifications:Facts:StaleAfter=02:00:00");

        await Apply(
            nats,
            silo.Service<ReplicaTelemetry>(),
            MeetupPublishedSubject,
            EventFactory.Meetup(EventFactory.NewId(), version: 2));

        var row = (await Rows(db)).Single();
        (row.NotAfter - row.CreatedAt).ShouldBe(TimeSpan.FromHours(2));

        var payload = Notification.Parser.ParseFrom(row.Payload);
        DateTimeOffset.Parse(payload.NotAfter, System.Globalization.CultureInfo.InvariantCulture)
            .UtcDateTime.ShouldBe(row.NotAfter!.Value, TimeSpan.FromMilliseconds(1));
    }

    /// <summary>
    /// Истёкший факт настоящий релей не публикует, а снимает с причиной: он не
    /// потерян и не застрял, и в стрим уведомлений не попадает ничего.
    /// </summary>
    /// <remarks>
    /// Время двигается конфигурацией: нулевой срок делает факт истёкшим уже
    /// при рождении, и штатный проход релея раз в секунду его встречает.
    /// </remarks>
    [Fact]
    public async Task When_FactExpiredInQueue_Expect_WithdrawnAsExpiredNotPublished()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();

        await Person(db, "member");

        await using var silo = await SiloUnderTest.StartOnBus(
            db.ConnectionString,
            nats.Url,
            "--Notifications:Facts:StaleAfter=00:00:00");
        var telemetry = silo.Service<FactTelemetry>();

        await Apply(
            nats,
            silo.Service<ReplicaTelemetry>(),
            MeetupPublishedSubject,
            EventFactory.Meetup(EventFactory.NewId(), version: 2));
        await Eventually(() => Task.FromResult(telemetry.Total("withdrawn")), count => count == 1);

        var expired = (await Rows(db)).Single();
        expired.WithdrawalReason.ShouldBe(NotificationFacts.WithdrawnExpired);
        expired.DispatchedAt.ShouldBeNull();
        telemetry.Total("dispatched").ShouldBe(0);
        (await nats.PublishedFacts()).ShouldBeEmpty();
        (await silo.Service<NotificationStore>().OldestPending(TestContext.Current.CancellationToken)).ShouldBeNull();
    }

    /// <summary>
    /// Гонка отмены с релеем: строку держит проход релея, и снятие ждёт его
    /// коммита. После коммита вынесенная строка условию снятия уже не отвечает
    /// и остаётся вынесенной — «снят, но отправлен» не возникает.
    /// </summary>
    [Fact]
    public async Task When_RelayHoldsRowDuringCancellation_Expect_RelayWinsAndRowStaysDispatched()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();

        var meetupId = EventFactory.NewId();
        await Subscribe(db, await Person(db, "member"), meetupId);

        await using var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, HeldRelay);
        var replica = silo.Service<ReplicaTelemetry>();

        await Apply(nats, replica, MeetupPublishedSubject, EventFactory.Meetup(meetupId, version: 2));
        var held = (await Rows(db)).Single().NotificationId;

        // Тест играет роль релея: берёт строку так же, как проход, и держит.
        await using var relay = new NpgsqlConnection(db.ConnectionString);
        await relay.OpenAsync(TestContext.Current.CancellationToken);
        await using var pass = await relay.BeginTransactionAsync(TestContext.Current.CancellationToken);
        await relay.ExecuteAsync(
            "SELECT 1 FROM notification WHERE notification_id = @Held FOR UPDATE;",
            new { Held = held },
            pass);

        var applied = replica.Total(ReplicaFeeds.MeetupsSource, "applied");
        await nats.Publish(MeetupCancelledSubject, Cancelled(meetupId, version: 3));
        await Eventually(() => Waiting(db), count => count > 0);

        await relay.ExecuteAsync(
            "UPDATE notification SET dispatched_at = now() WHERE notification_id = @Held;",
            new { Held = held },
            pass);
        await pass.CommitAsync(TestContext.Current.CancellationToken);

        await Eventually(
            () => Task.FromResult(replica.Total(ReplicaFeeds.MeetupsSource, "applied")),
            count => count == applied + 1);

        var row = (await Rows(db)).Single(row => row.NotificationId == held);
        row.DispatchedAt.ShouldNotBeNull();
        row.WithdrawnAt.ShouldBeNull();
    }

    /// <summary>Инварианты снятия держит схема, а не порядок операций в коде.</summary>
    [Fact]
    public async Task When_WithdrawalContradictsRow_Expect_SchemaRejects()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);

        const string insert = """
            INSERT INTO notification (
                notification_id, recipient_id, type, cause_kind, cause_id, payload, created_at,
                dispatched_at, withdrawn_at, withdrawal_reason)
            VALUES (gen_random_uuid(), gen_random_uuid(), 'meetup_changed', 'meetup_event', gen_random_uuid()::text,
                    '\x00', now(), @DispatchedAt, @WithdrawnAt, @Reason);
            """;

        var now = DateTime.UtcNow;

        await Should.ThrowAsync<PostgresException>(() =>
            Execute(db, insert, new { DispatchedAt = (DateTime?)now, WithdrawnAt = (DateTime?)now, Reason = "expired" }));
        await Should.ThrowAsync<PostgresException>(() =>
            Execute(db, insert, new { DispatchedAt = (DateTime?)null, WithdrawnAt = (DateTime?)now, Reason = (string?)null }));
        await Should.ThrowAsync<PostgresException>(() =>
            Execute(db, insert, new { DispatchedAt = (DateTime?)null, WithdrawnAt = (DateTime?)now, Reason = "lost" }));

        await Execute(db, insert, new { DispatchedAt = (DateTime?)null, WithdrawnAt = (DateTime?)now, Reason = "meetup_cancelled" });
    }

    private static MeetupEvent Changed(string meetupId, long version, string title = "Сходка")
    {
        var message = EventFactory.Meetup(meetupId, version, title: title);
        message.MeetupChanged = new Meetups.V1.MeetupChanged();
        return message;
    }

    private static MeetupEvent Cancelled(string meetupId, long version, string title = "Сходка")
    {
        var message = EventFactory.Meetup(meetupId, version, title: title);
        message.State.Lifecycle = MeetupLifecycle.Cancelled;
        message.MeetupCancelled = new Meetups.V1.MeetupCancelled();
        return message;
    }

    // Событие сдвигает реплику, и следующее сравнивается уже с ним, поэтому
    // сценарий ждёт применения, а не только отправки.
    private static async Task Apply(NatsUnderTest nats, ReplicaTelemetry replica, string subject, MeetupEvent message)
    {
        var applied = replica.Total(ReplicaFeeds.MeetupsSource, "applied");
        await nats.Publish(subject, message);
        await Eventually(
            () => Task.FromResult(replica.Total(ReplicaFeeds.MeetupsSource, "applied")),
            count => count == applied + 1);
    }

    private static async Task<RelayPass> Relay(NotificationStore store)
    {
        var facts = new List<Notification>();
        var result = await store.Dispatch(
            100,
            (pending, _) =>
            {
                facts.Add(Notification.Parser.ParseFrom(pending.Payload));
                return Task.CompletedTask;
            },
            DateTimeOffset.UtcNow,
            TestContext.Current.CancellationToken);

        result.Failure.ShouldBeNull();
        return new RelayPass(result, facts);
    }

    // Снятие при отмене, которое ждёт блокировку строки: так тест узнаёт, что
    // оно упёрлось в строку, удержанную «релеем», а не в чужое ожидание.
    private static async Task<long> Waiting(IsolatedDatabase db)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        return await connection.ExecuteScalarAsync<long>(
            """
            SELECT count(*) FROM pg_stat_activity
            WHERE datname = current_database()
                AND wait_event_type = 'Lock'
                AND query LIKE '%withdrawal_reason%meetup_id%';
            """);
    }

    private static async Task<IReadOnlyList<NotificationRow>> Rows(IsolatedDatabase db)
    {
        await using var connection = new NpgsqlConnection(db.ConnectionString);
        return (await connection.QueryAsync<NotificationRow>(
            """
            SELECT notification_id AS NotificationId, type AS Type, payload AS Payload, created_at AS CreatedAt,
                   not_after AS NotAfter, dispatched_at AS DispatchedAt, withdrawn_at AS WithdrawnAt,
                   withdrawal_reason AS WithdrawalReason
            FROM notification
            ORDER BY created_at, type;
            """)).ToList();
    }

    private sealed record RelayPass(DispatchPass Result, IReadOnlyList<Notification> Facts)
    {
        public IReadOnlyList<string> Published => Facts.Select(fact => fact.TypeCase switch
        {
            Notification.TypeOneofCase.MeetupPublished => NotificationFacts.MeetupPublishedType,
            Notification.TypeOneofCase.MeetupChanged => NotificationFacts.MeetupChangedType,
            _ => fact.TypeCase.ToString(),
        }).ToList();
    }

    private sealed class NotificationRow
    {
        public Guid NotificationId { get; init; }

        public string Type { get; init; } = "";

        public byte[] Payload { get; init; } = [];

        public DateTime CreatedAt { get; init; }

        public DateTime? NotAfter { get; init; }

        public DateTime? DispatchedAt { get; init; }

        public DateTime? WithdrawnAt { get; init; }

        public string? WithdrawalReason { get; init; }
    }
}
