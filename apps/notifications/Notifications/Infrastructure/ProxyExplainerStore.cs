namespace Notifications.Infrastructure;

/// <summary>
/// Отметка «пояснение автоставки видено» (PER-517). Соединение и транзакцию
/// приносит <see cref="UnitOfWork" />.
/// </summary>
/// <remarks>
/// Момент первой отметки не переписывается: повтор после потерянного ответа
/// отметкой не является и ничего не меняет.
/// </remarks>
public static class ProxyExplainerStore
{
    private const string SeenSql = """
        SELECT EXISTS (SELECT 1 FROM proxy_explainer WHERE identity_id = @IdentityId);
        """;

    private const string MarkSql = """
        INSERT INTO proxy_explainer (identity_id, seen_at)
        VALUES (@IdentityId, @SeenAt)
        ON CONFLICT (identity_id) DO NOTHING;
        """;

    public static async Task<bool> Seen(UnitOfWork work, Guid identityId, CancellationToken cancellationToken)
    {
        var rows = await work.Query<bool>(SeenSql, new { IdentityId = identityId }, cancellationToken);
        return rows[0];
    }

    public static Task Mark(UnitOfWork work, Guid identityId, DateTimeOffset now,
        CancellationToken cancellationToken) =>
        work.Execute(MarkSql, new { IdentityId = identityId, SeenAt = now.UtcDateTime }, cancellationToken);
}
