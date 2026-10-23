using Dapper;
using Npgsql;
using Notifications.Facts;
using Notifications.Reminders;

namespace Notifications.Infrastructure;

/// <summary>Живое задание лота: то, что нужно ядру для решения.</summary>
public sealed record LiveLotReminderTask(Guid TaskId, LotReminderKind Kind, DateTimeOffset Deadline, DateTimeOffset DueAt);

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
        SELECT task_id, kind, deadline, due_at
        FROM lot_reminder_task
        WHERE lot_id = @LotId AND kind = @Kind AND state = 'scheduled';
        """;

    // «Срабатывало ли по этому виду» — не «по этому ли дедлайну» и не «по лоту
    // вообще»: продление после срабатывания часового не рождает нового
    // часового (ADR-063, п.4), а второй момент после первого завести можно
    // (ADR-063, дополнение 2026-10-20).
    private const string FiredEverSql = """
        SELECT EXISTS (
            SELECT 1 FROM lot_reminder_task
            WHERE lot_id = @LotId AND kind = @Kind AND state = 'fired'
        );
        """;

    private const string InsertSql = """
        INSERT INTO lot_reminder_task (task_id, lot_id, kind, deadline, due_at, state, created_at)
        VALUES (@TaskId, @LotId, @Kind, @Deadline, @DueAt, 'scheduled', @Now);
        """;

    private const string SupersedeSql = """
        UPDATE lot_reminder_task
        SET state = 'superseded', superseded_by = @NewTaskId, reason = @Reason
        WHERE task_id = @TaskId AND state = 'scheduled';
        """;

    private const string CancelSql = """
        UPDATE lot_reminder_task
        SET state = 'cancelled', reason = @Reason
        WHERE lot_id = @LotId AND kind = @Kind AND state = 'scheduled';
        """;

    private const string FireSql = """
        UPDATE lot_reminder_task
        SET state = 'fired', fired_at = @Now
        WHERE task_id = @TaskId AND state = 'scheduled';
        """;

    // Последнее задание лота и вида, живое или сработавшее, под блокировкой: с
    // ней поздняя отметка и срабатывание не разминутся. Срабатывание,
    // захватившее строку раньше, отметка ждёт и видит уже «сработало»; отметку,
    // взявшую строку раньше, ждёт захват срабатывания, и его разворот следящих
    // её видит. Живого задания после сработавшего не бывает.
    private const string LockLatestSql = """
        SELECT task_id AS TaskId, kind AS Kind, state = 'fired' AS Fired
        FROM lot_reminder_task
        WHERE lot_id = @LotId AND kind = @Kind AND state IN ('scheduled', 'fired')
        ORDER BY created_at DESC
        LIMIT 1
        FOR SHARE;
        """;

    /// <summary>Живое задание лота и вида, если оно есть.</summary>
    public async Task<LiveLotReminderTask?> Live(Guid lotId, LotReminderKind kind, CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        var row = await connection.QuerySingleOrDefaultAsync<LiveRow>(
            new CommandDefinition(
                LiveSql,
                new { LotId = lotId, Kind = LotReminderKinds.Text(kind) },
                cancellationToken: cancellationToken));

        return row is null
            ? null
            : new LiveLotReminderTask(row.task_id, LotReminderKinds.Parse(row.kind), Moment(row.deadline), Moment(row.due_at));
    }

    /// <summary>По этому лоту и виду напоминание уже срабатывало.</summary>
    public async Task<bool> FiredEver(Guid lotId, LotReminderKind kind, CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        return await connection.ExecuteScalarAsync<bool>(
            new CommandDefinition(
                FiredEverSql,
                new { LotId = lotId, Kind = LotReminderKinds.Text(kind) },
                cancellationToken: cancellationToken));
    }

    /// <summary>Заводит задание. Возвращает его идентификатор.</summary>
    public async Task<Guid> Create(
        Guid lotId,
        LotReminderKind kind,
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
                new
                {
                    TaskId = taskId,
                    LotId = lotId,
                    Kind = LotReminderKinds.Text(kind),
                    Deadline = deadline.UtcDateTime,
                    DueAt = dueAt.UtcDateTime,
                    Now = now.UtcDateTime,
                },
                cancellationToken: cancellationToken));

        return taskId;
    }

    /// <summary>Замещает живое задание новым: обе строки меняются одной транзакцией.</summary>
    public async Task<Guid> Supersede(
        Guid liveTaskId,
        Guid lotId,
        LotReminderKind kind,
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
                new
                {
                    TaskId = taskId,
                    LotId = lotId,
                    Kind = LotReminderKinds.Text(kind),
                    Deadline = deadline.UtcDateTime,
                    DueAt = dueAt.UtcDateTime,
                    Now = now.UtcDateTime,
                },
                transaction,
                cancellationToken: cancellationToken));

        await transaction.CommitAsync(cancellationToken);
        telemetry.Remove(removed, "superseded");

        return taskId;
    }

    /// <summary>Снимает живое задание лота и вида. Возвращает число снятых строк.</summary>
    public async Task<int> Cancel(Guid lotId, LotReminderKind kind, string reason, CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        var removed = await connection.ExecuteAsync(
            new CommandDefinition(
                CancelSql,
                new { LotId = lotId, Kind = LotReminderKinds.Text(kind), Reason = reason },
                cancellationToken: cancellationToken));

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

        var facts = await NotificationStore.AddLotReminder(work, task.TaskId, task.Kind, lotId, task.Deadline, now,
            cancellationToken);

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

    /// <summary>
    /// Напоминание человеку, который отметил лот позже часового срабатывания
    /// (PER-647), в транзакции <paramref name="work" /> самой отметки.
    /// </summary>
    /// <remarks>
    /// Повод — ближний момент, а не часовой: его задание и его срабатывание
    /// несут один ключ, поэтому человек получит одно сообщение, а не два
    /// (ADR-063, дополнение 2026-10-20). Часовое задание при этом сработало:
    /// пока оно живо, человек попадёт в его разворот сам, и досрочного сообщения
    /// не нужно. Второго задания у лота нет — у лота, заведённого до этого
    /// дополнения, — и тогда повод остаётся часовым.
    /// </remarks>
    public static async Task<FactCount> RemindLateFollower(
        UnitOfWork work,
        Guid identityId,
        Guid lotId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var hour = (await work.Query<LatestRow>(
            LockLatestSql,
            new { LotId = lotId, Kind = LotReminderKinds.Text(LotReminderKind.Hour) },
            cancellationToken)).SingleOrDefault();
        if (hour is not { Fired: true })
        {
            return FactCount.None;
        }

        var close = (await work.Query<LatestRow>(
            LockLatestSql,
            new { LotId = lotId, Kind = LotReminderKinds.Text(LotReminderKind.Close) },
            cancellationToken)).SingleOrDefault();

        return close is null
            ? await NotificationStore.AddLateLotReminder(work, hour.TaskId, LotReminderKind.Hour, lotId, identityId, now,
                cancellationToken)
            : await NotificationStore.AddLateLotReminder(work, close.TaskId, LotReminderKind.Close, lotId, identityId, now,
                cancellationToken);
    }

    // timestamptz читается как DateTime, а не DateTimeOffset — так его отображает
    // Npgsql. Перевод идёт через ToUniversalTime, как в ReminderTaskStore.
    private sealed record LiveRow(Guid task_id, string kind, DateTime deadline, DateTime due_at);

    private sealed record LatestRow(Guid TaskId, string Kind, bool Fired);

    private static DateTimeOffset Moment(DateTime value) => new(value.ToUniversalTime());
}
