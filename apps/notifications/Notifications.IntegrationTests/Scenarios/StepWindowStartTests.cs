using System.Globalization;
using Dapper;
using Notifications.Auction;
using Notifications.Facts;
using Notifications.Favorites;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.TestKit;
using Notifications.V1;
using Npgsql;
using Shouldly;
using Xunit;
using static Notifications.IntegrationTests.Infrastructure.FactFixtures;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Сообщение о начале окна сниженного шага (PER-614, ADR-047, дополнение
/// 2026-10-12) от факта Auction до адресного факта в стриме уведомлений: реплика
/// держит окна, задание ждёт выдержку, срабатывание сверяет реплику и отмену
/// аукциона.
/// </summary>
/// <remarks>
/// Время двигается данными, как у остальных напоминаний: начало и конец окна
/// считаются от настоящих часов, выдержка и период прохода — настройкой.
/// Сценариев немного намеренно: каждый поднимает свою базу, шину и силос.
/// </remarks>
public class StepWindowStartTests
{
    private const string OpenedSubject = "events.auction.lot_opened";
    private const string StepWindowSubject = "events.auction.step_window_added";
    private const string ExtendedSubject = "events.auction.deadline_extended";
    private const string UnsoldSubject = "events.auction.lot_unsold";
    private const string CancelledSubject = "events.auction.auction_cancelled";

    /// <summary>Выдержка три секунды и проход sweeper'а раз в секунду.</summary>
    private static readonly string[] Quick =
        ["--Notifications:StepWindows:Hold=00:00:03", "--Notifications:Reminders:SweepPeriod=00:00:01"];

    /// <summary>Выдержка пять секунд: окно успевает кончиться до срабатывания.</summary>
    private static readonly string[] Slow =
        ["--Notifications:StepWindows:Hold=00:00:05", "--Notifications:Reminders:SweepPeriod=00:00:01"];

    /// <summary>
    /// Два отмеченных лота одного окна дают человеку одно сообщение с обоими
    /// лотами, каждый со своим шагом и концом; заблокированный не получает
    /// ничего, хотя отметку поставил.
    /// </summary>
    [Fact]
    public async Task When_TwoFollowedLotsOfOneWindow_Expect_OneMessageWithBothLots()
    {
        await using var env = await WindowScenario.Start(Quick);
        var token = TestContext.Current.CancellationToken;
        var follower = await Person(env.Db, MemberHolding);
        var blocked = await Person(env.Db, blocked: true, MemberHolding);

        var from = env.Clock.AddMinutes(-1);
        var firstUntil = env.Clock.AddMinutes(30);
        var secondUntil = env.Clock.AddMinutes(40);

        await env.PublishLot(OpenedSubject,
            env.Trading(env.FirstLot, "lot_opened", 2, env.Window(from, firstUntil, step: 50)));
        await env.PublishLot(StepWindowSubject,
            env.Trading(env.SecondLot, "step_window_added", 2, env.Window(from, secondUntil, step: 150)));

        await env.Favorites().Follow(follower, Guid.Parse(env.FirstLot), token);
        await env.Favorites().Follow(follower, Guid.Parse(env.SecondLot), token);
        await env.Favorites().Follow(blocked, Guid.Parse(env.FirstLot), token);

        var facts = await Eventually(() => env.Facts(), facts => facts.Count == 1);
        var fact = facts.ShouldHaveSingleItem();

        fact.RecipientId.ShouldBe(follower.ToString());
        fact.StepWindowStarted.AuctionId.ShouldBe(env.AuctionId);
        // Моменты проходят через timestamptz и jsonb реплики: сравниваются с
        // точностью хранения, а не по строке.
        DateTimeOffset.Parse(fact.StepWindowStarted.StartsAt).ShouldBe(from, TimeSpan.FromMilliseconds(1));
        fact.StepWindowStarted.Lots.Count.ShouldBe(2);
        fact.StepWindowStarted.Lots.Select(lot => lot.LotId).ShouldBe(
            [env.FirstLot, env.SecondLot], ignoreOrder: true);
        fact.StepWindowStarted.Lots.Single(lot => lot.LotId == env.FirstLot).Step.MinorUnits.ShouldBe(50);
        DateTimeOffset.Parse(fact.StepWindowStarted.Lots.Single(lot => lot.LotId == env.FirstLot).Until)
            .ShouldBe(firstUntil, TimeSpan.FromMilliseconds(1));
        fact.StepWindowStarted.Lots.Single(lot => lot.LotId == env.SecondLot).Step.MinorUnits.ShouldBe(150);
        DateTimeOffset.Parse(fact.StepWindowStarted.Lots.Single(lot => lot.LotId == env.SecondLot).Until)
            .ShouldBe(secondUntil, TimeSpan.FromMilliseconds(1));

        // Задание одно на аукцион и начало: оба факта лотов дали одну строку.
        var task = env.Tasks().ShouldHaveSingleItem();
        task.State.ShouldBe("fired");
        fact.Cause.ReminderTaskId.ShouldBe(task.TaskId.ToString());
    }

    /// <summary>
    /// Окно, кончившееся до срабатывания, и лот, вышедший из торгов, сообщения
    /// не дают; лот без отметки — тоже. Задание при этом срабатывает: повторять
    /// его нечего.
    /// </summary>
    [Fact]
    public async Task When_WindowEndedOrLotClosedOrNoFollower_Expect_NoMessage()
    {
        await using var env = await WindowScenario.Start(Slow);
        var token = TestContext.Current.CancellationToken;
        var follower = await Person(env.Db, MemberHolding);
        var closedFollower = await Person(env.Db, MemberHolding);
        var nobodyFollows = EventFactory.NewId();

        var from = env.Clock.AddMinutes(-5);
        var endedUntil = env.Clock.AddSeconds(1);
        var liveUntil = env.Clock.AddMinutes(30);

        // Окно кончается раньше выдержки: к срабатыванию объявлять нечего.
        await env.PublishLot(OpenedSubject,
            env.Trading(env.FirstLot, "lot_opened", 2, env.Window(from, endedUntil, step: 50)));
        // Лот с живым окном, но он выходит из торгов до срабатывания.
        await env.PublishLot(StepWindowSubject,
            env.Trading(env.SecondLot, "step_window_added", 2, env.Window(from, liveUntil, step: 150)));
        await env.PublishLot(UnsoldSubject, EventFactory.Unsold(env.SecondLot, version: 7, auction: env.AuctionId));
        // Лот с живым окном, за которым никто не следит.
        await env.PublishLot(StepWindowSubject,
            env.Trading(nobodyFollows, "step_window_added", 2, env.Window(from, liveUntil, step: 50)));

        await env.Favorites().Follow(follower, Guid.Parse(env.FirstLot), token);
        await env.Favorites().Follow(closedFollower, Guid.Parse(env.SecondLot), token);

        var task = await Eventually(
            () => Task.FromResult(env.Tasks()),
            tasks => tasks.Count == 1 && tasks[0].State == "fired");
        task.ShouldHaveSingleItem();
        (await env.Facts()).ShouldBeEmpty();
    }

    /// <summary>
    /// Поздний факт лота и повтор факта после срабатывания второго сообщения не
    /// дают; отмена аукциона снимает его несработавшие задания.
    /// </summary>
    [Fact]
    public async Task When_Fired_Expect_LateFactRepeatAndCancellationGiveNoSecondMessage()
    {
        await using var env = await WindowScenario.Start(Quick);
        var token = TestContext.Current.CancellationToken;
        var follower = await Person(env.Db, MemberHolding);

        var from = env.Clock.AddMinutes(-1);
        var until = env.Clock.AddMinutes(30);

        // Второй лот известен реплике без окна: человек успевает его отметить.
        await env.PublishLot(OpenedSubject,
            env.Trading(env.FirstLot, "lot_opened", 2, env.Window(from, until, step: 50)));
        await env.PublishLot(OpenedSubject, env.Trading(env.SecondLot, "lot_opened", 2));
        await env.Favorites().Follow(follower, Guid.Parse(env.FirstLot), token);
        await env.Favorites().Follow(follower, Guid.Parse(env.SecondLot), token);

        var facts = await Eventually(() => env.Facts(), facts => facts.Count == 1);
        facts.ShouldHaveSingleItem().StepWindowStarted.Lots.ShouldHaveSingleItem()
            .LotId.ShouldBe(env.FirstLot);

        // Поздний факт лота: окно того же начала приходит после срабатывания.
        await env.PublishLot(StepWindowSubject,
            env.Trading(env.SecondLot, "step_window_added", 3, env.Window(from, until, step: 150)));
        await Eventually(() => env.ReplicaVersion(env.SecondLot), version => version == 3);
        (await env.Facts()).Count.ShouldBe(1);

        // Повтор того же окна другим фактом: задание одно на аукцион и начало.
        await env.PublishLot(ExtendedSubject,
            env.Trading(env.FirstLot, "deadline_extended", 3, env.Window(from, until, step: 50)));
        await Eventually(() => env.ReplicaVersion(env.FirstLot), version => version == 3);
        (await env.Facts()).Count.ShouldBe(1);
        env.Tasks().ShouldHaveSingleItem().State.ShouldBe("fired");

        // Отмена аукциона снимает несработавшее задание окна из будущего: оно
        // уже не сработает, и сообщения о нём не будет.
        var future = env.Clock.AddHours(1);
        var laterLot = EventFactory.NewId();
        await env.PublishLot(StepWindowSubject,
            env.Trading(laterLot, "step_window_added", 2, env.Window(future, future.AddMinutes(30), step: 50)));
        await Eventually(() => Task.FromResult(env.Scheduled()), count => count == 1);

        await env.PublishAuction(CancelledSubject,
            EventFactory.AuctionCancelled(env.AuctionId, EventFactory.NewId(), env.FirstLot, env.SecondLot, laterLot));

        await Eventually(() => Task.FromResult(env.Scheduled()), count => count == 0);
        (await env.Facts()).Count.ShouldBe(1);
    }

    /// <summary>
    /// База, шина и силос одного аукциона. Люди, отметки и реплика — через
    /// настоящее событие шины, как у напоминания о лоте.
    /// </summary>
    private sealed class WindowScenario : IAsyncDisposable
    {
        private readonly NatsUnderTest nats;
        private readonly SiloUnderTest silo;
        private readonly NpgsqlDataSource source;

        private WindowScenario(IsolatedDatabase db, NpgsqlDataSource source, NatsUnderTest nats, SiloUnderTest silo)
        {
            Db = db;
            this.source = source;
            this.nats = nats;
            this.silo = silo;
        }

        public IsolatedDatabase Db { get; }

        /// <summary>Аукцион сходки: UUIDv5, как его выводит Auction.</summary>
        public string AuctionId { get; } = EventFactory.AuctionOfMeetup();

        public string FirstLot { get; } = EventFactory.NewId();

        public string SecondLot { get; } = EventFactory.NewId();

        public DateTimeOffset Clock => DateTimeOffset.UtcNow;

        public static async Task<WindowScenario> Start(string[] settings)
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

                return new WindowScenario(db, source, nats, silo);
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

        /// <summary>Окно лота в форме контракта: начало, конец и шаг в рублях.</summary>
        public (string From, string Until, long Step) Window(DateTimeOffset from, DateTimeOffset until, long step) =>
            (Iso(from), Iso(until), step);

        public global::Auction.V1.LotEvent Trading(string lot, string occasion, long version,
            params (string From, string Until, long Step)[] windows) =>
            EventFactory.Trading(lot, occasion, version, auction: AuctionId, windows: windows);

        /// <summary>Публикует факт лота и ждёт, пока потребитель его разберёт и позовёт грин.</summary>
        public async Task PublishLot(string subject, global::Auction.V1.LotEvent message)
        {
            var before = Auction.Total("lot_replicated");
            await nats.Publish(subject, message);
            await Eventually(() => Task.FromResult(Auction.Total("lot_replicated")), count => count > before);
        }

        public Task PublishAuction(string subject, global::Auction.V1.AuctionEvent message) =>
            nats.Publish(subject, message);

        public FavoriteOperations Favorites() => new(source, TimeProvider.System, new FactTelemetry());

        public async Task<IReadOnlyList<Notification>> Facts() =>
            (await nats.PublishedFacts())
                .Select(fact => fact.Fact)
                .Where(fact => fact.TypeCase == Notification.TypeOneofCase.StepWindowStarted)
                .ToArray();

        public IReadOnlyList<StepWindowTaskRow> Tasks() =>
            StepWindowProbe.Tasks(Db.ConnectionString, Guid.Parse(AuctionId));

        public int Scheduled() => StepWindowProbe.Scheduled(Db.ConnectionString, Guid.Parse(AuctionId));

        public async Task<long> ReplicaVersion(string lot)
        {
            await using var connection = new NpgsqlConnection(Db.ConnectionString);
            return await connection.ExecuteScalarAsync<long>(
                "SELECT version FROM lot_replica WHERE lot_id = @Lot;",
                new { Lot = Guid.Parse(lot) });
        }

        private AuctionTelemetry Auction => silo.Service<AuctionTelemetry>();

        private static string Iso(DateTimeOffset moment) =>
            moment.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);

        public async ValueTask DisposeAsync()
        {
            await silo.DisposeAsync();
            await nats.DisposeAsync();
            await source.DisposeAsync();
            Db.Dispose();
        }
    }
}
