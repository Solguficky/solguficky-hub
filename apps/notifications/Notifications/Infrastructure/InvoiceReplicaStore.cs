using Dapper;
using Npgsql;
using Notifications.Auction;

namespace Notifications.Infrastructure;

/// <summary>
/// Последний записанный снимок счёта: положение, адресат, лот, аукцион, сумма
/// и срок оплаты. Момент выставления пуст, пока не пришёл факт выставления.
/// </summary>
/// <remarks>
/// Из снимка живут задания напоминания о неоплаченном счёте (PER-330): сумма и
/// срок нужны самому факту напоминания — канал читает их из сообщения, а не у
/// Auction, — а момент выставления считает первое из двух напоминаний.
/// </remarks>
public sealed record InvoiceReplica(Guid InvoiceId, long Version, InvoiceStatus Status, Guid WinnerId, Guid LotId,
    Guid AuctionId, long AmountMinorUnits, string AmountCurrency, DateTimeOffset? PaymentDueAt,
    DateTimeOffset? IssuedAt);

/// <summary>
/// Реплика счёта из фактов AUCTION_EVENTS. Соединение и транзакцию приносит
/// <see cref="UnitOfWork" />: снимок коммитится вместе с ключом события той же
/// транзакцией.
/// </summary>
/// <remarks>
/// Порядок держит предикат <c>version &lt; EXCLUDED.version</c> в самом upsert,
/// как у реплики лота: контракт порядка доставки не обещает, а факты счёта идут
/// разными subject'ами, поэтому <c>invoice_paid</c> может прийти раньше
/// <c>invoice_issued</c>. Проверка в C# открыла бы гонку двух экземпляров на
/// одном durable.
/// </remarks>
public static class InvoiceReplicaStore
{
    private const string ApplySql = """
        INSERT INTO invoice_replica (invoice_id, version, status, winner_id, lot_id, auction_id,
                                     amount_minor_units, amount_currency, payment_due_at, issued_at, applied_at)
        VALUES (@InvoiceId, @Version, @Status, @WinnerId, @LotId, @AuctionId,
                @AmountMinorUnits, @AmountCurrency, @PaymentDueAt, @IssuedAt, @Now)
        ON CONFLICT (invoice_id) DO UPDATE SET
            version = EXCLUDED.version,
            status = EXCLUDED.status,
            winner_id = EXCLUDED.winner_id,
            lot_id = EXCLUDED.lot_id,
            auction_id = EXCLUDED.auction_id,
            amount_minor_units = EXCLUDED.amount_minor_units,
            amount_currency = EXCLUDED.amount_currency,
            payment_due_at = EXCLUDED.payment_due_at,
            issued_at = COALESCE(EXCLUDED.issued_at, invoice_replica.issued_at),
            applied_at = EXCLUDED.applied_at
        WHERE invoice_replica.version < EXCLUDED.version;
        """;

    private const string ReadSql = """
        SELECT invoice_id AS InvoiceId, version AS Version, status AS Status, winner_id AS WinnerId,
               lot_id AS LotId, auction_id AS AuctionId, amount_minor_units AS AmountMinorUnits,
               amount_currency AS AmountCurrency, payment_due_at AS PaymentDueAt, issued_at AS IssuedAt
        FROM invoice_replica
        WHERE invoice_id = @InvoiceId;
        """;

    private const string LockedReadSql = """
        SELECT invoice_id AS InvoiceId, version AS Version, status AS Status, winner_id AS WinnerId,
               lot_id AS LotId, auction_id AS AuctionId, amount_minor_units AS AmountMinorUnits,
               amount_currency AS AmountCurrency, payment_due_at AS PaymentDueAt, issued_at AS IssuedAt
        FROM invoice_replica
        WHERE invoice_id = @InvoiceId
        FOR SHARE;
        """;

    /// <summary>Пишет снимок, если его версия старше записанной. Возвращает, записан ли он.</summary>
    public static async Task<bool> Apply(UnitOfWork work, InvoiceSnapshot snapshot, DateTimeOffset now,
        CancellationToken cancellationToken) =>
        await work.Execute(ApplySql, new
        {
            snapshot.InvoiceId,
            snapshot.Version,
            Status = Storage(snapshot.Status),
            snapshot.WinnerId,
            snapshot.LotId,
            snapshot.AuctionId,
            snapshot.AmountMinorUnits,
            snapshot.AmountCurrency,
            PaymentDueAt = snapshot.PaymentDueAt?.UtcDateTime,
            IssuedAt = snapshot.Issued ? snapshot.OccurredAt.UtcDateTime : (DateTime?)null,
            Now = now.UtcDateTime,
        }, cancellationToken) > 0;

    public static async Task<InvoiceReplica?> Read(UnitOfWork work, Guid invoiceId, CancellationToken cancellationToken)
    {
        var rows = await work.Query<Row>(ReadSql, new { InvoiceId = invoiceId }, cancellationToken);
        return rows.Select(Map).SingleOrDefault();
    }

    /// <summary>
    /// Снимок под разделяемой блокировкой строки. Ею берёт и запись оплаты:
    /// без блокировки оплата успела бы встать между чтением снимка и записью
    /// факта, и напоминание о неоплаченном счёте ушло бы после того, как оплата
    /// уже записана.
    /// </summary>
    public static async Task<InvoiceReplica?> ReadLocked(UnitOfWork work, Guid invoiceId,
        CancellationToken cancellationToken)
    {
        var rows = await work.Query<Row>(LockedReadSql, new { InvoiceId = invoiceId }, cancellationToken);
        return rows.Select(Map).SingleOrDefault();
    }

    /// <summary>
    /// Снимок вне чужой транзакции: грин напоминания читает реплику на своём
    /// ходу, а не в транзакции применения события.
    /// </summary>
    public static async Task<InvoiceReplica?> Read(NpgsqlDataSource source, Guid invoiceId,
        CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);
        var rows = await connection.QueryAsync<Row>(ReadSql, new { InvoiceId = invoiceId });
        return rows.Select(Map).SingleOrDefault();
    }

    private static InvoiceReplica Map(Row row) =>
        new(row.InvoiceId, row.Version, FromStorage(row.Status), row.WinnerId, row.LotId, row.AuctionId,
            row.AmountMinorUnits, row.AmountCurrency, Utc(row.PaymentDueAt), Utc(row.IssuedAt));

    public static string Storage(InvoiceStatus status) => status switch
    {
        InvoiceStatus.AwaitingPayment => "awaiting_payment",
        InvoiceStatus.Paid => "paid",
        _ => throw new ArgumentOutOfRangeException(nameof(status)),
    };

    public static InvoiceStatus FromStorage(string value) => value switch
    {
        "awaiting_payment" => InvoiceStatus.AwaitingPayment,
        "paid" => InvoiceStatus.Paid,
        _ => throw new ArgumentOutOfRangeException(nameof(value)),
    };

    private static DateTimeOffset Utc(DateTime value) =>
        new(DateTime.SpecifyKind(value, DateTimeKind.Utc));

    private static DateTimeOffset? Utc(DateTime? value) =>
        value is { } instant ? new DateTimeOffset(DateTime.SpecifyKind(instant, DateTimeKind.Utc)) : null;

    private sealed record Row(Guid InvoiceId, long Version, string Status, Guid WinnerId, Guid LotId, Guid AuctionId,
        long AmountMinorUnits, string AmountCurrency, DateTime? PaymentDueAt, DateTime? IssuedAt);
}
