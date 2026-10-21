using Dapper;
using Npgsql;

namespace Notifications.Infrastructure;

/// <summary>Наступившее задание напоминания: сходки, лота или окна. Заполнено ровно одно поле.</summary>
public sealed record DueReminder(Guid TaskId, string? MeetupId, Guid? LotId, Guid? WindowAuctionId);

/// <summary>Возраст самого старого наступившего задания каждой таблицы, в секундах.</summary>
public sealed record OldestDue(double MeetupSeconds, double LotSeconds, double WindowSeconds);

/// <summary>
/// Выборка наступивших заданий напоминания — сходок, лота и окна начала
/// сниженного шага — одним запросом на чтение.
/// </summary>
/// <remarks>
/// Все чтения, «наступившие» и «самый старый наступивший», охватывают все
/// таблицы сразу, а не по одной на таблицу. Проход sweeper'а — периодический
/// потребитель соединений, и лишние открытия к общей базе интеграционного
/// набора доводили её до предела соединений PostgreSQL; цена второго запроса на
/// таблицу оказалась выше цены UNION. Читает проход по очереди на одном
/// соединении из пула, поэтому пиковой параллельности не множит.
/// </remarks>
public sealed class ReminderDueStore(NpgsqlDataSource source)
{
    private const string DueSql = """
        SELECT task_id, subject, kind, due_at
        FROM (
            SELECT task_id, meetup_id::text AS subject, 'meetup' AS kind, due_at
            FROM reminder_task
            WHERE state = 'scheduled' AND due_at <= @Now
            UNION ALL
            SELECT task_id, lot_id::text AS subject, 'lot' AS kind, due_at
            FROM lot_reminder_task
            WHERE state = 'scheduled' AND due_at <= @Now
            UNION ALL
            SELECT task_id, auction_id::text AS subject, 'window' AS kind, due_at
            FROM step_window_task
            WHERE state = 'scheduled' AND due_at <= @Now
        ) AS due
        ORDER BY due_at
        LIMIT @Limit;
        """;

    private const string OldestDueSql = """
        SELECT MIN(due_at) FILTER (WHERE kind = 'meetup') AS OldestMeetup,
               MIN(due_at) FILTER (WHERE kind = 'lot') AS OldestLot,
               MIN(due_at) FILTER (WHERE kind = 'window') AS OldestWindow
        FROM (
            SELECT due_at, 'meetup' AS kind FROM reminder_task WHERE state = 'scheduled' AND due_at <= @Now
            UNION ALL
            SELECT due_at, 'lot' AS kind FROM lot_reminder_task WHERE state = 'scheduled' AND due_at <= @Now
            UNION ALL
            SELECT due_at, 'window' AS kind FROM step_window_task WHERE state = 'scheduled' AND due_at <= @Now
        ) AS due;
        """;

    /// <summary>Наступившие задания всех таблиц, самые ранние первыми.</summary>
    public async Task<IReadOnlyList<DueReminder>> Due(DateTimeOffset now, int limit, CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        var rows = await connection.QueryAsync<DueRow>(
            new CommandDefinition(DueSql, new { Now = now.UtcDateTime, Limit = limit }, cancellationToken: cancellationToken));

        return rows.Select(row => row.kind switch
        {
            "meetup" => new DueReminder(row.task_id, row.subject, null, null),
            "lot" => new DueReminder(row.task_id, null, Guid.Parse(row.subject), null),
            "window" => new DueReminder(row.task_id, null, null, Guid.Parse(row.subject)),
            _ => throw new ArgumentOutOfRangeException(nameof(row), row.kind, "unknown reminder task kind"),
        }).ToList();
    }

    /// <summary>Возраст самого старого наступившего задания по каждой таблице.</summary>
    public async Task<OldestDue> OldestDueAgeSeconds(DateTimeOffset now, CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        var row = await connection.QuerySingleAsync<OldestRow>(
            new CommandDefinition(OldestDueSql, new { Now = now.UtcDateTime }, cancellationToken: cancellationToken));

        return new OldestDue(Age(now, row.OldestMeetup), Age(now, row.OldestLot), Age(now, row.OldestWindow));
    }

    private static double Age(DateTimeOffset now, DateTime? oldest) =>
        oldest is null ? 0 : Math.Max(0, (now.UtcDateTime - oldest.Value.ToUniversalTime()).TotalSeconds);

    private sealed record DueRow(Guid task_id, string subject, string kind, DateTime due_at);

    private sealed record OldestRow(DateTime? OldestMeetup, DateTime? OldestLot, DateTime? OldestWindow);
}
