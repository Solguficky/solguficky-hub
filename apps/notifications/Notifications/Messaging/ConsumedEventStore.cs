using Notifications.Infrastructure;
using Npgsql;

namespace Notifications.Messaging;

/// <summary>Общие ключи повтора; эффект модуль пишет в переданной транзакции.</summary>
public sealed class ConsumedEventStore(NpgsqlDataSource source)
{
    public static Task<int> Consume(UnitOfWork work, string source, Guid eventId, DateTimeOffset now, CancellationToken cancellationToken) =>
        work.Execute("""
            INSERT INTO consumed_event (source, event_id, consumed_at)
            VALUES (@Source, @EventId, @Now)
            ON CONFLICT (source, event_id) DO NOTHING;
            """, new { Source = source, EventId = eventId, Now = now.UtcDateTime }, cancellationToken);

    public async Task<int> Prune(DateTimeOffset threshold, CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        var removed = await work.Execute("DELETE FROM consumed_event WHERE consumed_at < @Threshold;",
            new { Threshold = threshold.UtcDateTime }, cancellationToken);
        await work.Commit(cancellationToken);
        return removed;
    }
}
