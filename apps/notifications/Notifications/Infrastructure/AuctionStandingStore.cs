using Notifications.Auction;

namespace Notifications.Infrastructure;

/// <summary>Последнее слово фактов аукциона о его видимости и конце.</summary>
public enum AuctionStanding { Visible, Hidden, Finished, Cancelled, Discarded }

/// <summary>
/// Положение аукциона для объявления аукциона (PER-780): команда отказывает
/// скрытому, удалённому и отменённому аукциону, а не доставляет объявление,
/// кнопка которого привела бы к «не найдено».
/// </summary>
/// <remarks>
/// Порядок фактов держит версия журнала аукциона в самом SQL, а не чтение перед
/// записью. Порядок команды с фактом, который закрывает аукцион, держит advisory
/// lock аукциона из <see cref="AuctionEndStore" />: команда берёт разделяемую и
/// читает положение под ней, скрытие и конец — исключительную до записи
/// положения и снятия неотправленных объявлений. Поэтому объявление, принятое
/// до скрытия, скрытие видит и снимает, а принятое после — отказ.
/// </remarks>
public static class AuctionStandingStore
{
    private const string UpsertSql = """
        INSERT INTO auction_standing (auction_id, meetup_id, standing, version, updated_at)
        VALUES (@AuctionId, @MeetupId, @Standing, @Version, @Now)
        ON CONFLICT (auction_id) DO UPDATE
            SET meetup_id = EXCLUDED.meetup_id,
                standing = EXCLUDED.standing,
                version = EXCLUDED.version,
                updated_at = EXCLUDED.updated_at
            WHERE auction_standing.version < EXCLUDED.version;
        """;

    private const string ReadSql = """
        SELECT standing FROM auction_standing WHERE auction_id = @AuctionId;
        """;

    /// <summary>
    /// Записывает положение, если факт новее записанного. Возвращает, записал ли:
    /// устаревший факт положения не меняет.
    /// </summary>
    public static async Task<bool> Apply(UnitOfWork work, Guid auctionId, Guid meetupId, AuctionStanding standing,
        long version, DateTimeOffset now, CancellationToken cancellationToken) =>
        await work.Execute(UpsertSql, new
        {
            AuctionId = auctionId,
            MeetupId = meetupId,
            Standing = ToStorage(standing),
            Version = version,
            Now = now.UtcDateTime,
        }, cancellationToken) > 0;

    /// <summary>Положение аукциона; <c>null</c> — фактов о нём сервис ещё не видел.</summary>
    public static async Task<AuctionStanding?> Read(UnitOfWork work, Guid auctionId,
        CancellationToken cancellationToken)
    {
        var rows = await work.Query<string>(ReadSql, new { AuctionId = auctionId }, cancellationToken);
        return rows.Count == 0 ? null : FromStorage(rows[0]);
    }

    /// <summary>
    /// Закрыт ли аукцион для объявления. Прошедший — нет: кнопка «Итоги» ведёт
    /// к нему и после конца. Неизвестный — тоже нет: черновик закрывает пульт,
    /// а аукцион, опубликованный до PER-780, строки не имеет.
    /// </summary>
    public static bool ClosedForNotice(AuctionStanding? standing) =>
        standing is AuctionStanding.Hidden or AuctionStanding.Cancelled or AuctionStanding.Discarded;

    /// <summary>Положение по концу аукциона.</summary>
    public static AuctionStanding Of(AuctionEnd end) => end switch
    {
        AuctionEnd.Finished => AuctionStanding.Finished,
        AuctionEnd.Cancelled => AuctionStanding.Cancelled,
        AuctionEnd.Discarded => AuctionStanding.Discarded,
        _ => throw new ArgumentOutOfRangeException(nameof(end)),
    };

    private static string ToStorage(AuctionStanding standing) => standing switch
    {
        AuctionStanding.Visible => "visible",
        AuctionStanding.Hidden => "hidden",
        AuctionStanding.Finished => "finished",
        AuctionStanding.Cancelled => "cancelled",
        AuctionStanding.Discarded => "discarded",
        _ => throw new ArgumentOutOfRangeException(nameof(standing)),
    };

    // Неизвестное слово — порча строки: CHECK схемы других значений не пускает.
    private static AuctionStanding FromStorage(string standing) => standing switch
    {
        "visible" => AuctionStanding.Visible,
        "hidden" => AuctionStanding.Hidden,
        "finished" => AuctionStanding.Finished,
        "cancelled" => AuctionStanding.Cancelled,
        "discarded" => AuctionStanding.Discarded,
        _ => throw new ArgumentOutOfRangeException(nameof(standing)),
    };
}
