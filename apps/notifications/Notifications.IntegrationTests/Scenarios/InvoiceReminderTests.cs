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
/// Напоминание о неоплаченном счёте (PER-330, моменты — PER-726) от факта
/// Auction до адресного факта в стриме уведомлений: реплика счёта даёт моменты
/// и адресата, грин ведёт задания за 24 часа, за 12 часов и за час до срока
/// оплаты, срабатывание пишет факт победителю, а оплата снимает несработавшие
/// задания.
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
    /// Счёт со сроком семь суток заводит три задания — за 24, 12 и 1 час до
    /// срока, — а наступившее даёт один факт победителю. Повторное срабатывание
    /// второго факта не даёт: сработавшее задание не воскресает.
    /// </summary>
    [Fact]
    public async Task When_InvoiceRaisedWithSevenDayTerm_Expect_ThreeTasksAndOneReminderAfterSweep()
    {
        await using var env = await BusScenario.Start(Sweeping);
        var winner = await Person(env.Db, MemberHolding);

        await env.Publish(IssuedSubject, env.Invoice(winner));

        var tasks = await Eventually(
            () => Task.FromResult(env.Tasks()),
            rows => rows.Count == 3);
        tasks.Select(task => task.Kind).ShouldBe(
            [InvoiceReminderProbe.DayBefore, InvoiceReminderProbe.HalfDayBefore, InvoiceReminderProbe.HourBefore],
            ignoreOrder: true);
        tasks.ShouldAllBe(task => task.State == "scheduled");
        DueOf(tasks, InvoiceReminderProbe.DayBefore).ShouldBe(env.PaymentDueAt.AddHours(-24), TimeSpan.FromMilliseconds(1));
        DueOf(tasks, InvoiceReminderProbe.HalfDayBefore).ShouldBe(env.PaymentDueAt.AddHours(-12), TimeSpan.FromMilliseconds(1));
        DueOf(tasks, InvoiceReminderProbe.HourBefore).ShouldBe(env.PaymentDueAt.AddHours(-1), TimeSpan.FromMilliseconds(1));

        // Простоя не изображаем вызовом грина: момент сдвигается данными, а
        // напоминание достаёт sweeper — путь «кластер лежал» целиком.
        InvoiceReminderProbe.MoveDueToPast(env.Db.ConnectionString, Guid.Parse(env.InvoiceId),
            InvoiceReminderProbe.DayBefore);

        var rows = await Eventually(() => env.Reminders(), facts => facts.Count == 1);
        var fact = rows.Single();
        fact.RecipientId.ShouldBe(winner.ToString());
        fact.Cause.ReminderTaskId.ShouldBe(tasks.Single(task => task.Kind == InvoiceReminderProbe.DayBefore).TaskId
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
        env.Tasks().Single(task => task.Kind == InvoiceReminderProbe.DayBefore).State.ShouldBe("fired");
        env.Tasks().Where(task => task.Kind != InvoiceReminderProbe.DayBefore)
            .ShouldAllBe(task => task.State == "scheduled");
    }

    /// <summary>
    /// Счёт со сроком сутки: момент «за 24 часа» приходится на выставление —
    /// рядом с вестью о покупке — и пропускается; напоминания приходят за 12
    /// часов и за час, по факту на момент.
    /// </summary>
    [Fact]
    public async Task When_InvoiceRaisedWithOneDayTerm_Expect_RemindersTwelveAndOneHourBeforeOnly()
    {
        await using var env = await BusScenario.Start(Sweeping);
        var winner = await Person(env.Db, MemberHolding);
        var dueAt = DateTimeOffset.UtcNow.AddDays(1);

        await env.Publish(IssuedSubject, env.Invoice(winner, dueAt));

        var tasks = await Eventually(
            () => Task.FromResult(env.Tasks()),
            rows => rows.Count == 2);
        tasks.Select(task => task.Kind).ShouldBe(
            [InvoiceReminderProbe.HalfDayBefore, InvoiceReminderProbe.HourBefore], ignoreOrder: true);
        DueOf(tasks, InvoiceReminderProbe.HalfDayBefore).ShouldBe(dueAt.AddHours(-12), TimeSpan.FromMilliseconds(1));
        DueOf(tasks, InvoiceReminderProbe.HourBefore).ShouldBe(dueAt.AddHours(-1), TimeSpan.FromMilliseconds(1));

        InvoiceReminderProbe.MoveDueToPast(env.Db.ConnectionString, Guid.Parse(env.InvoiceId),
            InvoiceReminderProbe.HalfDayBefore);
        await Eventually(() => env.Facts(NotificationFacts.InvoiceDueReminderType), count => count == 1);

        InvoiceReminderProbe.MoveDueToPast(env.Db.ConnectionString, Guid.Parse(env.InvoiceId),
            InvoiceReminderProbe.HourBefore);
        await Eventually(() => env.Facts(NotificationFacts.InvoiceDueReminderType), count => count == 2);

        var published = await Eventually(() => env.DueReminders(), facts => facts.Count == 2);
        published.Select(fact => fact.Cause.ReminderTaskId).ShouldBe(
            tasks.Select(task => task.TaskId.ToString()), ignoreOrder: true);
        published.ShouldAllBe(fact => fact.RecipientId == winner.ToString());

        // Дальнего напоминания нет: его момент совпал бы с вестью о покупке.
        (await env.Facts(NotificationFacts.InvoiceReminderType)).ShouldBe(0);
        env.Tasks().ShouldAllBe(task => task.State == "fired");
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
        await Eventually(() => Task.FromResult(env.Tasks()), rows => rows.Count == 3);

        await env.Publish(PaidSubject, env.Paid(winner));

        await Eventually(
            () => Task.FromResult(env.Tasks()),
            rows => rows.Count == 3 && rows.All(task => task.State == "cancelled"));

        (await env.Facts(NotificationFacts.InvoiceReminderType)).ShouldBe(0);
        (await env.Facts(NotificationFacts.InvoiceDueReminderType)).ShouldBe(0);
    }

    /// <summary>
    /// Задания схемы PER-330 пересчитываются миграцией 044 под новые моменты:
    /// живые старые снимаются, новые заводятся по сроку оплаты, сработавшие не
    /// трогаются, прошедший момент пропускается, а повтор миграции ничего не
    /// меняет.
    /// </summary>
    [Fact]
    public void When_OldSchemeTasksMigrated_Expect_RescheduledToDueLeads()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        var now = DateTimeOffset.UtcNow;

        // Неделя срока: первое напоминание старой схемы уже ушло, второе ждёт.
        var week = Guid.NewGuid();
        var weekDue = now.AddDays(6);
        Seed(db, week, issuedAt: now.AddDays(-1), dueAt: weekDue);
        SeedTask(db, week, "after_win", now.AddHours(-12), "fired");
        SeedTask(db, week, "before_due", weekDue.AddDays(-1), "scheduled");

        // Сутки срока, выставлен 13 часов назад: «за 12 часов» уже прошёл.
        var day = Guid.NewGuid();
        var dayDue = now.AddHours(11);
        Seed(db, day, issuedAt: now.AddHours(-13), dueAt: dayDue);
        SeedTask(db, day, "after_win", now.AddMinutes(-30), "scheduled");
        SeedTask(db, day, "before_due", now.AddHours(-12), "scheduled");

        var script = Migrations.List().Single(migration => migration.Name == "invoice_reminder_due_leads").Sql;
        using (var connection = new NpgsqlConnection(db.ConnectionString))
        {
            connection.Execute(script);
            connection.Execute(script);
        }

        var weekTasks = InvoiceReminderProbe.Tasks(db.ConnectionString, week);
        weekTasks.Single(task => task.Kind == InvoiceReminderProbe.AfterWin).State.ShouldBe("fired");
        weekTasks.Single(task => task.Kind == InvoiceReminderProbe.BeforeDue).State.ShouldBe("cancelled");
        weekTasks.Where(task => task.State == "scheduled").Select(task => task.Kind).ShouldBe(
            [InvoiceReminderProbe.DayBefore, InvoiceReminderProbe.HalfDayBefore, InvoiceReminderProbe.HourBefore],
            ignoreOrder: true);
        DueOf(weekTasks, InvoiceReminderProbe.DayBefore).ShouldBe(weekDue.AddHours(-24), TimeSpan.FromMilliseconds(1));
        DueOf(weekTasks, InvoiceReminderProbe.HalfDayBefore).ShouldBe(weekDue.AddHours(-12), TimeSpan.FromMilliseconds(1));
        DueOf(weekTasks, InvoiceReminderProbe.HourBefore).ShouldBe(weekDue.AddHours(-1), TimeSpan.FromMilliseconds(1));

        var dayTasks = InvoiceReminderProbe.Tasks(db.ConnectionString, day);
        dayTasks.Where(task => task.Kind is InvoiceReminderProbe.AfterWin or InvoiceReminderProbe.BeforeDue)
            .ShouldAllBe(task => task.State == "cancelled");
        var live = dayTasks.Where(task => task.State == "scheduled").ToList();
        live.Select(task => task.Kind).ShouldBe([InvoiceReminderProbe.HourBefore]);
        DueOf(live, InvoiceReminderProbe.HourBefore).ShouldBe(dayDue.AddHours(-1), TimeSpan.FromMilliseconds(1));
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
        await Eventually(() => Task.FromResult(env.Tasks()), rows => rows.Count == 3);

        await Execute(env.Db,
            "UPDATE invoice_replica SET status = 'paid' WHERE invoice_id = @Invoice;",
            new { Invoice = Guid.Parse(env.InvoiceId) });

        InvoiceReminderProbe.MoveDueToPast(env.Db.ConnectionString, Guid.Parse(env.InvoiceId),
            InvoiceReminderProbe.DayBefore);

        // Наступившее задание снимается, а факта нет: счёт оплачен.
        var fired = await Eventually(
            () => Task.FromResult(env.Tasks().Single(task => task.Kind == InvoiceReminderProbe.DayBefore)),
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
        await Eventually(() => Task.FromResult(env.Tasks()), rows => rows.Count == 3);

        InvoiceReminderProbe.MoveDueToPast(env.Db.ConnectionString, Guid.Parse(env.InvoiceId),
            InvoiceReminderProbe.DayBefore);

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
        await Eventually(() => Task.FromResult(env.Tasks()), rows => rows.Count == 3);

        InvoiceReminderProbe.MoveDueToPast(env.Db.ConnectionString, Guid.Parse(env.InvoiceId),
            InvoiceReminderProbe.DayBefore);
        await Eventually(() => env.Facts(NotificationFacts.InvoiceReminderType), count => count == 1);

        await env.Restart();

        (await env.Grain.FireDue()).ShouldBeFalse();
        (await env.Facts(NotificationFacts.InvoiceReminderType)).ShouldBe(1);
        env.Tasks().Single(task => task.Kind == InvoiceReminderProbe.DayBefore).State.ShouldBe("fired");
    }

    private static DateTimeOffset DueOf(IEnumerable<InvoiceReminderTaskRow> tasks, string kind) =>
        new(tasks.Single(task => task.Kind == kind && task.State == "scheduled").DueAt.ToUniversalTime());

    /// <summary>Реплика неоплаченного счёта такой, какой её оставил факт выставления.</summary>
    private static void Seed(IsolatedDatabase db, Guid invoiceId, DateTimeOffset issuedAt, DateTimeOffset dueAt)
    {
        using var connection = new NpgsqlConnection(db.ConnectionString);
        connection.Execute(
            """
            INSERT INTO invoice_replica (invoice_id, version, status, winner_id, lot_id, auction_id,
                amount_minor_units, amount_currency, payment_due_at, issued_at, applied_at)
            VALUES (@invoiceId, 1, 'awaiting_payment', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
                45600, 'RUB', @dueAt, @issuedAt, @issuedAt);
            """,
            new { invoiceId, issuedAt = issuedAt.UtcDateTime, dueAt = dueAt.UtcDateTime });
    }

    /// <summary>Задание старой схемы так, как его записал прежний образ.</summary>
    private static void SeedTask(IsolatedDatabase db, Guid invoiceId, string kind, DateTimeOffset dueAt, string state)
    {
        using var connection = new NpgsqlConnection(db.ConnectionString);
        connection.Execute(
            """
            INSERT INTO invoice_reminder_task (task_id, invoice_id, kind, due_at, state, created_at, fired_at)
            VALUES (gen_random_uuid(), @invoiceId, @kind, @dueAt, @state, now() - interval '1 day',
                CASE WHEN @state = 'fired' THEN @dueAt END);
            """,
            new { invoiceId, kind, dueAt = dueAt.UtcDateTime, state });
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

        public async Task<IReadOnlyList<Notification>> DueReminders() =>
            (await nats.PublishedFacts())
                .Select(fact => fact.Fact)
                .Where(fact => fact.TypeCase == Notification.TypeOneofCase.InvoiceDueReminder)
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
