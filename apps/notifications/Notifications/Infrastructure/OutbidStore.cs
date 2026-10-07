using Auction.V1;
using Notifications.Domain;
using Notifications.V1;

namespace Notifications.Infrastructure;

/// <summary>Окно частоты перебитий: лот, участник и момент закрытия.</summary>
public sealed record OutbidWindowKey(Guid LotId, Guid RecipientId);

/// <summary>Закрытое окно: перебит ли участник на закрытии, повод и цена последнего перебития.</summary>
public sealed record ClosedOutbidWindow(Guid LotId, Guid RecipientId, bool Outbid, Guid LastEventId, Money Price);

/// <summary>
/// Настройка перебитий и окно частоты (PER-514). Соединение и транзакцию
/// приносит <see cref="UnitOfWork" />: решение по ставке, окно и адресный факт
/// коммитятся вместе с ключом события.
/// </summary>
/// <remarks>
/// Порядок событий держит предикат <c>last_version &lt; @Version</c> в самих
/// запросах, а не сравнение в C#: два экземпляра на одном durable иначе
/// разошлись бы на гонке «прочитать, сравнить, записать».
/// </remarks>
public static class OutbidStore
{
    private const string ReadPreferenceSql = """
        SELECT frequency FROM outbid_preference WHERE identity_id = @IdentityId;
        """;

    private const string SetPreferenceSql = """
        INSERT INTO outbid_preference (identity_id, frequency, updated_at)
        VALUES (@IdentityId, @Frequency, @UpdatedAt)
        ON CONFLICT (identity_id) DO UPDATE SET frequency = EXCLUDED.frequency, updated_at = EXCLUDED.updated_at;
        """;

    // Каждая ставка лота говорит о всех его окнах сразу: участник перебит, если
    // лидер не он, а цена — цена этой ставки. Поэтому окно идёт за лотом, а не
    // только за перебитиями своего участника, и на закрытии несёт актуальную
    // цену, даже если после перебития ставили третьи лица.
    private const string FollowLotSql = """
        UPDATE outbid_window SET
            outbid = recipient_id <> @Leader, last_event_id = @EventId, last_version = @Version,
            price_minor_units = @MinorUnits, price_currency = @Currency
        WHERE lot_id = @LotId AND last_version < @Version;
        """;

    // Окно открывается первым перебитием и своего момента закрытия больше не
    // меняет: интервал отсчитывается от первого перебития, а не от последнего,
    // иначе частые перебития откладывали бы сообщение без конца. Открытое окно
    // эта ставка уже обновила выше, поэтому конфликт ничего не делает.
    private const string OpenSql = """
        INSERT INTO outbid_window (
            lot_id, recipient_id, opened_at, due_at, outbid, last_event_id, last_version,
            price_minor_units, price_currency)
        VALUES (@LotId, @RecipientId, @Now, @DueAt, true, @EventId, @Version, @MinorUnits, @Currency)
        ON CONFLICT (lot_id, recipient_id) DO NOTHING;
        """;

    private const string DueSql = """
        SELECT lot_id, recipient_id FROM outbid_window
        WHERE due_at <= @Now
        ORDER BY due_at
        LIMIT @Limit;
        """;

    // Удаление и есть захват: второй экземпляр, дошедший до той же строки,
    // ждёт блокировку и удаляет ноль строк, поэтому сообщение уходит один раз.
    private const string TakeDueSql = """
        DELETE FROM outbid_window
        WHERE lot_id = @LotId AND recipient_id = @RecipientId AND due_at <= @Now
        RETURNING lot_id, recipient_id, outbid, last_event_id, price_minor_units, price_currency;
        """;

    private const string TakeLotSql = """
        DELETE FROM outbid_window
        WHERE lot_id = @LotId
        RETURNING lot_id, recipient_id, outbid, last_event_id, price_minor_units, price_currency;
        """;

    /// <summary>Заданное значение; <c>null</c> — человек настройку не трогал.</summary>
    public static async Task<OutbidFrequency?> ReadPreference(UnitOfWork work, Guid identityId,
        CancellationToken cancellationToken)
    {
        var rows = await work.Query<string>(ReadPreferenceSql, new { IdentityId = identityId }, cancellationToken);
        return rows.Count == 0 ? null : OutbidFrequencies.FromStorage(rows[0]);
    }

    public static Task SetPreference(UnitOfWork work, Guid identityId, OutbidFrequency frequency, DateTimeOffset now,
        CancellationToken cancellationToken) =>
        work.Execute(SetPreferenceSql, new
        {
            IdentityId = identityId,
            Frequency = OutbidFrequencies.Storage(frequency),
            UpdatedAt = now.UtcDateTime,
        }, cancellationToken);

    /// <summary>
    /// Ставка лота во все его открытые окна: отметка «перебит» по лидеру этой
    /// ставки, её повод и цена. Возврат лидерства снимает отметку, но окна не
    /// закрывает.
    /// </summary>
    public static Task FollowLot(UnitOfWork work, Guid lotId, Guid leader, Guid eventId, long version, Money price,
        CancellationToken cancellationToken) =>
        work.Execute(FollowLotSql, new
        {
            LotId = lotId, Leader = leader, EventId = eventId, Version = version,
            MinorUnits = price.MinorUnits, price.Currency,
        }, cancellationToken);

    /// <summary>Открывает окно перебитому, если открытого ещё нет.</summary>
    public static Task Open(UnitOfWork work, Guid lotId, Guid recipientId, Guid eventId, long version, Money price,
        DateTimeOffset now, DateTimeOffset dueAt, CancellationToken cancellationToken) =>
        work.Execute(OpenSql, new
        {
            LotId = lotId, RecipientId = recipientId, EventId = eventId, Version = version,
            MinorUnits = price.MinorUnits, price.Currency,
            Now = now.UtcDateTime, DueAt = dueAt.UtcDateTime,
        }, cancellationToken);

    public static async Task<IReadOnlyList<OutbidWindowKey>> Due(UnitOfWork work, DateTimeOffset now, int limit,
        CancellationToken cancellationToken)
    {
        var rows = await work.Query<KeyRow>(DueSql, new { Now = now.UtcDateTime, Limit = limit }, cancellationToken);
        return rows.Select(row => new OutbidWindowKey(row.lot_id, row.recipient_id)).ToArray();
    }

    /// <summary>Закрывает наступившее окно; <c>null</c> — его уже закрыл другой проход.</summary>
    public static async Task<ClosedOutbidWindow?> TakeDue(UnitOfWork work, OutbidWindowKey key, DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var rows = await work.Query<WindowRow>(TakeDueSql,
            new { key.LotId, key.RecipientId, Now = now.UtcDateTime }, cancellationToken);
        return rows.Select(Closed).SingleOrDefault();
    }

    /// <summary>Закрывает все окна лота разом: торги по нему кончились.</summary>
    public static async Task<IReadOnlyList<ClosedOutbidWindow>> TakeLot(UnitOfWork work, Guid lotId,
        CancellationToken cancellationToken)
    {
        var rows = await work.Query<WindowRow>(TakeLotSql, new { LotId = lotId }, cancellationToken);
        return rows.Select(Closed).ToArray();
    }

    private static ClosedOutbidWindow Closed(WindowRow row) =>
        new(row.lot_id, row.recipient_id, row.outbid, row.last_event_id,
            new Money { MinorUnits = row.price_minor_units, Currency = row.price_currency });

    // Имена полей совпадают с колонками, как в PreferenceStore.
    private sealed record KeyRow(Guid lot_id, Guid recipient_id);

    private sealed record WindowRow(Guid lot_id, Guid recipient_id, bool outbid, Guid last_event_id,
        long price_minor_units, string price_currency);
}
