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
        var live = await Eventually(() => Task.FromResult(env.Live(LotReminderProbe.Hour)), task => task is not null);
        live!.DueAt.ShouldBe(env.Deadline.UtcDateTime.AddHours(-1), TimeSpan.FromSeconds(2));

        var extended = env.Deadline.AddMinutes(30);
        await env.Publish(ExtendedSubject, env.Trading("deadline_extended", version: 4, deadline: extended));
        var moved = await Eventually(
            () => Task.FromResult(env.Live(LotReminderProbe.Hour)),
            task => task is not null && task.TaskId != live.TaskId);
        moved!.Deadline.ShouldBe(extended.UtcDateTime, TimeSpan.FromSeconds(2));
        env.Tasks().Single(task => task.TaskId == live.TaskId).State.ShouldBe("superseded");

        // Реплика уходит вперёд ровно в щель между чтением задания и захватом.
        await Execute(env.Db,
            "UPDATE lot_replica SET deadline = deadline + interval '10 minutes' WHERE lot_id = @Lot;",
            new { Lot = Guid.Parse(env.LotId) });
        var store = env.TaskStore();
        var stale = await store.Fire(
            (await store.Live(Guid.Parse(env.LotId), LotReminderKind.Hour, TestContext.Current.CancellationToken))!,
            Guid.Parse(env.LotId),
            DateTimeOffset.UtcNow,
            TestContext.Current.CancellationToken);
        stale.Outcome.ShouldBe(LotFireOutcome.Stale);
        env.Tasks().Single(task => task.TaskId == moved.TaskId).State.ShouldBe("scheduled");

        await env.Publish(HeldSubject, EventFactory.HeldForFinal(env.LotId, version: 5));

        await Eventually(() => Task.FromResult(env.Live(LotReminderProbe.Hour)), task => task is null);
        env.Tasks().Single(task => task.TaskId == moved.TaskId).State.ShouldBe("cancelled");
        (await env.Facts(NotificationFacts.LotReminderType)).ShouldBe(0);
    }

    [Fact]
    public async Task When_LotClosed_Expect_TaskCancelled()
    {
        await using var env = await BusScenario.Start(Waiting);

        await env.Publish(OpenedSubject, env.Trading("lot_opened", version: 2));
        var live = await Eventually(() => Task.FromResult(env.Live(LotReminderProbe.Hour)), task => task is not null);

        await env.Publish(UnsoldSubject, EventFactory.Unsold(env.LotId, version: 7));

        await Eventually(() => Task.FromResult(env.Live(LotReminderProbe.Hour)), task => task is null);
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

        await Eventually(() => Task.FromResult(env.Live(LotReminderProbe.Hour)), task => task is null);
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

        // Отметка за два часа до дедлайна напоминания сразу не даёт: оно придёт
        // в момент срабатывания, как раньше (PER-647).
        (await env.Facts(NotificationFacts.LotReminderType)).ShouldBe(0);

        // Простоя не изображаем вызовом грина: момент сдвигается данными, а
        // напоминание достаёт sweeper — путь «кластер лежал» целиком.
        LotReminderProbe.MoveDueToPast(env.Db.ConnectionString, lot, LotReminderProbe.Hour);

        var rows = await Eventually(() => env.Reminders(), facts => facts.Count == 2);
        rows.Select(row => row.RecipientId).ShouldBe(
            [follower.ToString(), guest.ToString()], ignoreOrder: true);

        var task = env.TasksOf(LotReminderProbe.Hour).ShouldHaveSingleItem();
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

        env.TasksOf(LotReminderProbe.Hour).ShouldHaveSingleItem().State.ShouldBe("fired");
        (await env.Facts(NotificationFacts.LotReminderType)).ShouldBe(2);
    }

    /// <summary>
    /// Отметка позже срабатывания получает напоминание сразу, той же командой
    /// (PER-647): лот открыт за полчаса до дедлайна, задание сработало в пустоту.
    /// Снятие с возвратом второго напоминания не даёт, лидер и заблокированный
    /// его не получают, а продление после срабатывания становится сроком факта.
    /// </summary>
    /// <remarks>
    /// Повод поздней отметки — ближний момент (ADR-063, дополнение
    /// 2026-10-20): его задание и его срабатывание несут один ключ, поэтому
    /// человек получает одно сообщение, а не два.
    /// </remarks>
    [Fact]
    public async Task When_FollowedAfterReminderFired_Expect_OneReminderAtOnce()
    {
        await using var env = await BusScenario.Start(Waiting);
        var lot = Guid.Parse(env.LotId);
        var token = TestContext.Current.CancellationToken;
        var leader = await Person(env.Db, MemberHolding);
        var late = await Person(env.Db, MemberHolding);
        var blocked = await Person(env.Db, blocked: true, MemberHolding);
        var afterExtension = await Person(env.Db, MemberHolding);

        await env.Publish(OpenedSubject, env.Trading(
            "lot_opened", version: 2, leader: leader.ToString(), deadline: DateTimeOffset.UtcNow.AddMinutes(30)));
        await Eventually(
            () => Task.FromResult(env.TasksOf(LotReminderProbe.Hour).SingleOrDefault()), row => row?.State == "fired");
        (await env.Facts(NotificationFacts.LotReminderType)).ShouldBe(0);

        await env.Favorites().Follow(late, lot, token);

        (await env.Recipients(NotificationFacts.LotDeadlineCloseType)).ShouldBe([late]);

        await env.Favorites().Unfollow(late, lot, token);
        await env.Favorites().Follow(late, lot, token);
        await env.Favorites().Follow(late, lot, token);
        await env.Favorites().Follow(leader, lot, token);
        await env.Favorites().Follow(blocked, lot, token);

        (await env.Recipients(NotificationFacts.LotDeadlineCloseType)).ShouldBe([late]);

        var extended = DateTimeOffset.UtcNow.AddMinutes(35);
        await env.Publish(ExtendedSubject, env.Trading(
            "deadline_extended", version: 4, leader: leader.ToString(), deadline: extended));
        await env.Favorites().Follow(afterExtension, lot, token);

        (await env.Recipients(NotificationFacts.LotDeadlineCloseType)).ShouldBe(
            [late, afterExtension], ignoreOrder: true);
        env.TasksOf(LotReminderProbe.Hour).ShouldHaveSingleItem().State.ShouldBe("fired");

        // Поздняя отметка и ближний момент не дают человеку двух сообщений: у
        // обоих по одному, и сроком факта стал текущий дедлайн.
        var rows = await Eventually(() => env.CloseReminders(), facts => facts.Count == 2);
        rows.Count(row => row.RecipientId == late.ToString()).ShouldBe(1);
        rows.Count(row => row.RecipientId == afterExtension.ToString()).ShouldBe(1);
        var notAfter = rows.Single(row => row.RecipientId == afterExtension.ToString()).NotAfter;
        DateTimeOffset.Parse(notAfter).ShouldBe(extended, TimeSpan.FromMilliseconds(1));
    }

    /// <summary>
    /// Второй момент напоминания (ADR-063, дополнение 2026-10-20): ближе к
    /// дедлайну приходит свой факт, а часовое сработавшее задание при этом не
    /// пересоздаётся.
    /// </summary>
    [Fact]
    public async Task When_CloseMomentComes_Expect_CloseReminder()
    {
        await using var env = await BusScenario.Start(Sweeping);
        var lot = Guid.Parse(env.LotId);
        var follower = await Person(env.Db, MemberHolding);

        await env.Publish(OpenedSubject, env.Trading("lot_opened", version: 2));
        await env.Favorites().Follow(follower, lot, TestContext.Current.CancellationToken);

        // Часовое напоминание срабатывает первым.
        LotReminderProbe.MoveDueToPast(env.Db.ConnectionString, lot, LotReminderProbe.Hour);
        await Eventually(() => env.Reminders(), facts => facts.Count == 1);
        (await env.Facts(NotificationFacts.LotReminderType)).ShouldBe(1);

        // Ближний момент приходит вторым и говорит своим типом: два момента не
        // должны совпасть на одном ключе повода.
        LotReminderProbe.MoveDueToPast(env.Db.ConnectionString, lot, LotReminderProbe.Close);
        await Eventually(() => env.CloseReminders(), facts => facts.Count == 1);
        (await env.Facts(NotificationFacts.LotDeadlineCloseType)).ShouldBe(1);
        env.TasksOf(LotReminderProbe.Close).ShouldHaveSingleItem().State.ShouldBe("fired");
    }

    /// <summary>
    /// Отметка, заставшая срабатывание посреди его транзакции, ждёт её коммита
    /// и догоняет напоминание, а не теряет его между чтением следящих и
    /// записью «сработало». Захват срабатывания изображает открытая транзакция.
    /// </summary>
    [Fact]
    public async Task When_FollowMeetsFiringInFlight_Expect_ReminderAfterFiringCommits()
    {
        await using var env = await BusScenario.Start(Waiting);
        var lot = Guid.Parse(env.LotId);
        var token = TestContext.Current.CancellationToken;
        var follower = await Person(env.Db, MemberHolding);

        await env.Publish(OpenedSubject, env.Trading("lot_opened", version: 2));
        var live = await Eventually(() => Task.FromResult(env.Live(LotReminderProbe.Hour)), task => task is not null);

        await using var firing = new NpgsqlConnection(env.Db.ConnectionString);
        await firing.OpenAsync(token);
        await using var claim = await firing.BeginTransactionAsync(token);
        await firing.ExecuteAsync(
            "UPDATE lot_reminder_task SET state = 'fired', fired_at = now() WHERE task_id = @TaskId;",
            new { live!.TaskId },
            claim);

        var follow = env.Favorites().Follow(follower, lot, token);

        await Task.Delay(TimeSpan.FromMilliseconds(500), token);
        follow.IsCompleted.ShouldBeFalse();

        await claim.CommitAsync(token);
        await follow;

        (await env.Recipients(NotificationFacts.LotDeadlineCloseType)).ShouldBe([follower]);
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

        public LotReminderTaskRow? Live(string kind) => LotReminderProbe.Live(Db.ConnectionString, Guid.Parse(LotId), kind);

        public IReadOnlyList<LotReminderTaskRow> TasksOf(string kind) =>
            Tasks().Where(task => task.Kind == kind).ToArray();

        public FavoriteOperations Favorites() => new(source, TimeProvider.System, new FactTelemetry());

        public LotReminderTaskStore TaskStore() => new(source, new LotReminderTelemetry());

        public async Task<IReadOnlyList<Notification>> Reminders() =>
            (await nats.PublishedFacts())
                .Select(fact => fact.Fact)
                .Where(fact => fact.TypeCase == Notification.TypeOneofCase.LotReminder)
                .ToArray();

        public async Task<IReadOnlyList<Notification>> CloseReminders() =>
            (await nats.PublishedFacts())
                .Select(fact => fact.Fact)
                .Where(fact => fact.TypeCase == Notification.TypeOneofCase.LotDeadlineClose)
                .ToArray();

        public async Task<long> Facts(string type)
        {
            await using var connection = new NpgsqlConnection(Db.ConnectionString);
            return await connection.ExecuteScalarAsync<long>(
                "SELECT count(*) FROM notification WHERE type = @Type;",
                new { Type = type });
        }

        public async Task<IReadOnlyList<Guid>> Recipients(string type = "lot_reminder")
        {
            await using var connection = new NpgsqlConnection(Db.ConnectionString);
            return (await connection.QueryAsync<Guid>(
                "SELECT recipient_id FROM notification WHERE type = @Type ORDER BY created_at;",
                new { Type = type })).ToArray();
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
