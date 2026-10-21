using Notifications.Infrastructure;

namespace Notifications.Auction;

/// <summary>
/// Выключатель вестей о новом аукционе и открытии торгов (PER-646): настройка
/// уведомлений аукциона рядом с анонсом финала, а не категория общих настроек
/// (PER-539, RFC-015 О-12). Нет строки — действует умолчание «присылать»,
/// поэтому строки появляются только у тех, кто выключатель трогал.
/// </summary>
public static class AuctionAnnouncementStore
{
    /// <summary>Умолчание продукта: вести приходят, пока человек их не выключил.</summary>
    public const bool Default = true;

    private const string ReadSql = """
        SELECT enabled FROM auction_announcement_preference WHERE identity_id = @IdentityId;
        """;

    private const string SetSql = """
        INSERT INTO auction_announcement_preference (identity_id, enabled, updated_at)
        VALUES (@IdentityId, @Enabled, @UpdatedAt)
        ON CONFLICT (identity_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at;
        """;

    /// <summary>Выключатель вестей; <c>null</c> — человек его не трогал.</summary>
    public static async Task<bool?> Read(UnitOfWork work, Guid identityId, CancellationToken cancellationToken)
    {
        var rows = await work.Query<bool>(ReadSql, new { IdentityId = identityId }, cancellationToken);
        return rows.Count == 0 ? null : rows[0];
    }

    public static Task Set(UnitOfWork work, Guid identityId, bool enabled, DateTimeOffset now,
        CancellationToken cancellationToken) =>
        work.Execute(SetSql, new { IdentityId = identityId, Enabled = enabled, UpdatedAt = now.UtcDateTime },
            cancellationToken);
}
