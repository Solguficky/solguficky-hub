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

    /// <summary>
    /// Снимает ключи каждого источника по его порогу: срок ключа — срок его
    /// стрима (PER-761), и ключ аукциона живёт дольше ключа сходки.
    /// </summary>
    public async Task<int> Prune(IReadOnlyDictionary<string, DateTimeOffset> thresholds, CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        var removed = 0;
        foreach (var (eventSource, threshold) in thresholds)
        {
            removed += await work.Execute("DELETE FROM consumed_event WHERE source = @Source AND consumed_at < @Threshold;",
                new { Source = eventSource, Threshold = threshold.UtcDateTime }, cancellationToken);
        }

        await work.Commit(cancellationToken);
        return removed;
    }
}
