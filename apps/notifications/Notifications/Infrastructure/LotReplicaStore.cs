using System.Globalization;
using System.Text.Json;
using Auction.V1;
using Dapper;
using Notifications.Auction;
// Своя запись, а не одноимённое сообщение auction_service.proto (PER-778).
using LotStepWindow = Notifications.Auction.LotStepWindow;
using LotSnapshot = Notifications.Auction.LotSnapshot;
using Notifications.Reminders;
using Npgsql;

namespace Notifications.Infrastructure;

/// <summary>
/// Последний записанный снимок лота. Окна сниженного шага приходят данными
/// снимка и лежат строкой реплики: из них задание начала окна разворачивает
/// сообщение следящим (ADR-047, дополнение 2026-10-12). Текущая цена есть
/// только у лота в торгах: до первой ставки она — обычная стартовая, которую
/// весть называет рядом со стартовой окна (PER-788).
/// </summary>
public sealed record LotReplica(Guid LotId, long Version, LotStatus Status, DateTimeOffset? Deadline, Guid? Leader,
    DateTimeOffset? TerminalAt, Guid? AuctionId, IReadOnlyList<LotStepWindow> Windows, Money? Price = null);

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
    // Реплика, записанная до PER-604, получает аукцион со следующим снимком.
    private const string ApplySql = """
        INSERT INTO lot_replica (lot_id, version, status, deadline, leader_id, terminal_at, occurred_at, applied_at,
                                 auction_id, sale_minor_units, sale_currency, step_windows, price_minor_units,
                                 price_currency)
        VALUES (@LotId, @Version, @Status, @Deadline, @Leader, @TerminalAt, @OccurredAt, @Now,
                @AuctionId, @SaleMinorUnits, @SaleCurrency, CAST(@Windows AS jsonb), @PriceMinorUnits,
                @PriceCurrency)
        ON CONFLICT (lot_id) DO UPDATE SET
            version = EXCLUDED.version,
            status = EXCLUDED.status,
            deadline = EXCLUDED.deadline,
            leader_id = EXCLUDED.leader_id,
            auction_id = EXCLUDED.auction_id,
            sale_minor_units = EXCLUDED.sale_minor_units,
            sale_currency = EXCLUDED.sale_currency,
            step_windows = EXCLUDED.step_windows,
            price_minor_units = EXCLUDED.price_minor_units,
            price_currency = EXCLUDED.price_currency,
            terminal_at = CASE WHEN EXCLUDED.terminal_at IS NULL THEN NULL
                               ELSE COALESCE(lot_replica.terminal_at, EXCLUDED.terminal_at) END,
            occurred_at = EXCLUDED.occurred_at,
            applied_at = EXCLUDED.applied_at
        WHERE lot_replica.version < EXCLUDED.version;
        """;

    private const string ReadSql = """
        SELECT lot_id AS LotId, version AS Version, status AS Status, deadline AS Deadline,
               leader_id AS Leader, terminal_at AS TerminalAt, auction_id AS AuctionId,
               step_windows AS Windows, price_minor_units AS PriceMinorUnits, price_currency AS PriceCurrency
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
            snapshot.AuctionId,
            SaleMinorUnits = snapshot.SalePrice?.MinorUnits,
            SaleCurrency = snapshot.SalePrice?.Currency,
            Windows = StorageOf(snapshot.Windows),
            PriceMinorUnits = snapshot.CurrentPrice?.MinorUnits,
            PriceCurrency = snapshot.CurrentPrice?.Currency,
        }, cancellationToken) > 0;

    private const string StatusCountsSql = """
        SELECT status, count(*)::int AS Count
        FROM lot_replica
        WHERE lot_id = ANY(@LotIds)
        GROUP BY status;
        """;

    /// <summary>
    /// Сколько лотов названного набора в каком положении по реплике; лота, чьей
    /// реплики ещё нет, в счёте нет (PER-812).
    /// </summary>
    public static async Task<IReadOnlyDictionary<LotStatus, int>> StatusCounts(UnitOfWork work,
        IReadOnlyList<Guid> lotIds, CancellationToken cancellationToken)
    {
        var rows = await work.Query<StatusCountRow>(StatusCountsSql, new { LotIds = lotIds.ToArray() },
            cancellationToken);
        return rows.ToDictionary(row => FromStorage(row.Status), row => row.Count);
    }

    private sealed record StatusCountRow(string Status, int Count);

    public static async Task<LotReplica?> Read(UnitOfWork work, Guid lotId, CancellationToken cancellationToken)
    {
        var rows = await work.Query<Row>(ReadSql, new { LotId = lotId }, cancellationToken);
        return rows.Select(Map).SingleOrDefault();
    }

    /// <summary>
    /// Снимок вне чужой транзакции: грин напоминания читает реплику на своём
    /// ходу, а не в транзакции применения события.
    /// </summary>
    public static async Task<LotReplica?> Read(NpgsqlDataSource source, Guid lotId, CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);
        var rows = await connection.QueryAsync<Row>(ReadSql, new { LotId = lotId });
        return rows.Select(Map).SingleOrDefault();
    }

    private static LotReplica Map(Row row) =>
        new(row.LotId, row.Version, FromStorage(row.Status), Utc(row.Deadline), row.Leader, Utc(row.TerminalAt),
            row.AuctionId, WindowsOf(row.Windows), PriceOf(row.PriceMinorUnits, row.PriceCurrency));

    /// <summary>Цена из пары столбцов реплики: пары нет — цены нет.</summary>
    public static Money? PriceOf(long? minorUnits, string? currency) =>
        minorUnits is { } units && currency is { } code ? new Money { MinorUnits = units, Currency = code } : null;

    /// <summary>
    /// Окна из строки реплики. Читающий их разворачивает сообщение, поэтому
    /// разбор здесь один: второй разбор того же формата разошёлся бы с этим.
    /// </summary>
    public static IReadOnlyList<LotStepWindow> WindowsOf(string? stored)
    {
        if (string.IsNullOrWhiteSpace(stored))
        {
            return [];
        }

        var windows = JsonSerializer.Deserialize<StoredWindow[]>(stored, Json);
        return windows is null
            ? []
            : windows.Select(window => new LotStepWindow(
                Moment(window.From), Moment(window.Until),
                PriceOf(window.MinorUnits, window.Currency),
                PriceOf(window.StartMinorUnits, window.StartCurrency))).ToArray();
    }

    // Момент окна приводится к точности хранения при записи: сравнение начала
    // окна с моментом задания идёт по значению, а не по строке, и обрезанное
    // базой значение не должно отличаться от записанного.
    private static string StorageOf(IReadOnlyList<LotStepWindow> windows) =>
        JsonSerializer.Serialize(windows.Select(window => new StoredWindow(
                ReminderPlan.ToStoredPrecision(window.From).UtcDateTime.ToString("O", CultureInfo.InvariantCulture),
                ReminderPlan.ToStoredPrecision(window.Until).UtcDateTime.ToString("O", CultureInfo.InvariantCulture),
                window.Step?.MinorUnits, window.Step?.Currency,
                window.Start?.MinorUnits, window.Start?.Currency)).ToArray(), Json);

    private static DateTimeOffset Moment(string value) =>
        DateTimeOffset.Parse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal).ToUniversalTime();

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
    };

    // Ключи шага остались прежними: строки, записанные до PER-788, — окна с
    // шагом и без стартовой.
    private sealed record StoredWindow(string From, string Until, long? MinorUnits, string? Currency,
        long? StartMinorUnits = null, string? StartCurrency = null);

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

    public static LotStatus FromStorage(string value) => value switch
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
        DateTime? TerminalAt, Guid? AuctionId, string? Windows, long? PriceMinorUnits, string? PriceCurrency);
}
