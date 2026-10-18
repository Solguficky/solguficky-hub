using Dapper;
using Notifications.Auction;
using Notifications.Facts;
using Notifications.Favorites;
using Notifications.Grains;
using Notifications.Infrastructure;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.Reminders;
using Notifications.TestKit;
using Notifications.V1;
using Npgsql;
using Shouldly;
using Xunit;
using static Notifications.IntegrationTests.Infrastructure.FactFixtures;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Напоминание о дедлайне избранного лота (PER-496, ADR-063) от события Auction
/// до адресного факта в стриме уведомлений: реплика даёт дедлайн, грин ведёт
/// задание, срабатывание разворачивает его на следящих.
/// </summary>
/// <remarks>
/// Время двигается данными, как у напоминания о сходке: дедлайн ставится
/// относительно настоящих часов, а упреждение и период прохода — настройкой.
/// Сценариев немного намеренно: каждый поднимает свою базу, шину и силос, а
/// общий на прогон контейнер PostgreSQL близок к пределу соединений.
/// </remarks>
public class LotReminderTests
{
    private const string OpenedSubject = "events.auction.lot_opened";
    private const string ExtendedSubject = "events.auction.deadline_extended";
    private const string HeldSubject = "events.auction.lot_held_for_final";
    private const string UnsoldSubject = "events.auction.lot_unsold";

    /// <summary>Упреждение, при котором напоминание по лоту через два часа ещё не наступило.</summary>
    private static readonly string[] Waiting = ["--Notifications:LotReminders:Lead=01:00:00"];

    /// <summary>Проход sweeper'а раз в секунду: им движется наступившее задание.</summary>
    private static readonly string[] Sweeping =
        ["--Notifications:LotReminders:Lead=01:00:00", "--Notifications:Reminders:SweepPeriod=00:00:01"];

    /// <summary>
    /// Жизненный цикл одного лота: перенос дедлайна замещает задание, удержание
    /// для финала снимает, а фактов до срабатывания нет. Заодно проверяется, что
    /// задание, отставшее от реплики между чтением и захватом, не остаётся
    /// сработавшим: иначе напоминание по новому дедлайну не пришло бы никогда.
    /// </summary>
    [Fact]
    public async Task When_DeadlineMovedAndLotHeldForFinal_Expect_TaskFollowsReplica()
    {
        await using var env = await BusScenario.Start(Waiting);

        await env.Publish(OpenedSubject, env.Trading("lot_opened", version: 2));
        var live = await Eventually(() => Task.FromResult(env.Live()), task => task is not null);
        live!.DueAt.ShouldBe(env.Deadline.UtcDateTime.AddHours(-1), TimeSpan.FromSeconds(2));

        var extended = env.Deadline.AddMinutes(30);
        await env.Publish(ExtendedSubject, env.Trading("deadline_extended", version: 4, deadline: extended));
        var moved = await Eventually(
            () => Task.FromResult(env.Live()),
            task => task is not null && task.TaskId != live.TaskId);
        moved!.Deadline.ShouldBe(extended.UtcDateTime, TimeSpan.FromSeconds(2));
        env.Tasks().Single(task => task.TaskId == live.TaskId).State.ShouldBe("superseded");

        // Реплика уходит вперёд ровно в щель между чтением задания и захватом.
        await Execute(env.Db,
            "UPDATE lot_replica SET deadline = deadline + interval '10 minutes' WHERE lot_id = @Lot;",
            new { Lot = Guid.Parse(env.LotId) });
        var store = env.TaskStore();
        var stale = await store.Fire(
            (await store.Live(Guid.Parse(env.LotId), TestContext.Current.CancellationToken))!,
            Guid.Parse(env.LotId),
            DateTimeOffset.UtcNow,
            TestContext.Current.CancellationToken);
        stale.Outcome.ShouldBe(LotFireOutcome.Stale);
        env.Tasks().Single(task => task.TaskId == moved.TaskId).State.ShouldBe("scheduled");

        await env.Publish(HeldSubject, EventFactory.HeldForFinal(env.LotId, version: 5));

        await Eventually(() => Task.FromResult(env.Live()), task => task is null);
        env.Tasks().Single(task => task.TaskId == moved.TaskId).State.ShouldBe("cancelled");
        (await env.Facts(NotificationFacts.LotReminderType)).ShouldBe(0);
    }

    [Fact]
    public async Task When_LotClosed_Expect_TaskCancelled()
    {
        await using var env = await BusScenario.Start(Waiting);

        await env.Publish(OpenedSubject, env.Trading("lot_opened", version: 2));
        var live = await Eventually(() => Task.FromResult(env.Live()), task => task is not null);

        await env.Publish(UnsoldSubject, EventFactory.Unsold(env.LotId, version: 7));

        await Eventually(() => Task.FromResult(env.Live()), task => task is null);
        env.Tasks().Single(task => task.TaskId == live!.TaskId).State.ShouldBe("cancelled");
    }

    /// <summary>
    /// Дедлайн по реплике уже прошёл: задание срабатывает без фактов, а не шлёт
    /// «остался час» по закрывающемуся лоту.
    /// </summary>
    [Fact]
    public async Task When_ReplicaDeadlineAlreadyPassed_Expect_NoReminder()
    {
        await using var env = await BusScenario.Start(Waiting);
        var follower = await Person(env.Db, MemberHolding);
        var past = DateTimeOffset.UtcNow.AddMinutes(-1);

        await env.Publish(OpenedSubject, env.Trading("lot_opened", version: 2, deadline: past));
        await env.Favorites().Follow(follower, Guid.Parse(env.LotId), TestContext.Current.CancellationToken);

        await Eventually(() => Task.FromResult(env.Live()), task => task is null);
        (await env.Facts(NotificationFacts.LotReminderType)).ShouldBe(0);
    }

    /// <summary>
    /// Пропущенный за время простоя тик подбирает sweeper и доставляет по факту
    /// каждому следящему, кто не лидер и не заблокирован; снятая отметка факта
    /// не даёт, а продление после срабатывания второго задания не рождает.
    /// </summary>
    [Fact]
    public async Task When_SweeperFires_Expect_OneReminderPerFollowerAndNoRepeatOnExtension()
    {
        await using var env = await BusScenario.Start(Sweeping);
        var lot = Guid.Parse(env.LotId);
        var leader = await Person(env.Db, MemberHolding);
        var follower = await Person(env.Db, MemberHolding);
        var guest = await Person(env.Db, GuestHolding);
        var blocked = await Person(env.Db, blocked: true, MemberHolding);
        var unfollowed = await Person(env.Db, MemberHolding);

        await env.Publish(OpenedSubject, env.Trading("lot_opened", version: 2, leader: leader.ToString()));

        foreach (var person in new[] { follower, leader, guest, blocked, unfollowed })
        {
            await env.Favorites().Follow(person, lot, TestContext.Current.CancellationToken);
        }
        await env.Favorites().Unfollow(unfollowed, lot, TestContext.Current.CancellationToken);

        // Простоя не изображаем вызовом грина: момент сдвигается данными, а
        // напоминание достаёт sweeper — путь «кластер лежал» целиком.
        LotReminderProbe.MoveDueToPast(env.Db.ConnectionString, lot);

        var rows = await Eventually(() => env.Reminders(), facts => facts.Count == 2);
        rows.Select(row => row.RecipientId).ShouldBe(
            [follower.ToString(), guest.ToString()], ignoreOrder: true);

        var task = env.Tasks().ShouldHaveSingleItem();
        task.State.ShouldBe("fired");
        foreach (var row in rows)
        {
            row.Cause.ReminderTaskId.ShouldBe(task.TaskId.ToString());
            row.LotReminder.LotId.ShouldBe(env.LotId);
            row.HasRequestId.ShouldBeFalse();
        }

        // Круг решает бот доставки: участнику — хаб, гостю — аукцион (ADR-064).
        (await env.Surfaces()).ShouldBe(
            new Dictionary<string, string> { [follower.ToString()] = "hub", [guest.ToString()] = "auction" });

        (await env.Grain.FireDue()).ShouldBeFalse();
        (await env.Facts(NotificationFacts.LotReminderType)).ShouldBe(2);

        // Анти-снайп продлевает дедлайн в последние минуты: сработавшее задание
        // продлением не пересоздаётся (ADR-063, п.4).
        await env.Publish(ExtendedSubject, env.Trading("deadline_extended", version: 4, deadline: env.Deadline.AddMinutes(5)));

        env.Tasks().ShouldHaveSingleItem().State.ShouldBe("fired");
        (await env.Facts(NotificationFacts.LotReminderType)).ShouldBe(2);
    }

    /// <summary>База, шина и силос одного лота. Люди, отметки и реплика — через настоящее событие.</summary>
    private sealed class BusScenario : IAsyncDisposable
    {
        private readonly NatsUnderTest nats;
        private readonly SiloUnderTest silo;
        private readonly NpgsqlDataSource source;

        private BusScenario(IsolatedDatabase db, NpgsqlDataSource source, NatsUnderTest nats, SiloUnderTest silo)
        {
            Db = db;
            this.source = source;
            this.nats = nats;
            this.silo = silo;
        }

        public IsolatedDatabase Db { get; }

        public string LotId { get; } = EventFactory.NewId();

        /// <summary>Дедлайн лота — через два часа от настоящих часов.</summary>
        public DateTimeOffset Deadline { get; } = DateTimeOffset.UtcNow.AddHours(2);

        public ILotNotificationGrain Grain => silo.Grains.GetGrain<ILotNotificationGrain>(LotId);

        public static async Task<BusScenario> Start(string[] settings)
        {
            var db = new IsolatedDatabase();
            NpgsqlDataSource? source = null;
            NatsUnderTest? nats = null;

            try
            {
                Migrations.Apply(db.ConnectionString);
                source = NpgsqlDataSource.Create(db.ConnectionString);
                nats = await NatsUnderTest.Start();
                var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, settings);

                return new BusScenario(db, source, nats, silo);
            }
            catch
            {
                if (source is not null)
                {
                    await source.DisposeAsync();
                }
                if (nats is not null)
                {
                    await nats.DisposeAsync();
                }

                db.Dispose();
                throw;
            }
        }

        public global::Auction.V1.LotEvent Trading(
            string occasion,
            long version,
            string? leader = null,
            DateTimeOffset? deadline = null) =>
            EventFactory.Trading(LotId, occasion, version, Iso(deadline ?? Deadline), leader);

        /// <summary>Публикует событие и ждёт, пока потребитель его разберёт и позовёт грин.</summary>
        public async Task Publish(string subject, global::Auction.V1.LotEvent message, string? messageId = null)
        {
            var before = Auction.Total("lot_replicated");
            await nats.Publish(subject, message, messageId);
            await Eventually(() => Task.FromResult(Auction.Total("lot_replicated")), count => count > before);
        }

        public IReadOnlyList<LotReminderTaskRow> Tasks() => LotReminderProbe.Tasks(Db.ConnectionString, Guid.Parse(LotId));

        public LotReminderTaskRow? Live() => LotReminderProbe.Live(Db.ConnectionString, Guid.Parse(LotId));

        public FavoriteOperations Favorites() => new(source, TimeProvider.System);

        public LotReminderTaskStore TaskStore() => new(source, new LotReminderTelemetry());

        public async Task<IReadOnlyList<Notification>> Reminders() =>
            (await nats.PublishedFacts())
                .Select(fact => fact.Fact)
                .Where(fact => fact.TypeCase == Notification.TypeOneofCase.LotReminder)
                .ToArray();

        public async Task<long> Facts(string type)
        {
            await using var connection = new NpgsqlConnection(Db.ConnectionString);
            return await connection.ExecuteScalarAsync<long>(
                "SELECT count(*) FROM notification WHERE type = @Type;",
                new { Type = type });
        }

        public async Task<IReadOnlyDictionary<string, string>> Surfaces()
        {
            await using var connection = new NpgsqlConnection(Db.ConnectionString);
            var rows = await connection.QueryAsync<SurfaceRow>(
                "SELECT recipient_id::text AS RecipientId, delivery_surface AS DeliverySurface FROM notification WHERE type = 'lot_reminder';");
            return rows.ToDictionary(row => row.RecipientId, row => row.DeliverySurface);
        }

        private AuctionTelemetry Auction => silo.Service<AuctionTelemetry>();

        private static string Iso(DateTimeOffset moment) => moment.ToUniversalTime().ToString("O");

        public async ValueTask DisposeAsync()
        {
            await silo.DisposeAsync();
            await nats.DisposeAsync();
            await source.DisposeAsync();
            Db.Dispose();
        }

        private sealed record SurfaceRow(string RecipientId, string DeliverySurface);
    }
}
