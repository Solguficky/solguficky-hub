using Dapper;
using Npgsql;

namespace Notifications.Infrastructure;

/// <summary>Наступившее задание напоминания: сходки или лота. Заполнено ровно одно поле.</summary>
public sealed record DueReminder(Guid TaskId, string? MeetupId, Guid? LotId);

/// <summary>Возраст самого старого наступившего задания каждой таблицы, в секундах.</summary>
public sealed record OldestDue(double MeetupSeconds, double LotSeconds);

/// <summary>
/// Выборка наступивших заданий напоминания — сходок и лота — одним запросом на
/// чтение.
/// </summary>
/// <remarks>
/// Оба чтения, «наступившие» и «самый старый наступивший», охватывают обе
/// таблицы сразу, а не по одной на таблицу. Проход sweeper'а — периодический
/// потребитель соединений, и лишние открытия к общей базе интеграционного
/// набора доводили её до предела соединений PostgreSQL; цена второго запроса на
/// таблицу оказалась выше цены UNION. Читает проход по очереди на одном
/// соединении из пула, поэтому пиковой параллельности не множит.
/// </remarks>
public sealed class ReminderDueStore(NpgsqlDataSource source)
{
    private const string DueSql = """
        SELECT task_id, subject, is_meetup, due_at
        FROM (
            SELECT task_id, meetup_id::text AS subject, due_at, TRUE AS is_meetup
            FROM reminder_task
            WHERE state = 'scheduled' AND due_at <= @Now
            UNION ALL
            SELECT task_id, lot_id::text AS subject, due_at, FALSE AS is_meetup
            FROM lot_reminder_task
            WHERE state = 'scheduled' AND due_at <= @Now
        ) AS due
        ORDER BY due_at
        LIMIT @Limit;
        """;

    private const string OldestDueSql = """
        SELECT MIN(due_at) FILTER (WHERE is_meetup) AS OldestMeetup,
               MIN(due_at) FILTER (WHERE NOT is_meetup) AS OldestLot
        FROM (
            SELECT due_at, TRUE AS is_meetup FROM reminder_task WHERE state = 'scheduled' AND due_at <= @Now
            UNION ALL
            SELECT due_at, FALSE AS is_meetup FROM lot_reminder_task WHERE state = 'scheduled' AND due_at <= @Now
        ) AS due;
        """;

    /// <summary>Наступившие задания обеих таблиц, самые ранние первыми.</summary>
    public async Task<IReadOnlyList<DueReminder>> Due(DateTimeOffset now, int limit, CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        var rows = await connection.QueryAsync<DueRow>(
            new CommandDefinition(DueSql, new { Now = now.UtcDateTime, Limit = limit }, cancellationToken: cancellationToken));

        return rows.Select(row => row.is_meetup
            ? new DueReminder(row.task_id, row.subject, null)
            : new DueReminder(row.task_id, null, Guid.Parse(row.subject))).ToList();
    }

    /// <summary>Возраст самого старого наступившего задания по каждой таблице.</summary>
    public async Task<OldestDue> OldestDueAgeSeconds(DateTimeOffset now, CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        var row = await connection.QuerySingleAsync<OldestRow>(
            new CommandDefinition(OldestDueSql, new { Now = now.UtcDateTime }, cancellationToken: cancellationToken));

        return new OldestDue(Age(now, row.OldestMeetup), Age(now, row.OldestLot));
    }

    private static double Age(DateTimeOffset now, DateTime? oldest) =>
        oldest is null ? 0 : Math.Max(0, (now.UtcDateTime - oldest.Value.ToUniversalTime()).TotalSeconds);

    private sealed record DueRow(Guid task_id, string subject, bool is_meetup, DateTime due_at);

    private sealed record OldestRow(DateTime? OldestMeetup, DateTime? OldestLot);
}
