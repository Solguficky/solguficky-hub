using Notifications.Auction;

namespace Notifications.Infrastructure;

/// <summary>Последний записанный снимок лота.</summary>
public sealed record LotReplica(Guid LotId, long Version, LotStatus Status, DateTimeOffset? Deadline, Guid? Leader,
    DateTimeOffset? TerminalAt);

/// <summary>
/// Реплика лота из фактов AUCTION_EVENTS (ADR-063). Соединение и транзакцию
/// приносит <see cref="UnitOfWork" />: снимок коммитится вместе с ключом
/// события и поводами той же ставки или продажи.
/// </summary>
/// <remarks>
/// Порядок держит предикат <c>version &lt; EXCLUDED.version</c> в самом upsert,
/// как у реплики сходки: контракт порядка доставки не обещает, и проверка в C#
/// открыла бы гонку двух экземпляров на одном durable.
/// </remarks>
public static class LotReplicaStore
{
    // Момент конечного положения раз записанный не переписывается: старший
    // конечный снимок (продажа после удержания уже в финале) срок не сдвигает.
    private const string ApplySql = """
        INSERT INTO lot_replica (lot_id, version, status, deadline, leader_id, terminal_at, occurred_at, applied_at)
        VALUES (@LotId, @Version, @Status, @Deadline, @Leader, @TerminalAt, @OccurredAt, @Now)
        ON CONFLICT (lot_id) DO UPDATE SET
            version = EXCLUDED.version,
            status = EXCLUDED.status,
            deadline = EXCLUDED.deadline,
            leader_id = EXCLUDED.leader_id,
            terminal_at = CASE WHEN EXCLUDED.terminal_at IS NULL THEN NULL
                               ELSE COALESCE(lot_replica.terminal_at, EXCLUDED.terminal_at) END,
            occurred_at = EXCLUDED.occurred_at,
            applied_at = EXCLUDED.applied_at
        WHERE lot_replica.version < EXCLUDED.version;
        """;

    private const string ReadSql = """
        SELECT lot_id AS LotId, version AS Version, status AS Status, deadline AS Deadline,
               leader_id AS Leader, terminal_at AS TerminalAt
        FROM lot_replica
        WHERE lot_id = @LotId;
        """;

    /// <summary>Пишет снимок, если его версия старше записанной. Возвращает, записан ли он.</summary>
    public static async Task<bool> Apply(UnitOfWork work, LotSnapshot snapshot, DateTimeOffset now,
        CancellationToken cancellationToken) =>
        await work.Execute(ApplySql, new
        {
            snapshot.LotId,
            snapshot.Version,
            Status = Storage(snapshot.Status),
            Deadline = snapshot.Deadline?.UtcDateTime,
            snapshot.Leader,
            TerminalAt = snapshot.Terminal ? snapshot.OccurredAt.UtcDateTime : (DateTime?)null,
            OccurredAt = snapshot.OccurredAt.UtcDateTime,
            Now = now.UtcDateTime,
        }, cancellationToken) > 0;

    public static async Task<LotReplica?> Read(UnitOfWork work, Guid lotId, CancellationToken cancellationToken)
    {
        var rows = await work.Query<Row>(ReadSql, new { LotId = lotId }, cancellationToken);
        return rows.Select(row => new LotReplica(row.LotId, row.Version, FromStorage(row.Status),
            Utc(row.Deadline), row.Leader, Utc(row.TerminalAt))).SingleOrDefault();
    }

    public static string Storage(LotStatus status) => status switch
    {
        LotStatus.Draft => "draft",
        LotStatus.Scheduled => "scheduled",
        LotStatus.Trading => "trading",
        LotStatus.Held => "held",
        LotStatus.Sold => "sold",
        LotStatus.Unsold => "unsold",
        LotStatus.Withdrawn => "withdrawn",
        _ => throw new ArgumentOutOfRangeException(nameof(status)),
    };

    private static LotStatus FromStorage(string value) => value switch
    {
        "draft" => LotStatus.Draft,
        "scheduled" => LotStatus.Scheduled,
        "trading" => LotStatus.Trading,
        "held" => LotStatus.Held,
        "sold" => LotStatus.Sold,
        "unsold" => LotStatus.Unsold,
        "withdrawn" => LotStatus.Withdrawn,
        _ => throw new ArgumentOutOfRangeException(nameof(value)),
    };

    private static DateTimeOffset? Utc(DateTime? value) =>
        value is { } instant ? new DateTimeOffset(DateTime.SpecifyKind(instant, DateTimeKind.Utc)) : null;

    private sealed record Row(Guid LotId, long Version, string Status, DateTime? Deadline, Guid? Leader,
        DateTime? TerminalAt);
}
