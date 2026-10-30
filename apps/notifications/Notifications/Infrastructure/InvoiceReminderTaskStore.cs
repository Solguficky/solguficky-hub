using Dapper;
using Npgsql;
using Notifications.Auction;
using Notifications.Facts;
using Notifications.Reminders;

namespace Notifications.Infrastructure;

/// <summary>Задание напоминания о счёте: строка таблицы и её положение.</summary>
public sealed record InvoiceReminderTask(Guid TaskId, Guid InvoiceId, InvoiceReminderKind Kind, DateTimeOffset DueAt,
    string State, DateTimeOffset? PaymentDueAt = null)
{
    /// <summary>Живое задание: запланированное и ещё не сработавшее.</summary>
    public bool Live => State == "scheduled";
}

/// <summary>Исход исполнения задания счёта.</summary>
public enum InvoiceFireOutcome
{
    /// <summary>Задание исполнено: факт записан, повтор не даст второго.</summary>
    Sent,

    /// <summary>Задание исполнил кто-то другой: захват не достался этому вызову.</summary>
    AlreadyFired,

    /// <summary>
    /// Счёт оплачен, пока задание ждало: напоминать уже не о чем, задание
    /// снято, а факта нет.
    /// </summary>
    Settled,

    /// <summary>
    /// Срок оплаты прошёл, пока задание ждало: напоминание уже неуместно,
    /// задание снято, а факта нет.
    /// </summary>
    Expired,
}

/// <summary>Исход исполнения и записанные факты.</summary>
public sealed record InvoiceFireResult(InvoiceFireOutcome Outcome, FactCount Facts);

/// <summary>
/// Доступ к таблице заданий напоминания о неоплаченном счёте. Dapper поверх
/// Npgsql — тот же набор, что у соседних хранилищ.
/// </summary>
/// <remarks>
/// Здесь нет ни одного решения о том, нужно ли задание: их принимает
/// <see cref="InvoiceReminderPlan" />. Этот класс только пишет и читает строки.
/// </remarks>
public sealed class InvoiceReminderTaskStore(NpgsqlDataSource source, InvoiceReminderTelemetry telemetry)
{
    // Последнее задание счёта и вида: живое или уже прошедшее. Ответ на
    // «было ли задание по этому виду» и на «какое у него состояние» — один
    // запрос: строки не чистятся, и без порядка по времени вопрос «какое
    // последнее» не имел бы ответа.
    private const string ReadSql = """
        SELECT task_id, invoice_id, kind, due_at, state, payment_due_at
        FROM invoice_reminder_task
        WHERE invoice_id = @InvoiceId AND kind = @Kind
        ORDER BY created_at DESC
        LIMIT 1;
        """;

    // Живое задание с наступившим моментом: их до трёх, и срабатывает то,
    // что ждало дольше.
    private const string DueSql = """
        SELECT task_id, invoice_id, kind, due_at, state, payment_due_at
        FROM invoice_reminder_task
        WHERE invoice_id = @InvoiceId AND state = 'scheduled' AND due_at <= @Now
        ORDER BY due_at
        LIMIT 1;
        """;

    private const string InsertSql = """
        INSERT INTO invoice_reminder_task (task_id, invoice_id, kind, due_at, state, created_at, payment_due_at)
        VALUES (@TaskId, @InvoiceId, @Kind, @DueAt, 'scheduled', @Now, @PaymentDueAt);
        """;

    private const string CancelSql = """
        UPDATE invoice_reminder_task
        SET state = 'cancelled', reason = @Reason
        WHERE invoice_id = @InvoiceId AND state = 'scheduled';
        """;

    private const string CancelOneSql = """
        UPDATE invoice_reminder_task
        SET state = 'cancelled', reason = @Reason
        WHERE task_id = @TaskId AND state = 'scheduled';
        """;

    private const string FireSql = """
        UPDATE invoice_reminder_task
        SET state = 'fired', fired_at = @Now
        WHERE task_id = @TaskId AND state = 'scheduled';
        """;

    /// <summary>Последнее задание счёта и вида, если оно было.</summary>
    public async Task<InvoiceReminderTask?> Read(Guid invoiceId, InvoiceReminderKind kind,
        CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        var rows = await connection.QueryAsync<Row>(
            new CommandDefinition(
                ReadSql,
                new { InvoiceId = invoiceId, Kind = InvoiceReminderKinds.Text(kind) },
                cancellationToken: cancellationToken));

        return rows.Select(Map).SingleOrDefault();
    }

    /// <summary>Живое задание с наступившим моментом, если оно есть.</summary>
    public async Task<InvoiceReminderTask?> Due(Guid invoiceId, DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        var rows = await connection.QueryAsync<Row>(
            new CommandDefinition(
                DueSql,
                new { InvoiceId = invoiceId, Now = now.UtcDateTime },
                cancellationToken: cancellationToken));

        return rows.Select(Map).SingleOrDefault();
    }

    /// <summary>
    /// Применяет решение по заданиям счёта одной транзакцией: снимает живые
    /// задания и заводит недостающие.
    /// </summary>
    /// <param name="invoiceId">Счёт, чьи задания правятся.</param>
    /// <param name="creates">Задания, которых не хватает: вид и момент.</param>
    /// <param name="cancelLive">Снять ли живые задания счёта.</param>
    /// <param name="paymentDueAt">Срок из реплики, по которой рассчитаны создаваемые задания.</param>
    /// <param name="cancelReason">Причина снятия: она встаёт в строку.</param>
    /// <param name="now">Момент записи.</param>
    /// <remarks>
    /// Одна транзакция, а не по записи на задание: задания счёта — моменты
    /// одного напоминания, и падение между их записями оставило бы счёт без
    /// части моментов навсегда — факт счёта приходит один раз, а
    /// повтор по шине не обещан.
    /// </remarks>
    public async Task<int> Apply(
        Guid invoiceId,
        IReadOnlyList<(InvoiceReminderKind Kind, DateTimeOffset DueAt)> creates,
        bool cancelLive,
        DateTimeOffset? paymentDueAt,
        string cancelReason,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);

        var removed = 0;
        if (cancelLive)
        {
            removed = await work.Execute(
                CancelSql,
                new { InvoiceId = invoiceId, Reason = cancelReason },
                cancellationToken);

            // Факт, который уже написан, но ещё не ушёл в шину, снимается тем
            // же движением: человек оплатил счёт, а весть о неоплаченном счёте
            // ещё стояла в очереди релея.
            await NotificationStore.WithdrawInvoiceReminders(work, invoiceId, now, cancellationToken);
        }

        foreach (var (kind, dueAt) in creates)
        {
            await work.Execute(
                InsertSql,
                new
                {
                    TaskId = Guid.NewGuid(),
                    InvoiceId = invoiceId,
                    Kind = InvoiceReminderKinds.Text(kind),
                    PaymentDueAt = paymentDueAt?.UtcDateTime,
                    DueAt = dueAt.UtcDateTime,
                    Now = now.UtcDateTime,
                },
                cancellationToken);
        }

        await work.Commit(cancellationToken);
        telemetry.Remove(removed, "cancelled");

        return removed;
    }

    /// <summary>
    /// Исполняет задание: переводит в «сработало» и пишет адресный факт.
    /// </summary>
    /// <remarks>
    /// Идемпотентность держится условием <c>state = 'scheduled'</c>, а не
    /// проверкой перед записью: проверка и запись разными запросами — это гонка,
    /// в которой оба участника видят «ещё не сработало». Отсюда же исполнение
    /// «немедленно» для уже наступившего момента.
    ///
    /// Реплика счёта читается под разделяемой блокировкой строки: запись
    /// оплаты берёт ту же строку на себя, и без блокировки оплата успела бы
    /// встать между чтением и записью факта — и напоминание о неоплаченном
    /// счёте ушло бы после того, как оплата уже записана.
    ///
    /// Оплата счёта приходит отдельным фактом и снимает живые задания. Если она
    /// пришла раньше срабатывания, счёт уже оплачен и напоминать не о чем:
    /// задание снимается, а факт не пишется. Порядок задают строки: обе
    /// стороны меняют одну и ту же строку, и первая из них решает.
    /// </remarks>
    public async Task<InvoiceFireResult> Fire(
        InvoiceReminderTask task,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);

        var replica = await InvoiceReplicaStore.ReadLocked(work, task.InvoiceId, cancellationToken);
        if (replica is null || replica.Status != InvoiceStatus.AwaitingPayment || replica.PaymentDueAt is null ||
            task.PaymentDueAt != replica.PaymentDueAt)
        {
            var cancelled = await work.Execute(
                CancelOneSql,
                new { task.TaskId, Reason = replica is null ? "invoice is unknown" : "invoice paid" },
                cancellationToken);
            await work.Commit(cancellationToken);
            telemetry.Remove(cancelled, "cancelled");

            return new InvoiceFireResult(InvoiceFireOutcome.Settled, FactCount.None);
        }

        // Срок оплаты прошёл, а задание ждало: напоминание уже неуместно, и
        // факт с истёкшим сроком релей снял бы сам — но задание осталось бы
        // сработавшим, и метрика считала бы созданный факт.
        if (replica.PaymentDueAt <= now)
        {
            var cancelled = await work.Execute(
                CancelOneSql,
                new { task.TaskId, Reason = "payment deadline passed" },
                cancellationToken);
            await work.Commit(cancellationToken);
            telemetry.Remove(cancelled, "cancelled");

            return new InvoiceFireResult(InvoiceFireOutcome.Expired, FactCount.None);
        }

        var claimed = await work.Execute(FireSql, new { task.TaskId, Now = now.UtcDateTime }, cancellationToken);

        if (claimed == 0)
        {
            // Ничего не записано, фиксировать нечего: откат при разборе.
            return new InvoiceFireResult(InvoiceFireOutcome.AlreadyFired, FactCount.None);
        }

        var facts = await NotificationStore.AddInvoiceReminder(
            work, task.TaskId, task.Kind, replica, now, cancellationToken);

        await work.Commit(cancellationToken);
        telemetry.Fire();
        return new InvoiceFireResult(InvoiceFireOutcome.Sent, facts);
    }

    private static InvoiceReminderTask Map(Row row) =>
        new(row.task_id, row.invoice_id, InvoiceReminderKinds.Parse(row.kind), Moment(row.due_at), row.state,
            row.payment_due_at is { } due ? Moment(due) : null);

    // timestamptz читается как DateTime, а не DateTimeOffset — так его отображает
    // Npgsql. Перевод идёт через ToUniversalTime, как в остальных хранилищах.
    private static DateTimeOffset Moment(DateTime value) => new(value.ToUniversalTime());

    private sealed record Row(Guid task_id, Guid invoice_id, string kind, DateTime due_at, string state, DateTime? payment_due_at);
}
