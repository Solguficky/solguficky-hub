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

    private const string BiddersSql = """
        SELECT bidder_id FROM auction_bidder WHERE auction_id = @AuctionId ORDER BY bidder_id;
        """;

    private const string HeldSql = """
        SELECT lot_id AS LotId, leader_id AS Leader, price_minor_units AS MinorUnits, price_currency AS Currency
        FROM lot_hold
        WHERE lot_id = ANY(@LotIds);
        """;

    private const string ForgetSql = """
        DELETE FROM auction_bidder WHERE auction_id = @AuctionId;
        DELETE FROM lot_hold WHERE auction_id = @AuctionId;
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

    /// <summary>Аукцион кончился: круг и удержания больше никому не нужны.</summary>
    public static Task<int> Forget(UnitOfWork work, Guid auctionId, CancellationToken cancellationToken) =>
        work.Execute(ForgetSql, new { AuctionId = auctionId }, cancellationToken);

    private sealed record Row(Guid LotId, Guid? Leader, long MinorUnits, string Currency);
}
