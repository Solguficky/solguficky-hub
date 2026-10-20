namespace Notifications.Infrastructure;

public static class FinalOutbidStore
{
    private const string ReadSql = """
        SELECT enabled FROM final_outbid_preference WHERE identity_id = @IdentityId;
        """;

    private const string SetSql = """
        INSERT INTO final_outbid_preference (identity_id, enabled, updated_at)
        VALUES (@IdentityId, @Enabled, @UpdatedAt)
        ON CONFLICT (identity_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at;
        """;

    public static async Task<bool?> ReadEnabled(UnitOfWork work, Guid identityId,
        CancellationToken cancellationToken)
    {
        var rows = await work.Query<bool>(ReadSql, new { IdentityId = identityId }, cancellationToken);
        return rows.Count == 0 ? null : rows[0];
    }

    public static Task SetEnabled(UnitOfWork work, Guid identityId, bool enabled, DateTimeOffset now,
        CancellationToken cancellationToken) =>
        work.Execute(SetSql, new { IdentityId = identityId, Enabled = enabled, UpdatedAt = now.UtcDateTime },
            cancellationToken);
}
