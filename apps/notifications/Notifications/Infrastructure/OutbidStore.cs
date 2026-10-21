using Auction.V1;
using Notifications.Domain;
using Notifications.V1;

namespace Notifications.Infrastructure;

/// <summary>Строка окна на закрытии: лот, вид, ведёт ли человек лот и цена последней ставки лота.</summary>
public sealed record DigestLine(Guid LotId, LotActivityKind Kind, bool RecipientLeads, Money Price);

/// <summary>Закрытое окно: повод сводки и строки в порядке появления.</summary>
public sealed record ClosedDigest(Guid RecipientId, Guid DigestId, IReadOnlyList<DigestLine> Lines);

/// <summary>
/// Настройка перебитий (PER-514) и окно сводки (PER-596). Соединение и
/// транзакцию приносит <see cref="UnitOfWork" />: решение по ставке, окно и
/// адресный факт коммитятся вместе с ключом события.
/// </summary>
/// <remarks>
/// Порядок событий держит предикат <c>last_version &lt; @Version</c> в самих
/// запросах, а не сравнение в C#: два экземпляра на одном durable иначе
/// разошлись бы на гонке «прочитать, сравнить, записать».
///
/// Блокировки берутся в одном порядке на всех путях: сначала окна людей по
/// возрастанию идентификатора, затем строки. Закрытие держит окно и ждёт
/// строки, поэтому ставка, которая держала бы строку и ждала окно, сцепилась
/// бы с ним насмерть.
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

    // Окно открывается первым событием и своего момента закрытия больше не
    // меняет: интервал отсчитывается от первого события, а не от последнего,
    // иначе частые перебития откладывали бы сводку без конца. Пустое обновление
    // на конфликте берёт блокировку строки окна: закрытие, начатое позже,
    // дождётся коммита ставки и увидит её строку.
    private const string OpenSql = """
        INSERT INTO outbid_digest (recipient_id, digest_id, opened_at, due_at)
        VALUES (@RecipientId, @DigestId, @Now, @DueAt)
        ON CONFLICT (recipient_id) DO UPDATE SET recipient_id = EXCLUDED.recipient_id;
        """;

    // Каждая ставка лота говорит о всех его строках сразу: кто лидер и цена
    // этой ставки. Поэтому строка идёт за лотом, а не только за своими
    // событиями, и на закрытии несёт актуальные цену и лидерство.
    private const string FollowLotSql = """
        UPDATE outbid_digest_line SET
            last_leader_id = @Leader, last_event_id = @EventId, last_version = @Version,
            price_minor_units = @MinorUnits, price_currency = @Currency
        WHERE lot_id = @LotId AND last_version < @Version;
        """;

    // Новая строка начинается с самого свежего известного состояния лота:
    // запоздавшее событие остаётся поводом строки, но старшая ставка, уже
    // применённая к другим строкам этого лота, задаёт лидера и цену — иначе
    // строка закрылась бы с тем, что уже неправда. Строку, которую эта ставка
    // уже обновила выше, конфликт не трогает: версия та же.
    private const string AddLineSql = """
        INSERT INTO outbid_digest_line (
            recipient_id, lot_id, kind, added_at, last_leader_id, last_event_id, last_version,
            price_minor_units, price_currency)
        SELECT @RecipientId, @LotId, @Kind, @Now, state.leader, state.event_id, state.version,
            state.minor_units, state.currency
        FROM (
            SELECT last_leader_id AS leader, last_event_id AS event_id, last_version AS version,
                price_minor_units AS minor_units, price_currency AS currency
            FROM outbid_digest_line
            WHERE lot_id = @LotId AND last_version > @Version
            UNION ALL
            SELECT @Leader, @EventId, @Version, @MinorUnits, @Currency
            ORDER BY version DESC
            LIMIT 1
        ) AS state
        ON CONFLICT (recipient_id, lot_id, kind) DO UPDATE SET
            last_leader_id = EXCLUDED.last_leader_id, last_event_id = EXCLUDED.last_event_id,
            last_version = EXCLUDED.last_version, price_minor_units = EXCLUDED.price_minor_units,
            price_currency = EXCLUDED.price_currency
        WHERE outbid_digest_line.last_version < EXCLUDED.last_version;
        """;

    private const string DueSql = """
        SELECT recipient_id FROM outbid_digest
        WHERE due_at <= @Now
        ORDER BY due_at
        LIMIT @Limit;
        """;

    // Удаление окна и есть захват: второй экземпляр, дошедший до той же
    // строки, ждёт блокировку и удаляет ноль строк, поэтому сводка уходит
    // один раз.
    private const string TakeDueSql = """
        DELETE FROM outbid_digest
        WHERE recipient_id = @RecipientId AND due_at <= @Now
        RETURNING digest_id;
        """;

    private const string TakeSql = """
        DELETE FROM outbid_digest
        WHERE recipient_id = @RecipientId
        RETURNING digest_id;
        """;

    // Отдельным запросом после блокировки окна: новый снимок видит строки,
    // закоммиченные до неё, и окно, открытое заново после чужого закрытия,
    // без строки проданного лота продажа не трогает.
    private const string HasLotSql = """
        SELECT EXISTS (SELECT 1 FROM outbid_digest_line WHERE recipient_id = @RecipientId AND lot_id = @LotId);
        """;

    private const string TakeLinesSql = """
        DELETE FROM outbid_digest_line
        WHERE recipient_id = @RecipientId
        RETURNING lot_id, kind, added_at, last_leader_id, price_minor_units, price_currency;
        """;

    private const string LotRecipientsSql = """
        SELECT DISTINCT recipient_id FROM outbid_digest_line WHERE lot_id = @LotId;
        """;

    private const string LockSql = """
        SELECT digest_id FROM outbid_digest WHERE recipient_id = @RecipientId FOR UPDATE;
        """;

    private const string DropLotSql = """
        DELETE FROM outbid_digest_line WHERE recipient_id = @RecipientId AND lot_id = @LotId;
        """;

    private const string DropIfEmptySql = """
        DELETE FROM outbid_digest
        WHERE recipient_id = @RecipientId
            AND NOT EXISTS (SELECT 1 FROM outbid_digest_line WHERE recipient_id = @RecipientId);
        """;

    private const string ReadLiveFinalSql = """
        SELECT enabled FROM live_final_outbid_preference WHERE identity_id = @IdentityId;
        """;

    private const string SetLiveFinalSql = """
        INSERT INTO live_final_outbid_preference (identity_id, enabled, updated_at)
        VALUES (@IdentityId, @Enabled, @UpdatedAt)
        ON CONFLICT (identity_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at;
        """;

    private const string OutbidKind = "outbid";
    private const string ProxyRaisedKind = "proxy_raised";

    /// <summary>Заданное значение; <c>null</c> — человек настройку не трогал.</summary>
    public static async Task<OutbidFrequency?> ReadPreference(UnitOfWork work, Guid identityId,
        CancellationToken cancellationToken)
    {
        var rows = await work.Query<string>(ReadPreferenceSql, new { IdentityId = identityId }, cancellationToken);
        return rows.Count == 0 ? null : OutbidFrequencies.FromStorage(rows[0]);
    }

    /// <summary>Выключатель перебитий в живом финале (PER-645); <c>null</c> — человек его не трогал.</summary>
    public static async Task<bool?> ReadLiveFinal(UnitOfWork work, Guid identityId,
        CancellationToken cancellationToken)
    {
        var rows = await work.Query<bool>(ReadLiveFinalSql, new { IdentityId = identityId }, cancellationToken);
        return rows.Count == 0 ? null : rows[0];
    }

    public static Task SetLiveFinal(UnitOfWork work, Guid identityId, bool enabled, DateTimeOffset now,
        CancellationToken cancellationToken) =>
        work.Execute(SetLiveFinalSql, new { IdentityId = identityId, Enabled = enabled, UpdatedAt = now.UtcDateTime },
            cancellationToken);

    public static Task SetPreference(UnitOfWork work, Guid identityId, OutbidFrequency frequency, DateTimeOffset now,
        CancellationToken cancellationToken) =>
        work.Execute(SetPreferenceSql, new
        {
            IdentityId = identityId,
            Frequency = OutbidFrequencies.Storage(frequency),
            UpdatedAt = now.UtcDateTime,
        }, cancellationToken);

    /// <summary>
    /// Берёт окна, которые тронет ставка лота, до любых строк: окна людей со
    /// строками этого лота и окна, которые ставка открывает (<paramref name="opening" />
    /// — человек и момент закрытия нового окна). Окна берутся в порядке
    /// идентификатора человека, как и у продажи, поэтому ставка и продажа на
    /// чужих окнах друг друга по кругу не ждут.
    /// </summary>
    /// <remarks>
    /// Строку, которую другая транзакция закоммитила на этот лот уже после
    /// выборки, <see cref="FollowLot" /> обновит без окна. Сцепиться так можно
    /// только с продажей, которая держит окно этого человека и ждёт окно,
    /// взятое здесь, — узкая гонка; её PostgreSQL обрывает, и событие приходит
    /// повтором.
    /// </remarks>
    public static async Task LockForBid(UnitOfWork work, Guid lotId, IReadOnlyDictionary<Guid, DateTimeOffset> opening,
        DateTimeOffset now, CancellationToken cancellationToken)
    {
        var holders = await work.Query<Guid>(LotRecipientsSql, new { LotId = lotId }, cancellationToken);
        foreach (var recipientId in holders.Concat(opening.Keys).Distinct().Order())
        {
            if (opening.TryGetValue(recipientId, out var dueAt))
            {
                await work.Execute(OpenSql, new
                {
                    RecipientId = recipientId, DigestId = Guid.CreateVersion7(now),
                    Now = now.UtcDateTime, DueAt = dueAt.UtcDateTime,
                }, cancellationToken);
            }
            else
            {
                await work.Query<Guid>(LockSql, new { RecipientId = recipientId }, cancellationToken);
            }
        }
    }

    /// <summary>
    /// Ставка лота во все его строки: ведёт ли человек лот по лидеру этой
    /// ставки, её повод и цена. Возврат лидерства строку не убирает.
    ///
    /// Лидер может быть пустым: снятие участника оставляет лот без ведущего,
    /// и строка окна тогда не говорит «лот за тобой» (ADR-072, PER-672).
    /// </summary>
    public static Task FollowLot(UnitOfWork work, Guid lotId, Guid? leader, Guid eventId, long version, Money price,
        CancellationToken cancellationToken) =>
        work.Execute(FollowLotSql, new
        {
            LotId = lotId, Leader = leader, EventId = eventId, Version = version,
            MinorUnits = price.MinorUnits, price.Currency,
        }, cancellationToken);

    /// <summary>Строка лота в открытое окно человека; окно уже открыто <see cref="LockForBid" />.</summary>
    public static Task AddLine(UnitOfWork work, Guid recipientId, Guid lotId, LotActivityKind kind,
        Guid leader, Guid eventId, long version, Money price, DateTimeOffset now,
        CancellationToken cancellationToken) =>
        work.Execute(AddLineSql, new
        {
            RecipientId = recipientId, LotId = lotId, Kind = KindStorage(kind), Leader = leader,
            EventId = eventId, Version = version, MinorUnits = price.MinorUnits, price.Currency,
            Now = now.UtcDateTime,
        }, cancellationToken);

    public static async Task<IReadOnlyList<Guid>> Due(UnitOfWork work, DateTimeOffset now, int limit,
        CancellationToken cancellationToken) =>
        await work.Query<Guid>(DueSql, new { Now = now.UtcDateTime, Limit = limit }, cancellationToken);

    /// <summary>Закрывает наступившее окно; <c>null</c> — его уже закрыл другой проход.</summary>
    public static async Task<ClosedDigest?> TakeDue(UnitOfWork work, Guid recipientId, DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var taken = await work.Query<Guid>(TakeDueSql, new { RecipientId = recipientId, Now = now.UtcDateTime },
            cancellationToken);
        return taken.Count == 0 ? null : await TakeLines(work, recipientId, taken[0], cancellationToken);
    }

    /// <summary>
    /// Закрывает окна, где есть строки проданного лота, раньше срока; окно
    /// победителя не закрывается, а теряет строки этого лота: о нём человеку
    /// скажет покупка. Окна берутся в порядке идентификатора человека, чтобы
    /// две продажи не сцепились на окнах друг друга.
    /// </summary>
    public static async Task<IReadOnlyList<ClosedDigest>> TakeLot(UnitOfWork work, Guid lotId, Guid winner,
        CancellationToken cancellationToken)
    {
        var recipients = await work.Query<Guid>(LotRecipientsSql, new { LotId = lotId }, cancellationToken);
        var closed = new List<ClosedDigest>();
        foreach (var recipientId in recipients.Order())
        {
            // Выборка выше читалась без блокировок: окно могли закрыть и
            // открыть заново, уже без этого лота.
            var key = new { RecipientId = recipientId, LotId = lotId };
            if ((await work.Query<Guid>(LockSql, key, cancellationToken)).Count == 0
                || !(await work.Query<bool>(HasLotSql, key, cancellationToken))[0])
            {
                continue;
            }

            if (recipientId == winner)
            {
                await work.Execute(DropLotSql, key, cancellationToken);
                await work.Execute(DropIfEmptySql, key, cancellationToken);
                continue;
            }

            var taken = await work.Query<Guid>(TakeSql, key, cancellationToken);
            closed.Add(await TakeLines(work, recipientId, taken[0], cancellationToken));
        }
        return closed;
    }

    private static async Task<ClosedDigest> TakeLines(UnitOfWork work, Guid recipientId, Guid digestId,
        CancellationToken cancellationToken)
    {
        var rows = await work.Query<LineRow>(TakeLinesSql, new { RecipientId = recipientId }, cancellationToken);
        var lines = rows
            .OrderBy(row => row.added_at)
            .ThenBy(row => row.lot_id)
            .ThenBy(row => row.kind, StringComparer.Ordinal)
            .Select(row => new DigestLine(row.lot_id, KindFromStorage(row.kind), row.last_leader_id == recipientId,
                new Money { MinorUnits = row.price_minor_units, Currency = row.price_currency }))
            .ToArray();
        return new ClosedDigest(recipientId, digestId, lines);
    }

    private static string KindStorage(LotActivityKind kind) => kind switch
    {
        LotActivityKind.Outbid => OutbidKind,
        LotActivityKind.ProxyRaised => ProxyRaisedKind,
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "unknown lot activity kind"),
    };

    private static LotActivityKind KindFromStorage(string kind) => kind switch
    {
        OutbidKind => LotActivityKind.Outbid,
        ProxyRaisedKind => LotActivityKind.ProxyRaised,
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "unknown stored lot activity kind"),
    };

    // Имена полей совпадают с колонками, как в PreferenceStore.
    private sealed record LineRow(Guid lot_id, string kind, DateTime added_at, Guid last_leader_id,
        long price_minor_units, string price_currency);
}
