using Dapper;
using Npgsql;
using Notifications.Facts;
using Notifications.Reminders;

namespace Notifications.Infrastructure;

/// <summary>Живое задание сходки: то, что нужно ядру для решения.</summary>
public sealed record LiveReminderTask(Guid TaskId, DateTimeOffset StartsAt, DateTimeOffset DueAt);

/// <summary>Наступившее задание, которое предстоит исполнить.</summary>
public sealed record DueReminderTask(Guid TaskId, string MeetupId);

/// <summary>
/// Доступ к таблице заданий напоминания. Dapper поверх Npgsql — набор
/// <c>docs/standards/data/postgresql.md</c>, тот же, что у соседней
/// <see cref="GrainActivationStore" />.
/// </summary>
/// <remarks>
/// Здесь нет ни одного решения о том, нужно ли задание: их принимает
/// <c>ReminderPlan</c>. Этот класс только пишет и читает строки.
/// </remarks>
public sealed class ReminderTaskStore(NpgsqlDataSource source, ReminderTelemetry telemetry)
{
    private const string LiveSql = """
        SELECT task_id, starts_at, due_at
        FROM reminder_task
        WHERE meetup_id = @MeetupId AND state = 'scheduled';
        """;

    private const string FiredForSql = """
        SELECT EXISTS (
            SELECT 1 FROM reminder_task
            WHERE meetup_id = @MeetupId AND starts_at = @StartsAt AND state = 'fired'
        );
        """;

    private const string InsertSql = """
        INSERT INTO reminder_task (task_id, meetup_id, starts_at, due_at, state, created_at)
        VALUES (@TaskId, @MeetupId, @StartsAt, @DueAt, 'scheduled', @Now);
        """;

    private const string SupersedeSql = """
        UPDATE reminder_task
        SET state = 'superseded', superseded_by = @NewTaskId, reason = @Reason
        WHERE task_id = @TaskId AND state = 'scheduled';
        """;

    private const string CancelSql = """
        UPDATE reminder_task
        SET state = 'cancelled', reason = @Reason
        WHERE meetup_id = @MeetupId AND state = 'scheduled';
        """;

    private const string DueSql = """
        SELECT task_id, meetup_id
        FROM reminder_task
        WHERE state = 'scheduled' AND due_at <= @Now
        ORDER BY due_at
        LIMIT @Limit;
        """;

    private const string OldestDueSql = """
        SELECT MIN(due_at)
        FROM reminder_task
        WHERE state = 'scheduled' AND due_at <= @Now;
        """;

    private const string FireSql = """
        UPDATE reminder_task
        SET state = 'fired', fired_at = @Now
        WHERE task_id = @TaskId AND state = 'scheduled';
        """;

    private const string OccasionSql = """
        INSERT INTO notification_occasion (occasion_id, task_id, meetup_id, occurred_at)
        SELECT @OccasionId, task_id, meetup_id, @Now
        FROM reminder_task
        WHERE task_id = @TaskId;
        """;

    /// <summary>Живое задание сходки, если оно есть.</summary>
    public async Task<LiveReminderTask?> Live(string meetupId, CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        var row = await connection.QuerySingleOrDefaultAsync<LiveRow>(
            new CommandDefinition(LiveSql, new { MeetupId = meetupId }, cancellationToken: cancellationToken));

        return row is null ? null : new LiveReminderTask(row.task_id, Moment(row.starts_at), Moment(row.due_at));
    }

    /// <summary>По этому моменту начала напоминание уже срабатывало.</summary>
    public async Task<bool> FiredFor(string meetupId, DateTimeOffset startsAt, CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        return await connection.ExecuteScalarAsync<bool>(
            new CommandDefinition(
                FiredForSql,
                new { MeetupId = meetupId, StartsAt = startsAt.UtcDateTime },
                cancellationToken: cancellationToken));
    }

    /// <summary>Заводит задание. Возвращает его идентификатор.</summary>
    public async Task<Guid> Create(
        string meetupId,
        DateTimeOffset startsAt,
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
                    MeetupId = meetupId,
                    StartsAt = startsAt.UtcDateTime,
                    DueAt = dueAt.UtcDateTime,
                    Now = now.UtcDateTime,
                },
                cancellationToken: cancellationToken));

        return taskId;
    }

    /// <summary>
    /// Замещает живое задание новым: обе строки меняются одной транзакцией.
    /// </summary>
    /// <remarks>
    /// Транзакция здесь несущая, а не косметическая. Частичный уникальный индекс
    /// пропускает ровно одно живое задание на сходку, поэтому вставка нового до
    /// снятия прежнего отвергается схемой, а снятие без вставки оставило бы
    /// сходку без напоминания. Разрыв между двумя запросами — это либо отказ,
    /// либо молча потерянное напоминание, и оба исхода закрывает транзакция.
    ///
    /// Число снятых строк не проверяется, и это осознанно. Ноль означал бы, что
    /// прежнее задание перестало быть живым между чтением и записью; внутри
    /// одной сходки такого не бывает — обе операции идут через её грин, а
    /// активация у него одна. Но даже случись это, исход верен: прежнее
    /// задание в терминальном состоянии, новое создано на новый момент, и
    /// ссылка на преемника «сработавшему» заданию не положена по схеме.
    /// </remarks>
    public async Task<Guid> Supersede(
        Guid liveTaskId,
        string meetupId,
        DateTimeOffset startsAt,
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
                    MeetupId = meetupId,
                    StartsAt = startsAt.UtcDateTime,
                    DueAt = dueAt.UtcDateTime,
                    Now = now.UtcDateTime,
                },
                transaction,
                cancellationToken: cancellationToken));

        await transaction.CommitAsync(cancellationToken);
        telemetry.Remove(removed, "superseded");

        return taskId;
    }

    /// <summary>Снимает живое задание сходки. Возвращает число снятых строк.</summary>
    public async Task<int> Cancel(string meetupId, string reason, CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        var removed = await connection.ExecuteAsync(
            new CommandDefinition(
                CancelSql,
                new { MeetupId = meetupId, Reason = reason },
                cancellationToken: cancellationToken));

        telemetry.Remove(removed, "cancelled");
        return removed;
    }

    /// <summary>Наступившие задания среди живых.</summary>
    public async Task<IReadOnlyList<DueReminderTask>> Due(
        DateTimeOffset now,
        int limit,
        CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        var rows = await connection.QueryAsync<DueRow>(
            new CommandDefinition(
                DueSql,
                new { Now = now.UtcDateTime, Limit = limit },
                cancellationToken: cancellationToken));

        return rows.Select(row => new DueReminderTask(row.task_id, row.meetup_id)).ToList();
    }

    /// <summary>Возраст самого старого наступившего, но ещё живого задания.</summary>
    public async Task<double> OldestDueAgeSeconds(DateTimeOffset now, CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        var oldest = await connection.ExecuteScalarAsync<DateTime?>(
            new CommandDefinition(
                OldestDueSql,
                new { Now = now.UtcDateTime },
                cancellationToken: cancellationToken));

        return oldest is null ? 0 : Math.Max(0, (now.UtcDateTime - oldest.Value.ToUniversalTime()).TotalSeconds);
    }

    /// <summary>
    /// Исполняет задание: переводит в «сработало», порождает повод и
    /// разворачивает его на подписчиков адресными фактами. Возвращает число
    /// фактов, если исполнил именно этот вызов, и <c>null</c>, если нет.
    /// </summary>
    /// <remarks>
    /// Идемпотентность держится условием <c>state = 'scheduled'</c>, а не
    /// проверкой перед записью: проверка и запись разными запросами — это гонка,
    /// в которой оба участника видят «ещё не сработало». Проигравший получает
    /// ноль изменённых строк и выходит, не породив второго повода. Отсюда же
    /// берётся исполнение «немедленно» для уже наступившего момента: никакого
    /// отдельного пути для просроченного задания нет, оно просто попадает в
    /// ближайшую выборку.
    ///
    /// Факты пишутся той же транзакцией, что и захват: сработавшее задание без
    /// фактов или факты без сработавшего задания означали бы потерянное или
    /// дважды отправленное напоминание. Отдельного журнала отправленного нет —
    /// его роль играет само задание (docs/services/notifications.md).
    /// </remarks>
    public async Task<FactCount?> Fire(
        LiveReminderTask task,
        string meetupId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);

        var claimed = await work.Execute(FireSql, new { task.TaskId, Now = now.UtcDateTime }, cancellationToken);

        if (claimed == 0)
        {
            // Ничего не записано, фиксировать нечего: откат при разборе.
            return null;
        }

        await work.Execute(
            OccasionSql,
            new { OccasionId = Guid.NewGuid(), task.TaskId, Now = now.UtcDateTime },
            cancellationToken);

        var facts = await NotificationStore.AddMeetupReminder(
            work,
            task.TaskId,
            Guid.Parse(meetupId),
            task.StartsAt,
            now,
            cancellationToken);

        await work.Commit(cancellationToken);
        telemetry.Fire();
        return facts;
    }

    // Имена полей совпадают с колонками: Dapper сопоставляет по имени.
    //
    // timestamptz читается как DateTime, а не DateTimeOffset — так его отображает
    // Npgsql, и запись с DateTimeOffset Dapper материализовать не может вовсе.
    // Перевод идёт через ToUniversalTime, как в GrainActivationStore.
    private sealed record LiveRow(Guid task_id, DateTime starts_at, DateTime due_at);

    private sealed record DueRow(Guid task_id, string meetup_id);

    private static DateTimeOffset Moment(DateTime value) => new(value.ToUniversalTime());
}
