using Dapper;
using Npgsql;
using Notifications.Facts;
using Notifications.Reminders;

namespace Notifications.Infrastructure;

/// <summary>Живое задание начала окна: то, что нужно ядру для решения.</summary>
public sealed record LiveStepWindowTask(Guid TaskId, Guid AuctionId, DateTimeOffset StartsAt, DateTimeOffset DueAt);

/// <summary>Исход исполнения задания начала окна.</summary>
public enum StepWindowFireOutcome
{
    /// <summary>Задание исполнено: факты записаны, повтор не даст второго.</summary>
    Sent,

    /// <summary>Задание исполнил кто-то другой: захват не достался этому вызову.</summary>
    AlreadyFired,
}

/// <summary>
/// Факты одного начала окна: весть следящим за его лотами и общая весть
/// остальным держателям права ставок (ADR-047, дополнение 2026-10-27).
/// </summary>
public sealed record StepWindowStartFacts(FactCount Started, FactCount Announced)
{
    public static readonly StepWindowStartFacts None = new(FactCount.None, FactCount.None);
}

/// <summary>Исход исполнения и записанные факты.</summary>
public sealed record StepWindowFireResult(StepWindowFireOutcome Outcome, StepWindowStartFacts Facts);

/// <summary>
/// Доступ к таблице заданий начала окна сниженного шага. Dapper поверх Npgsql —
/// тот же набор, что у соседних <see cref="LotReminderTaskStore" /> и
/// <see cref="ReminderTaskStore" />.
/// </summary>
/// <remarks>
/// Одно задание на аукцион и момент начала, и это ограничение схемы, а не
/// соглашение в коде: факты лотов одного окна приходят по одному и порождают
/// одно и то же задание, а повторный факт после срабатывания не заводит
/// второго. Класс только пишет и читает строки; решение о моменте принимает
/// <see cref="StepWindowPlan" />.
/// </remarks>
public sealed class StepWindowTaskStore(NpgsqlDataSource source, StepWindowTelemetry telemetry)
{
    // Конфликт по паре «аукцион и начало» — не ошибка, а повторный факт того же
    // окна или сработавшее задание: оба исхода значат «делать нечего». Задание,
    // снятое потому, что окон этого начала не осталось, окно того же начала,
    // заданное снова до него, возвращает в расписание с новым моментом
    // (PER-788): условия лотов в периоде меняются до его начала (PER-786).
    private const string InsertSql = """
        INSERT INTO step_window_task (task_id, auction_id, starts_at, due_at, state, created_at)
        VALUES (@TaskId, @AuctionId, @StartsAt, @DueAt, 'scheduled', @Now)
        ON CONFLICT (auction_id, starts_at) DO UPDATE SET
            state = 'scheduled',
            due_at = EXCLUDED.due_at,
            reason = NULL
        WHERE step_window_task.state = 'cancelled' AND step_window_task.reason = @WindowGone;
        """;

    private const string DueSql = """
        SELECT task_id, auction_id, starts_at, due_at
        FROM step_window_task
        WHERE auction_id = @AuctionId AND state = 'scheduled' AND due_at <= @Now
        ORDER BY due_at;
        """;

    // Исполнение держится условием state = 'scheduled', а не проверкой перед
    // записью: проверка и запись разными запросами — гонка, в которой оба
    // участника видят «ещё не сработало».
    private const string FireSql = """
        UPDATE step_window_task
        SET state = 'fired', fired_at = @Now
        WHERE task_id = @TaskId AND state = 'scheduled';
        """;

    private const string CancelSql = """
        UPDATE step_window_task
        SET state = 'cancelled', reason = @Reason
        WHERE auction_id = @AuctionId AND state = 'scheduled';
        """;

    // Снимает несработавшие задания аукциона, у начала которых не осталось ни
    // одного окна у лота в торгах (PER-788): условия лота в периоде сняты или
    // период удалён до начала. Сверка идёт по репликам, а не по факту одного
    // лота: окно того же начала может остаться у другого лота. Момент окна в
    // строке реплики записан с точностью базы, как начало задания.
    private const string CancelGoneSql = """
        UPDATE step_window_task AS task
        SET state = 'cancelled', reason = @WindowGone
        WHERE task.auction_id = @AuctionId AND task.state = 'scheduled'
            AND NOT EXISTS (
                SELECT 1
                FROM lot_replica AS replica,
                     jsonb_array_elements(replica.step_windows) AS window_row
                WHERE replica.auction_id = @AuctionId
                    AND replica.status = 'trading'
                    AND (window_row ->> 'from')::timestamptz = task.starts_at);
        """;

    /// <summary>Причина снятия задания, у начала которого не осталось окон; такое задание возвращается.</summary>
    private const string WindowGone = "window gone";

    private const string NextDueSql = """
        SELECT MIN(due_at) FROM step_window_task
        WHERE auction_id = @AuctionId AND state = 'scheduled';
        """;

    /// <summary>Заводит задание, если его ещё нет. Повтор и сработавшая строка ничего не меняют.</summary>
    public async Task Create(Guid auctionId, DateTimeOffset startsAt, DateTimeOffset dueAt, DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        var created = await connection.ExecuteAsync(
            new CommandDefinition(
                InsertSql,
                new
                {
                    TaskId = Guid.NewGuid(),
                    AuctionId = auctionId,
                    StartsAt = startsAt.UtcDateTime,
                    DueAt = dueAt.UtcDateTime,
                    Now = now.UtcDateTime,
                    WindowGone,
                },
                cancellationToken: cancellationToken));

        if (created > 0)
        {
            telemetry.Schedule();
        }
    }

    /// <summary>
    /// Снимает несработавшие задания аукциона, у начала которых не осталось
    /// окон у лотов в торгах. Возвращает, сколько снято.
    /// </summary>
    public async Task<int> CancelGone(Guid auctionId, CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        var cancelled = await connection.ExecuteAsync(
            new CommandDefinition(CancelGoneSql, new { AuctionId = auctionId, WindowGone },
                cancellationToken: cancellationToken));

        telemetry.Cancel(cancelled);

        return cancelled;
    }

    /// <summary>Наступившие задания аукциона: их может быть несколько, окна разные.</summary>
    public async Task<IReadOnlyList<LiveStepWindowTask>> Due(Guid auctionId, DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        var rows = await connection.QueryAsync<Row>(
            new CommandDefinition(DueSql, new { AuctionId = auctionId, Now = now.UtcDateTime },
                cancellationToken: cancellationToken));

        return rows.Select(row => new LiveStepWindowTask(row.task_id, row.auction_id, Moment(row.starts_at),
            Moment(row.due_at))).ToArray();
    }

    /// <summary>Ближайший момент живых заданий аукциона; <c>null</c> — живых нет.</summary>
    public async Task<DateTimeOffset?> NextDue(Guid auctionId, CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        var next = await connection.ExecuteScalarAsync<DateTime?>(
            new CommandDefinition(NextDueSql, new { AuctionId = auctionId }, cancellationToken: cancellationToken));

        return next is { } moment ? Moment(moment) : null;
    }

    /// <summary>
    /// Исполняет задание: переводит в «сработало» и разворачивает на следящих
    /// и на остальных держателей права ставок адресными фактами одной
    /// транзакцией.
    /// </summary>
    /// <remarks>
    /// Задание, чей аукцион уже кончился, исполняется без фактов: конец
    /// аукциона мог прийти между выборкой и захватом, и сообщение о начале
    /// окна отменённого аукциона было бы вестью о том, чего нет.
    /// </remarks>
    public async Task<StepWindowFireResult> Fire(LiveStepWindowTask task, DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);

        // Блокировка аукциона берётся до строки задания и до чтения реплик, в
        // том же порядке, что у факта лота: конец аукциона держит
        // исключительную, и только под ней чтение «аукцион кончился» и его
        // реплик что-то значит. Взять её позже — значит увидеть реплики ещё не
        // удалёнными и разослать начало окна отменяемого аукциона.
        await AuctionEndStore.LockShared(work, task.AuctionId, cancellationToken);

        var claimed = await work.Execute(FireSql, new { task.TaskId, Now = now.UtcDateTime }, cancellationToken);

        if (claimed == 0)
        {
            return new StepWindowFireResult(StepWindowFireOutcome.AlreadyFired, StepWindowStartFacts.None);
        }

        var facts = await NotificationStore.AddStepWindowStart(work, task, now, cancellationToken);

        await work.Commit(cancellationToken);
        telemetry.Fire();
        return new StepWindowFireResult(StepWindowFireOutcome.Sent, facts);
    }

    /// <summary>
    /// Снимает несработавшие задания аукциона: конец аукциона закрывает и окна
    /// его лотов. Сработавшие остаются историей, как у любого снятия.
    /// </summary>
    public static Task<int> CancelForAuction(UnitOfWork work, Guid auctionId, CancellationToken cancellationToken) =>
        work.Execute(CancelSql, new { AuctionId = auctionId, Reason = "auction ended" }, cancellationToken);

    // timestamptz читается как DateTime, а не DateTimeOffset — так его отображает
    // Npgsql. Перевод идёт через ToUniversalTime, как в LotReminderTaskStore.
    private sealed record Row(Guid task_id, Guid auction_id, DateTime starts_at, DateTime due_at);

    private static DateTimeOffset Moment(DateTime value) => new(value.ToUniversalTime());
}
