using Auction.V1;
using Notifications.Auction;

namespace Notifications.Infrastructure;

/// <summary>Лот кончившегося аукциона, каким его оставила реплика: из него извещение об отмене берёт покупки.</summary>
public sealed record EndedLot(Guid LotId, LotStatus Status, Guid? Leader, Money? SalePrice);

/// <summary>Аукцион, пришедший в конечное положение; у отменённого — повод и сходка извещения.</summary>
public sealed record EndedAuction(AuctionEnd End, Guid EventId, Guid MeetupId);

/// <summary>
/// Конец аукциона для избранного (ADR-063, дополнение 2026-10-12, PER-604):
/// строка «аукцион закончен» и чистка реплик, отметок и несработавших заданий
/// напоминания его лотов.
/// </summary>
/// <remarks>
/// Факты лота и аукциона идут разными потоками, и ставка этого аукциона может
/// быть в полёте, когда приходит его конец. Строки «закончен» до первого конца
/// нет, поэтому блокировкой строки порядок не держится; его держит advisory
/// lock аукциона, как первую вставку человека держит ReplicaStore: факт лота
/// берёт разделяемую, конец аукциона — исключительную, первой инструкцией после
/// ключа события. Конец ждёт ставки в полёте и видит их отметки, а ставка после
/// конца ждёт его коммита и видит строку. Поэтому строку факт лота читает в C#
/// уже под блокировкой: записать её между чтением и записью некому.
/// </remarks>
public static class AuctionEndStore
{
    // Префикс отделяет ключ аукциона от ключа человека в ReplicaStore: коллизия
    // хэшей дала бы лишнее ожидание, а не ошибку, но без префикса их ровно две.
    private const string LockSharedSql =
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('auction:' || CAST(@AuctionId AS text), 0));";

    private const string LockSql =
        "SELECT pg_advisory_xact_lock(hashtextextended('auction:' || CAST(@AuctionId AS text), 0));";

    private const string ReadSql = """
        SELECT outcome AS Outcome, event_id AS EventId, meetup_id AS MeetupId
        FROM auction_ended
        WHERE auction_id = @AuctionId;
        """;

    private const string MarkSql = """
        INSERT INTO auction_ended (auction_id, outcome, event_id, meetup_id, recorded_at)
        VALUES (@AuctionId, @Outcome, @EventId, @MeetupId, @Now)
        ON CONFLICT (auction_id) DO NOTHING;
        """;

    // Реплика без аукциона — записанная до PER-604 — уходит по реестру снимка.
    // Удалённый аукцион чистит только реестр: факт лота нового рождения под тем
    // же auction_id мог обогнать удаление, и его реплику трогать нельзя.
    private const string TakeLotsSql = """
        DELETE FROM lot_replica
        WHERE lot_id = ANY(@Registry) OR (@ByAuction AND auction_id = @AuctionId)
        RETURNING lot_id AS LotId, status AS Status, leader_id AS Leader,
                  sale_minor_units AS SaleMinorUnits, sale_currency AS SaleCurrency;
        """;

    private const string CancelRemindersSql = """
        UPDATE lot_reminder_task
        SET state = 'cancelled', reason = 'auction ended'
        WHERE lot_id = ANY(@LotIds) AND state = 'scheduled';
        """;

    /// <summary>Разделяемая блокировка аукциона на факт его лота.</summary>
    public static Task LockShared(UnitOfWork work, Guid auctionId, CancellationToken cancellationToken) =>
        work.Execute(LockSharedSql, new { AuctionId = auctionId }, cancellationToken);

    /// <summary>Исключительная блокировка аукциона на его конец.</summary>
    public static Task Lock(UnitOfWork work, Guid auctionId, CancellationToken cancellationToken) =>
        work.Execute(LockSql, new { AuctionId = auctionId }, cancellationToken);

    public static async Task<EndedAuction?> Read(UnitOfWork work, Guid auctionId, CancellationToken cancellationToken)
    {
        var rows = await work.Query<Row>(ReadSql, new { AuctionId = auctionId }, cancellationToken);
        return rows.Select(row => new EndedAuction(
                row.Outcome == "cancelled" ? AuctionEnd.Cancelled : AuctionEnd.Finished, row.EventId, row.MeetupId))
            .SingleOrDefault();
    }

    /// <summary>Строка «аукцион закончен». Удалённому до торгов её не пишут.</summary>
    public static Task Mark(UnitOfWork work, AuctionClosed closed, DateTimeOffset now,
        CancellationToken cancellationToken) =>
        work.Execute(MarkSql, new
        {
            closed.AuctionId,
            Outcome = closed.End switch
            {
                AuctionEnd.Finished => "finished",
                AuctionEnd.Cancelled => "cancelled",
                _ => throw new ArgumentException("a discarded auction is not marked ended", nameof(closed)),
            },
            closed.EventId,
            closed.MeetupId,
            Now = now.UtcDateTime,
        }, cancellationToken);

    /// <summary>
    /// Удаляет реплики лотов аукциона и возвращает их последнее слово. Удаление
    /// ждёт ручную отметку, которая держит строку реплики, поэтому следующая
    /// инструкция видит эту отметку закоммиченной (FavoriteStore).
    /// </summary>
    public static async Task<IReadOnlyList<EndedLot>> TakeLots(UnitOfWork work, AuctionClosed closed,
        CancellationToken cancellationToken)
    {
        var rows = await work.Query<LotRow>(TakeLotsSql, new
        {
            Registry = closed.Registry.ToArray(),
            ByAuction = closed.End != AuctionEnd.Discarded,
            closed.AuctionId,
        }, cancellationToken);
        return rows.Select(row => new EndedLot(row.LotId, LotReplicaStore.FromStorage(row.Status), row.Leader,
                row.SaleMinorUnits is { } minor && row.SaleCurrency is { } currency
                    ? new Money { MinorUnits = minor, Currency = currency }
                    : null))
            .ToArray();
    }

    /// <summary>
    /// Снимает несработавшие задания напоминания лотов: <c>lot_withdrawn</c>,
    /// пришедший после отмены, их уже не снимет — реплики нет. Сработавшие
    /// остаются историей, как у любого снятия.
    /// </summary>
    public static Task<int> CancelReminders(UnitOfWork work, IReadOnlyList<Guid> lotIds,
        CancellationToken cancellationToken) =>
        work.Execute(CancelRemindersSql, new { LotIds = lotIds.ToArray() }, cancellationToken);

    private sealed record Row(string Outcome, Guid EventId, Guid MeetupId);

    private sealed record LotRow(Guid LotId, string Status, Guid? Leader, long? SaleMinorUnits, string? SaleCurrency);
}
