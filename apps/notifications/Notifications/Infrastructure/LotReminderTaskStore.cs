using Dapper;
using Npgsql;
using Notifications.Facts;
using Notifications.Reminders;

namespace Notifications.Infrastructure;

/// <summary>Живое задание лота: то, что нужно ядру для решения.</summary>
public sealed record LiveLotReminderTask(Guid TaskId, DateTimeOffset Deadline, DateTimeOffset DueAt);

/// <summary>Исход исполнения задания лота.</summary>
public enum LotFireOutcome
{
    /// <summary>Задание исполнено: факты записаны, повтор не даст второго.</summary>
    Sent,

    /// <summary>Задание исполнил кто-то другой: захват не достался этому вызову.</summary>
    AlreadyFired,

    /// <summary>
    /// Реплика ушла вперёд между чтением задания и захватом: задание не
    /// исполнено, захват откатан. Вызывающий приводит задание к реплике заново.
    /// </summary>
    Stale,
}

/// <summary>Исход исполнения и записанные факты.</summary>
public sealed record LotFireResult(LotFireOutcome Outcome, FactCount Facts);

/// <summary>
/// Доступ к таблице заданий напоминания о лоте. Dapper поверх Npgsql — тот же
/// набор, что у соседнего <see cref="ReminderTaskStore" />.
/// </summary>
/// <remarks>
/// Здесь нет ни одного решения о том, нужно ли задание: их принимает
/// <see cref="LotReminderPlan" />. Этот класс только пишет и читает строки.
/// </remarks>
public sealed class LotReminderTaskStore(NpgsqlDataSource source, LotReminderTelemetry telemetry)
{
    private const string LiveSql = """
        SELECT task_id, deadline, due_at
        FROM lot_reminder_task
        WHERE lot_id = @LotId AND state = 'scheduled';
        """;

    // «Срабатывало ли вообще» — не «по этому ли дедлайну»: продление после
    // срабатывания нового напоминания не рождает (ADR-063, п.4).
    private const string FiredEverSql = """
        SELECT EXISTS (
            SELECT 1 FROM lot_reminder_task
            WHERE lot_id = @LotId AND state = 'fired'
        );
        """;

    private const string InsertSql = """
        INSERT INTO lot_reminder_task (task_id, lot_id, deadline, due_at, state, created_at)
        VALUES (@TaskId, @LotId, @Deadline, @DueAt, 'scheduled', @Now);
        """;

    private const string SupersedeSql = """
        UPDATE lot_reminder_task
        SET state = 'superseded', superseded_by = @NewTaskId, reason = @Reason
        WHERE task_id = @TaskId AND state = 'scheduled';
        """;

    private const string CancelSql = """
        UPDATE lot_reminder_task
        SET state = 'cancelled', reason = @Reason
        WHERE lot_id = @LotId AND state = 'scheduled';
        """;

    private const string FireSql = """
        UPDATE lot_reminder_task
        SET state = 'fired', fired_at = @Now
        WHERE task_id = @TaskId AND state = 'scheduled';
        """;

    /// <summary>Живое задание лота, если оно есть.</summary>
    public async Task<LiveLotReminderTask?> Live(Guid lotId, CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        var row = await connection.QuerySingleOrDefaultAsync<LiveRow>(
            new CommandDefinition(LiveSql, new { LotId = lotId }, cancellationToken: cancellationToken));

        return row is null ? null : new LiveLotReminderTask(row.task_id, Moment(row.deadline), Moment(row.due_at));
    }

    /// <summary>По этому лоту напоминание уже срабатывало.</summary>
    public async Task<bool> FiredEver(Guid lotId, CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        return await connection.ExecuteScalarAsync<bool>(
            new CommandDefinition(FiredEverSql, new { LotId = lotId }, cancellationToken: cancellationToken));
    }

    /// <summary>Заводит задание. Возвращает его идентификатор.</summary>
    public async Task<Guid> Create(
        Guid lotId,
        DateTimeOffset deadline,
        DateTimeOffset dueAt,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var taskId = Guid.NewGuid();

        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        await connection.ExecuteAsync(
            new CommandDefinition(
                InsertSql,
                new { TaskId = taskId, LotId = lotId, Deadline = deadline.UtcDateTime, DueAt = dueAt.UtcDateTime, Now = now.UtcDateTime },
                cancellationToken: cancellationToken));

        return taskId;
    }

    /// <summary>Замещает живое задание новым: обе строки меняются одной транзакцией.</summary>
    public async Task<Guid> Supersede(
        Guid liveTaskId,
        Guid lotId,
        DateTimeOffset deadline,
        DateTimeOffset dueAt,
        DateTimeOffset now,
        string reason,
        CancellationToken cancellationToken)
    {
        var taskId = Guid.NewGuid();

        await using var connection = await source.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        var removed = await connection.ExecuteAsync(
            new CommandDefinition(
                SupersedeSql,
                new { TaskId = liveTaskId, NewTaskId = taskId, Reason = reason },
                transaction,
                cancellationToken: cancellationToken));

        await connection.ExecuteAsync(
            new CommandDefinition(
                InsertSql,
                new { TaskId = taskId, LotId = lotId, Deadline = deadline.UtcDateTime, DueAt = dueAt.UtcDateTime, Now = now.UtcDateTime },
                transaction,
                cancellationToken: cancellationToken));

        await transaction.CommitAsync(cancellationToken);
        telemetry.Remove(removed, "superseded");

        return taskId;
    }

    /// <summary>Снимает живое задание лота. Возвращает число снятых строк.</summary>
    public async Task<int> Cancel(Guid lotId, string reason, CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        var removed = await connection.ExecuteAsync(
            new CommandDefinition(CancelSql, new { LotId = lotId, Reason = reason }, cancellationToken: cancellationToken));

        telemetry.Remove(removed, "cancelled");
        return removed;
    }

    /// <summary>
    /// Исполняет задание: переводит в «сработало» и разворачивает на следящих
    /// адресными фактами.
    /// </summary>
    /// <remarks>
    /// Идемпотентность держится условием <c>state = 'scheduled'</c>, а не
    /// проверкой перед записью: проверка и запись разными запросами — это гонка,
    /// в которой оба участника видят «ещё не сработало». Отсюда же исполнение
    /// «немедленно» для уже наступившего момента.
    ///
    /// Задание, отставшее от реплики, не исполняется: транзакция не
    /// фиксируется, и захват откатывается. Иначе «сработало» без фактов
    /// погасило бы напоминание по новому дедлайну навсегда.
    /// </remarks>
    public async Task<LotFireResult> Fire(
        LiveLotReminderTask task,
        Guid lotId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);

        var claimed = await work.Execute(FireSql, new { task.TaskId, Now = now.UtcDateTime }, cancellationToken);

        if (claimed == 0)
        {
            // Ничего не записано, фиксировать нечего: откат при разборе.
            return new LotFireResult(LotFireOutcome.AlreadyFired, FactCount.None);
        }

        var facts = await NotificationStore.AddLotReminder(work, task.TaskId, lotId, task.Deadline, now, cancellationToken);

        if (facts is null)
        {
            // Задание отстало от реплики между чтением и захватом: захват
            // откатывается, чтобы задание догнало реплику заново.
            return new LotFireResult(LotFireOutcome.Stale, FactCount.None);
        }

        await work.Commit(cancellationToken);
        telemetry.Fire();
        return new LotFireResult(LotFireOutcome.Sent, facts);
    }

    // timestamptz читается как DateTime, а не DateTimeOffset — так его отображает
    // Npgsql. Перевод идёт через ToUniversalTime, как в ReminderTaskStore.
    private sealed record LiveRow(Guid task_id, DateTime deadline, DateTime due_at);

    private static DateTimeOffset Moment(DateTime value) => new(value.ToUniversalTime());
}
