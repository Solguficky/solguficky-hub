namespace Notifications.Infrastructure;

/// <summary>
/// Отметки «человек следит за лотом» (ADR-063). Снятая отметка остаётся строкой
/// с <c>removed_at</c>: она помнит снятие до конца срока хранения.
/// </summary>
/// <remarks>
/// Правило «отметка по ставке, только если не было ни отметки, ни снятия»
/// держит первичный ключ одной вставкой, а не чтение перед записью: повтор
/// события, следующая ставка и старый <c>bid_placed</c> гаснут на конфликте с
/// любой строкой, живой или снятой, в том числе у второго экземпляра сервиса.
/// </remarks>
public static class FavoriteStore
{
    private const string AutoFollowSql = """
        INSERT INTO lot_favorite (identity_id, lot_id, followed_at)
        VALUES (@IdentityId, @LotId, @Now)
        ON CONFLICT (identity_id, lot_id) DO NOTHING;
        """;

    // Блокировка строки реплики держит её от чистки, пока ручная отметка не
    // закоммичена: иначе отметка пережила бы удалённую реплику и не вычистилась
    // бы никогда.
    private const string KnownLotSql = """
        SELECT lot_id FROM lot_replica WHERE lot_id = @LotId FOR SHARE;
        """;

    // Повторная отметка ничего не меняет, а снятая возвращается с новым
    // моментом: только так снятие и отменяется.
    private const string FollowSql = """
        INSERT INTO lot_favorite (identity_id, lot_id, followed_at)
        VALUES (@IdentityId, @LotId, @Now)
        ON CONFLICT (identity_id, lot_id) DO UPDATE SET followed_at = EXCLUDED.followed_at, removed_at = NULL
        WHERE lot_favorite.removed_at IS NOT NULL;
        """;

    // Снятие лота, который человек не отмечал, строки не заводит: запрета
    // автодобавления без отметки ADR-063 не обещает.
    private const string UnfollowSql = """
        UPDATE lot_favorite SET removed_at = @Now
        WHERE identity_id = @IdentityId AND lot_id = @LotId AND removed_at IS NULL;
        """;

    private const string FollowingSql = """
        SELECT EXISTS (
            SELECT 1 FROM lot_favorite
            WHERE identity_id = @IdentityId AND lot_id = @LotId AND removed_at IS NULL);
        """;

    private const string ListSql = """
        SELECT lot_id FROM lot_favorite
        WHERE identity_id = @IdentityId AND removed_at IS NULL
        ORDER BY followed_at, lot_id;
        """;

    // Две инструкции, а не одна: удаление реплики ждёт ручную отметку, которая
    // держит её строку, и только следующая инструкция видит эту отметку
    // закоммиченной.
    private const string PruneReplicaSql = """
        DELETE FROM lot_replica WHERE terminal_at < @Threshold RETURNING lot_id;
        """;

    private const string PruneFavoritesSql = """
        DELETE FROM lot_favorite WHERE lot_id = ANY(@LotIds);
        """;

    /// <summary>Отметка лидеру ставки, если на этом лоте у него нет ни отметки, ни снятия.</summary>
    public static Task AutoFollow(UnitOfWork work, Guid identityId, Guid lotId, DateTimeOffset now,
        CancellationToken cancellationToken) =>
        work.Execute(AutoFollowSql, new { IdentityId = identityId, LotId = lotId, Now = now.UtcDateTime },
            cancellationToken);

    public static async Task<bool> KnownLot(UnitOfWork work, Guid lotId, CancellationToken cancellationToken) =>
        (await work.Query<Guid>(KnownLotSql, new { LotId = lotId }, cancellationToken)).Count > 0;

    public static Task Follow(UnitOfWork work, Guid identityId, Guid lotId, DateTimeOffset now,
        CancellationToken cancellationToken) =>
        work.Execute(FollowSql, new { IdentityId = identityId, LotId = lotId, Now = now.UtcDateTime }, cancellationToken);

    public static Task Unfollow(UnitOfWork work, Guid identityId, Guid lotId, DateTimeOffset now,
        CancellationToken cancellationToken) =>
        work.Execute(UnfollowSql, new { IdentityId = identityId, LotId = lotId, Now = now.UtcDateTime }, cancellationToken);

    public static Task<bool> Following(UnitOfWork work, Guid identityId, Guid lotId,
        CancellationToken cancellationToken) =>
        work.Scalar(FollowingSql, new { IdentityId = identityId, LotId = lotId }, cancellationToken);

    public static Task<IReadOnlyList<Guid>> List(UnitOfWork work, Guid identityId,
        CancellationToken cancellationToken) =>
        work.Query<Guid>(ListSql, new { IdentityId = identityId }, cancellationToken);

    /// <summary>
    /// Удаляет реплики лотов, конечное положение которых старше порога, и все
    /// отметки этих лотов, снятые и нет. Возвращает число удалённых лотов.
    /// </summary>
    public static async Task<int> Prune(UnitOfWork work, DateTimeOffset threshold, CancellationToken cancellationToken)
    {
        var lots = await work.Query<Guid>(PruneReplicaSql, new { Threshold = threshold.UtcDateTime }, cancellationToken);
        if (lots.Count > 0)
        {
            await work.Execute(PruneFavoritesSql, new { LotIds = lots.ToArray() }, cancellationToken);
        }
        return lots.Count;
    }
}
