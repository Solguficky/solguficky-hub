using Dapper;
using Notifications.Auction;
using Notifications.Facts;
using Notifications.Grains;
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
/// Напоминание о неоплаченном счёте (PER-330) от факта Auction до адресного
/// факта в стриме уведомлений: реплика счёта даёт момент и адресата, грин ведёт
/// два задания, срабатывание пишет факт победителю, а оплата снимает
/// несработавшие задания.
/// </summary>
/// <remarks>
/// Время двигается данными, как у напоминания о сходке: момент срабатывания
/// сдвигается запросом в базу, а период прохода sweeper'а задаётся настройкой.
/// Сценариев немного намеренно: каждый поднимает свою базу, шину и силос, а
/// общий на прогон контейнер PostgreSQL близок к пределу соединений.
/// </remarks>
public class InvoiceReminderTests
{
    private const string IssuedSubject = "events.auction.invoice_issued";
    private const string PaidSubject = "events.auction.invoice_paid";

    /// <summary>Проход sweeper'а раз в секунду: им движется наступившее задание.</summary>
    private static readonly string[] Sweeping = ["--Notifications:Reminders:SweepPeriod=00:00:01"];

    /// <summary>Релей стоит: факт остаётся в очереди, пока его не отозвали.</summary>
    private static readonly string[] HeldRelay =
        ["--Notifications:Reminders:SweepPeriod=00:00:01", "--Notifications:Dispatch:Period=01:00:00"];

    /// <summary>
    /// Выставленный счёт заводит два задания, а наступившее даёт один факт
    /// победителю. Повторное срабатывание второго факта не даёт: сработавшее
    /// задание не воскресает.
    /// </summary>
    [Fact]
    public async Task When_InvoiceRaised_Expect_TwoTasksAndOneReminderAfterSweep()
    {
        await using var env = await BusScenario.Start(Sweeping);
        var winner = await Person(env.Db, MemberHolding);

        await env.Publish(IssuedSubject, env.Invoice(winner));

        var tasks = await Eventually(
            () => Task.FromResult(env.Tasks()),
            rows => rows.Count == 2);
        tasks.Select(task => task.Kind).ShouldBe(
            [InvoiceReminderProbe.AfterWin, InvoiceReminderProbe.BeforeDue], ignoreOrder: true);
        tasks.ShouldAllBe(task => task.State == "scheduled");

        // Простоя не изображаем вызовом грина: момент сдвигается данными, а
        // напоминание достаёт sweeper — путь «кластер лежал» целиком.
        InvoiceReminderProbe.MoveDueToPast(env.Db.ConnectionString, Guid.Parse(env.InvoiceId),
            InvoiceReminderProbe.AfterWin);

        var rows = await Eventually(() => env.Reminders(), facts => facts.Count == 1);
        var fact = rows.Single();
        fact.RecipientId.ShouldBe(winner.ToString());
        fact.Cause.ReminderTaskId.ShouldBe(tasks.Single(task => task.Kind == InvoiceReminderProbe.AfterWin).TaskId
            .ToString());
        fact.InvoiceReminder.InvoiceId.ShouldBe(env.InvoiceId);
        fact.InvoiceReminder.LotId.ShouldBe(env.LotId);
        fact.InvoiceReminder.Amount.MinorUnits.ShouldBe(45600);
        fact.InvoiceReminder.Amount.Currency.ShouldBe("RUB");
        // Срок годности факта — срок оплаты: напоминание, не ушедшее до него,
        // уже шум. База хранит микросекунды, поэтому сверка с допуском.
        DateTimeOffset.Parse(fact.NotAfter, System.Globalization.CultureInfo.InvariantCulture)
            .ShouldBe(env.PaymentDueAt, TimeSpan.FromMilliseconds(1));
        DateTimeOffset.Parse(fact.InvoiceReminder.PaymentDueAt, System.Globalization.CultureInfo.InvariantCulture)
            .ShouldBe(env.PaymentDueAt, TimeSpan.FromMilliseconds(1));
        fact.HasRequestId.ShouldBeFalse();

        // Сработавшее задание второй раз не воскресает: ни факта, ни новой
        // задачи.
        (await env.Grain.FireDue()).ShouldBeFalse();
        (await env.Facts(NotificationFacts.InvoiceReminderType)).ShouldBe(1);
        env.Tasks().Single(task => task.Kind == InvoiceReminderProbe.AfterWin).State.ShouldBe("fired");
        env.Tasks().Single(task => task.Kind == InvoiceReminderProbe.BeforeDue).State.ShouldBe("scheduled");
    }

    /// <summary>
    /// Оплаченный счёт напоминаний не получает: задания снимаются, а фактов
    /// нет.
    /// </summary>
    [Fact]
    public async Task When_InvoicePaid_Expect_TasksCancelledAndNoReminder()
    {
        await using var env = await BusScenario.Start(Sweeping);
        var winner = await Person(env.Db, MemberHolding);

        await env.Publish(IssuedSubject, env.Invoice(winner));
        await Eventually(() => Task.FromResult(env.Tasks()), rows => rows.Count == 2);

        await env.Publish(PaidSubject, env.Paid(winner));

        await Eventually(
            () => Task.FromResult(env.Tasks()),
            rows => rows.Count == 2 && rows.All(task => task.State == "cancelled"));

        (await env.Facts(NotificationFacts.InvoiceReminderType)).ShouldBe(0);
        (await env.Facts(NotificationFacts.InvoiceDueReminderType)).ShouldBe(0);
    }

    /// <summary>
    /// Оплата пришла в тот же момент, когда задание ждало: напоминания не
    /// будет, даже если задание успело наступить. Гонку изображает оплаченный
    /// снимок при живом задании — как будто отметка оплаты дошла до грина, а
    /// задание ещё не сняли.
    /// </summary>
    [Fact]
    public async Task When_InvoicePaidWhileTaskWaits_Expect_NoReminder()
    {
        await using var env = await BusScenario.Start(Sweeping);
        var winner = await Person(env.Db, MemberHolding);

        await env.Publish(IssuedSubject, env.Invoice(winner));
        await Eventually(() => Task.FromResult(env.Tasks()), rows => rows.Count == 2);

        await Execute(env.Db,
            "UPDATE invoice_replica SET status = 'paid' WHERE invoice_id = @Invoice;",
            new { Invoice = Guid.Parse(env.InvoiceId) });

        InvoiceReminderProbe.MoveDueToPast(env.Db.ConnectionString, Guid.Parse(env.InvoiceId),
            InvoiceReminderProbe.AfterWin);

        // Наступившее задание снимается, а факта нет: счёт оплачен.
        var fired = await Eventually(
            () => Task.FromResult(env.Tasks().Single(task => task.Kind == InvoiceReminderProbe.AfterWin)),
            row => row.State != "scheduled");
        fired.State.ShouldBe("cancelled");

        (await env.Facts(NotificationFacts.InvoiceReminderType)).ShouldBe(0);
        (await env.Facts(NotificationFacts.InvoiceDueReminderType)).ShouldBe(0);
    }

    /// <summary>
    /// Счёт оплатили, а напоминание о нём ещё стояло в очереди релея: строка
    /// снята с причиной <c>invoice_paid</c>, и в шину она не уйдёт.
    /// </summary>
    [Fact]
    public async Task When_InvoicePaidBeforeRelay_Expect_PendingReminderWithdrawn()
    {
        await using var env = await BusScenario.Start(HeldRelay);
        var winner = await Person(env.Db, MemberHolding);

        await env.Publish(IssuedSubject, env.Invoice(winner));
        await Eventually(() => Task.FromResult(env.Tasks()), rows => rows.Count == 2);

        InvoiceReminderProbe.MoveDueToPast(env.Db.ConnectionString, Guid.Parse(env.InvoiceId),
            InvoiceReminderProbe.AfterWin);

        await Eventually(() => env.Facts(NotificationFacts.InvoiceReminderType), count => count == 1);
        var pending = (await env.Rows()).Single();
        pending.DispatchedAt.ShouldBeNull();
        pending.WithdrawnAt.ShouldBeNull();

        await env.Publish(PaidSubject, env.Paid(winner));

        await Eventually(
            () => env.Rows(),
            rows => rows.Count == 1 && rows[0].WithdrawnAt is not null);
        var withdrawn = (await env.Rows()).Single();
        withdrawn.WithdrawalReason.ShouldBe(NotificationFacts.WithdrawnOnInvoicePaid);
        withdrawn.DispatchedAt.ShouldBeNull();
    }

    /// <summary>
    /// Срок оплаты прошёл, а счёт не оплачен: напоминать уже не о чем, и заданий
    /// не заводится.
    /// </summary>
    [Fact]
    public async Task When_PaymentDeadlinePassed_Expect_NoTasks()
    {
        await using var env = await BusScenario.Start(Sweeping);
        var winner = await Person(env.Db, MemberHolding);

        await env.Publish(IssuedSubject, env.Invoice(winner, DateTimeOffset.UtcNow.AddHours(-1)));

        env.Tasks().ShouldBeEmpty();
        (await env.Facts(NotificationFacts.InvoiceReminderType)).ShouldBe(0);
    }

    /// <summary>
    /// Рестарт Notifications не порождает повторное напоминание: сработавшее
    /// задание лежит в PostgreSQL, и грин на новом силосе не воскрешает его.
    /// </summary>
    [Fact]
    public async Task When_SiloRestarted_Expect_NoSecondReminder()
    {
        await using var env = await BusScenario.Start(HeldRelay);
        var winner = await Person(env.Db, MemberHolding);

        await env.Publish(IssuedSubject, env.Invoice(winner));
        await Eventually(() => Task.FromResult(env.Tasks()), rows => rows.Count == 2);

        InvoiceReminderProbe.MoveDueToPast(env.Db.ConnectionString, Guid.Parse(env.InvoiceId),
            InvoiceReminderProbe.AfterWin);
        await Eventually(() => env.Facts(NotificationFacts.InvoiceReminderType), count => count == 1);

        await env.Restart();

        (await env.Grain.FireDue()).ShouldBeFalse();
        (await env.Facts(NotificationFacts.InvoiceReminderType)).ShouldBe(1);
        env.Tasks().Single(task => task.Kind == InvoiceReminderProbe.AfterWin).State.ShouldBe("fired");
    }

    /// <summary>База, шина и силос одного счёта. Люди — через настоящую реплику.</summary>
    private sealed class BusScenario : IAsyncDisposable
    {
        private readonly NatsUnderTest nats;
        private readonly NpgsqlDataSource source;
        private readonly string[] settings;
        private SiloUnderTest silo;

        private BusScenario(IsolatedDatabase db, NpgsqlDataSource source, NatsUnderTest nats, SiloUnderTest silo,
            string[] settings)
        {
            Db = db;
            this.source = source;
            this.nats = nats;
            this.silo = silo;
            this.settings = settings;
        }

        public IsolatedDatabase Db { get; }

        public string InvoiceId { get; } = EventFactory.InvoiceOfSale();

        public string LotId { get; } = EventFactory.NewId();

        /// <summary>Срок оплаты — через семь суток от настоящих часов.</summary>
        public DateTimeOffset PaymentDueAt { get; } = DateTimeOffset.UtcNow.AddDays(7);

        public IInvoiceNotificationGrain Grain => silo.Grains.GetGrain<IInvoiceNotificationGrain>(InvoiceId);

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

                return new BusScenario(db, source, nats, silo, settings);
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

        /// <summary>
        /// Перезапуск сервиса: тот же силос, та же база и та же шина. Устойчивость
        /// задания лежит в PostgreSQL, и переживает рестарт не процесс.
        /// </summary>
        public async Task Restart()
        {
            await silo.DisposeAsync();
            silo = await SiloUnderTest.StartOnBus(Db.ConnectionString, nats.Url, settings);
        }

        /// <summary>Счёт выставлен по продаже.</summary>
        public global::Auction.V1.InvoiceEvent Invoice(Guid winner, DateTimeOffset? dueAt = null) =>
            EventFactory.Invoice(
                InvoiceId, LotId, winner.ToString(), version: 1, issued: true,
                dueAt: Iso(dueAt ?? PaymentDueAt), occurredAt: Iso(DateTimeOffset.UtcNow));

        /// <summary>Организатор подтвердил оплату.</summary>
        public global::Auction.V1.InvoiceEvent Paid(Guid winner) => EventFactory.Invoice(
            InvoiceId, LotId, winner.ToString(), version: 2, issued: false,
            dueAt: Iso(PaymentDueAt), occurredAt: Iso(DateTimeOffset.UtcNow.AddMinutes(1)));

        /// <summary>Публикует событие и ждёт, пока потребитель его разберёт и позовёт грин.</summary>
        public async Task Publish(string subject, global::Auction.V1.InvoiceEvent message)
        {
            var before = Auction.Total("invoice_replicated");
            await nats.Publish(subject, message);
            await Eventually(() => Task.FromResult(Auction.Total("invoice_replicated")), count => count > before);
        }

        public IReadOnlyList<InvoiceReminderTaskRow> Tasks() =>
            InvoiceReminderProbe.Tasks(Db.ConnectionString, Guid.Parse(InvoiceId));

        public async Task<IReadOnlyList<Notification>> Reminders() =>
            (await nats.PublishedFacts())
                .Select(fact => fact.Fact)
                .Where(fact => fact.TypeCase == Notification.TypeOneofCase.InvoiceReminder)
                .ToArray();

        public Task<long> Facts(string type) =>
            Task.FromResult(InvoiceReminderProbe.Facts(Db.ConnectionString, type));

        /// <summary>Строки адресных фактов: их срок и снятие видно глазами.</summary>
        public Task<IReadOnlyList<InvoiceReminderFactRow>> Rows() =>
            Task.FromResult(InvoiceReminderProbe.Rows(Db.ConnectionString));

        private AuctionTelemetry Auction => silo.Service<AuctionTelemetry>();

        private static string Iso(DateTimeOffset moment) => moment.ToUniversalTime().ToString("O");

        public async ValueTask DisposeAsync()
        {
            await silo.DisposeAsync();
            await nats.DisposeAsync();
            await source.DisposeAsync();
            Db.Dispose();
        }
    }
}
