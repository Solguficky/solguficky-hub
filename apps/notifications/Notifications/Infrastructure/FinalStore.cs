using Notifications.Auction;

namespace Notifications.Infrastructure;

/// <summary>Лот состава, каким он был удержан: лидер и цена.</summary>
public sealed record HeldLot(Guid LotId, Guid? Leader, global::Auction.V1.Money Price);

/// <summary>
/// Круг анонса финала и снимки удержания лотов (PER-477). Соединение и
/// транзакцию приносит <see cref="UnitOfWork" />: запись идёт той же
/// транзакцией, что ключ события.
/// </summary>
/// <remarks>
/// Обе вставки — <c>ON CONFLICT DO NOTHING</c>: участие помнится первым фактом,
/// а лот удерживается один раз. Версия здесь не нужна, и повтор или
/// переупорядочивание факта значения не меняют.
/// </remarks>
public static class FinalStore
{
    private const string AddBidderSql = """
        INSERT INTO auction_bidder (auction_id, bidder_id, first_at)
        VALUES (@AuctionId, @BidderId, @Now)
        ON CONFLICT DO NOTHING;
        """;

    private const string HoldSql = """
        INSERT INTO lot_hold (lot_id, auction_id, leader_id, price_minor_units, price_currency, held_at)
        VALUES (@LotId, @AuctionId, @Leader, @MinorUnits, @Currency, @HeldAt)
        ON CONFLICT DO NOTHING;
        """;

    // Снятие участника меняет лидера и цену удержанного лота: состав финала и
    // весть «твой лот следующий» читают их отсюда, и без этой правки они
    // достались бы снятому (ADR-072, PER-672).
    private const string UpdateHoldSql = """
        UPDATE lot_hold SET leader_id = @Leader, price_minor_units = @MinorUnits, price_currency = @Currency
        WHERE lot_id = @LotId;
        """;

    private const string BiddersSql = """
        SELECT bidder_id FROM auction_bidder WHERE auction_id = @AuctionId ORDER BY bidder_id;
        """;

    private const string HeldSql = """
        SELECT lot_id AS LotId, leader_id AS Leader, price_minor_units AS MinorUnits, price_currency AS Currency
        FROM lot_hold
        WHERE lot_id = ANY(@LotIds);
        """;

    private const string ReadAnnouncementsSql = """
        SELECT enabled FROM final_announcement_preference WHERE identity_id = @IdentityId;
        """;

    private const string SetAnnouncementsSql = """
        INSERT INTO final_announcement_preference (identity_id, enabled, updated_at)
        VALUES (@IdentityId, @Enabled, @UpdatedAt)
        ON CONFLICT (identity_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at;
        """;

    private const string SilencedSql = """
        SELECT identity_id FROM final_announcement_preference
        WHERE identity_id = ANY(@IdentityIds) AND NOT enabled;
        """;

    private const string ForgetSql = """
        DELETE FROM auction_bidder WHERE auction_id = @AuctionId;
        DELETE FROM lot_hold WHERE auction_id = @AuctionId;
        DELETE FROM auction_final_lot WHERE auction_id = @AuctionId;
        """;

    // Состав и ход финала: лот, его место в порядке и момент, когда его взяли
    // в работу. Момент нужен, чтобы оценить, сколько лот протянет
    // (ADR-063, дополнение 2026-10-20).
    private const string TrackLotSql = """
        INSERT INTO auction_final_lot (auction_id, lot_id, place, activated_at)
        VALUES (@AuctionId, @LotId, @Place, NULL)
        ON CONFLICT (auction_id, lot_id) DO NOTHING;
        """;

    private const string ActivateSql = """
        UPDATE auction_final_lot SET activated_at = @ActivatedAt
        WHERE auction_id = @AuctionId AND lot_id = @LotId AND activated_at IS NULL;
        """;

    private const string ActivationsSql = """
        SELECT activated_at FROM auction_final_lot
        WHERE auction_id = @AuctionId AND activated_at IS NOT NULL
        ORDER BY place;
        """;

    public static Task<int> AddBidder(UnitOfWork work, Guid auctionId, Guid bidderId, DateTimeOffset now,
        CancellationToken cancellationToken) =>
        work.Execute(AddBidderSql, new { AuctionId = auctionId, BidderId = bidderId, Now = now.UtcDateTime },
            cancellationToken);

    public static Task<int> Hold(UnitOfWork work, LotHold hold, CancellationToken cancellationToken) =>
        work.Execute(HoldSql, new
        {
            hold.LotId,
            hold.AuctionId,
            hold.Leader,
            hold.Price.MinorUnits,
            hold.Price.Currency,
            HeldAt = hold.HeldAt.UtcDateTime,
        }, cancellationToken);

    public static async Task<IReadOnlyList<Guid>> Bidders(UnitOfWork work, Guid auctionId,
        CancellationToken cancellationToken) =>
        (await work.Query<Guid>(BiddersSql, new { AuctionId = auctionId }, cancellationToken)).ToArray();

    /// <summary>Удержания названных лотов; лота, чьё удержание ещё не пришло, в ответе нет.</summary>
    public static async Task<IReadOnlyDictionary<Guid, HeldLot>> Held(UnitOfWork work, IReadOnlyList<Guid> lotIds,
        CancellationToken cancellationToken)
    {
        var rows = await work.Query<Row>(HeldSql, new { LotIds = lotIds.ToArray() }, cancellationToken);
        return rows.ToDictionary(row => row.LotId, row => new HeldLot(row.LotId, row.Leader,
            new global::Auction.V1.Money { MinorUnits = row.MinorUnits, Currency = row.Currency }));
    }

    /// <summary>
    /// Удержание лота по снимку после снятия участника: лидер и цена меняются,
    /// а новое удержание лот ещё не видел — оно пришло раньше снятия.
    /// </summary>
    public static Task<int> UpdateHold(UnitOfWork work, Guid lotId, Guid? leader, global::Auction.V1.Money price,
        CancellationToken cancellationToken) =>
        work.Execute(UpdateHoldSql, new
        {
            LotId = lotId, Leader = leader, MinorUnits = price.MinorUnits, price.Currency,
        }, cancellationToken);

    /// <summary>Выключатель анонса финала (PER-539); <c>null</c> — человек его не трогал.</summary>
    public static async Task<bool?> ReadAnnouncements(UnitOfWork work, Guid identityId,
        CancellationToken cancellationToken)
    {
        var rows = await work.Query<bool>(ReadAnnouncementsSql, new { IdentityId = identityId }, cancellationToken);
        return rows.Count == 0 ? null : rows[0];
    }

    public static Task SetAnnouncements(UnitOfWork work, Guid identityId, bool enabled, DateTimeOffset now,
        CancellationToken cancellationToken) =>
        work.Execute(SetAnnouncementsSql, new { IdentityId = identityId, Enabled = enabled, UpdatedAt = now.UtcDateTime },
            cancellationToken);

    /// <summary>Те из названных, кто анонс финала выключил.</summary>
    public static async Task<IReadOnlySet<Guid>> Silenced(UnitOfWork work, IReadOnlyList<Guid> identityIds,
        CancellationToken cancellationToken) =>
        (await work.Query<Guid>(SilencedSql, new { IdentityIds = identityIds.ToArray() }, cancellationToken))
        .ToHashSet();

    /// <summary>Аукцион кончился: круг и удержания больше никому не нужны.</summary>
    public static Task<int> Forget(UnitOfWork work, Guid auctionId, CancellationToken cancellationToken) =>
        work.Execute(ForgetSql, new { AuctionId = auctionId }, cancellationToken);

    /// <summary>
    /// Ведёт ход финала: состав и момент, когда лот взяли в работу. Состав
    /// пишется целиком — момент активации знает только факт, а порядок нужен и
    /// для следующего лота.
    /// </summary>
    public static async Task<int> TrackLot(UnitOfWork work, Guid auctionId, Guid activeLotId,
        IReadOnlyList<Guid> lineup, DateTimeOffset activatedAt, CancellationToken cancellationToken)
    {
        var tracked = 0;
        for (var place = 0; place < lineup.Count; place++)
        {
            tracked += await work.Execute(TrackLotSql,
                new { AuctionId = auctionId, LotId = lineup[place], Place = place }, cancellationToken);
        }

        // Момент активации ставится один раз: повтор факта его не двигает.
        await work.Execute(ActivateSql,
            new { AuctionId = auctionId, LotId = activeLotId, ActivatedAt = activatedAt.UtcDateTime },
            cancellationToken);
        return tracked;
    }

    /// <summary>Моменты, когда лоты состава брали в работу, в порядке финала.</summary>
    public static async Task<IReadOnlyList<DateTimeOffset>> Activations(UnitOfWork work, Guid auctionId,
        CancellationToken cancellationToken)
    {
        var rows = await work.Query<DateTime>(ActivationsSql, new { AuctionId = auctionId }, cancellationToken);
        return rows.Select(value => new DateTimeOffset(value.ToUniversalTime())).ToArray();
    }

    private sealed record Row(Guid LotId, Guid? Leader, long MinorUnits, string Currency);
}
