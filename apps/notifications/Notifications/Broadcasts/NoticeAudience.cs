using Notifications.V1;

namespace Notifications.Broadcasts;

/// <summary>
/// Аудитория объявления аукциона (PER-768, PER-778): все держатели права
/// ставок или те из них, кого не видно в розыгрыше или в прогнозах. Фильтр, а
/// не список: список знает Auction, и сервис спрашивает его в момент команды.
/// </summary>
public enum NoticeAudience
{
    All,
    NotInRaffle,
    WithoutPredictions,
    NotInRaffleOrWithoutPredictions,
}

/// <summary>
/// Что ответил Auction на вопрос «кто вовлечён» (<c>ListAuctionEngagement</c>).
/// Множества живут только на время одной команды: сервис их не хранит, не
/// пишет в факты и в лог.
/// </summary>
public abstract record EngagementRead
{
    private EngagementRead()
    {
    }

    /// <param name="RaffleOpen">Регистрация в розыгрыше открыта сейчас.</param>
    /// <param name="RoundOpen">Раунд прогнозов принимает прогнозы сейчас.</param>
    public sealed record Known(
        bool RaffleOpen,
        IReadOnlySet<Guid> RaffleRegistrants,
        bool RoundOpen,
        IReadOnlySet<Guid> Forecasters) : EngagementRead;

    /// <summary>У Auction нет журнала этого аукциона.</summary>
    public sealed record AuctionNotFound : EngagementRead;

    /// <summary>Auction недоступен, не ответил в срок или его адрес не задан.</summary>
    public sealed record Unavailable(string Reason) : EngagementRead;

    /// <summary>Auction ответил тем, чего честный вызов не получает.</summary>
    public sealed record Failed(string Reason) : EngagementRead;
}

/// <summary>Почему аудиторию не сузить; граница выбирает по нему статус gRPC.</summary>
public enum NarrowingRefusal
{
    /// <summary>Auction недоступен: <c>UNAVAILABLE</c>, без отката на «всем».</summary>
    Unavailable,

    /// <summary>Аукцион сейчас не отвечает на этот фильтр: <c>FAILED_PRECONDITION</c>.</summary>
    Precondition,

    /// <summary>Чтение сломано: <c>INTERNAL</c>.</summary>
    Failed,
}

/// <summary>Итог сужения: кого исключить или почему не сузить.</summary>
public abstract record AudienceNarrowing
{
    private AudienceNarrowing()
    {
    }

    /// <summary>Пустое множество исключённых — у «всех» и у остальных рассылок.</summary>
    public static readonly IReadOnlySet<Guid> NoOne = new HashSet<Guid>();

    public static readonly AudienceNarrowing Everyone = new Excluding(NoOne);

    /// <summary>Держатели права ставок, кроме <paramref name="Excluded" />.</summary>
    public sealed record Excluding(IReadOnlySet<Guid> Excluded) : AudienceNarrowing;

    public sealed record Refused(NarrowingRefusal Refusal, string Reason) : AudienceNarrowing;
}

public static class NoticeAudiences
{
    private static readonly IReadOnlyDictionary<NoticeAudience, string> Words =
        new Dictionary<NoticeAudience, string>
        {
            [NoticeAudience.All] = "all",
            [NoticeAudience.NotInRaffle] = "not_in_raffle",
            [NoticeAudience.WithoutPredictions] = "without_predictions",
            [NoticeAudience.NotInRaffleOrWithoutPredictions] = "not_in_raffle_or_without_predictions",
        };

    private static readonly IReadOnlyDictionary<string, NoticeAudience> Audiences =
        Words.ToDictionary(pair => pair.Value, pair => pair.Key, StringComparer.Ordinal);

    /// <summary>
    /// Значение контракта в аудиторию; <c>UNSPECIFIED</c> — «все», как до поля.
    /// <c>null</c> — значение вне словаря.
    /// </summary>
    public static NoticeAudience? FromContract(AuctionNoticeAudience audience) => audience switch
    {
        AuctionNoticeAudience.Unspecified or AuctionNoticeAudience.All => NoticeAudience.All,
        AuctionNoticeAudience.NotInRaffle => NoticeAudience.NotInRaffle,
        AuctionNoticeAudience.WithoutPredictions => NoticeAudience.WithoutPredictions,
        AuctionNoticeAudience.NotInRaffleOrWithoutPredictions => NoticeAudience.NotInRaffleOrWithoutPredictions,
        _ => null,
    };

    /// <summary>
    /// Слово хранения в строке <c>broadcast</c> и в логе. Слово, а не номер
    /// enum, по той же причине, что вид кнопки (<see cref="AuctionNoticeViews" />).
    /// </summary>
    public static string Storage(NoticeAudience audience) => Words[audience];

    public static NoticeAudience FromStorage(string word) =>
        Audiences.TryGetValue(word, out var audience)
            ? audience
            : throw new ArgumentOutOfRangeException(nameof(word), word, "unknown auction notice audience");

    /// <summary>
    /// Кого исключить из держателей права ставок. Фильтр, которому аукцион
    /// сейчас не может ответить, отказывает, а не расширяется до «всех»:
    /// закрытая регистрация больше не отдаёт зарегистрированных, а без
    /// открытого раунда «без прогнозов» — это все, то есть то же «всем» под
    /// чужим именем.
    /// </summary>
    public static AudienceNarrowing Narrow(NoticeAudience audience, EngagementRead read)
    {
        if (audience == NoticeAudience.All)
        {
            return AudienceNarrowing.Everyone;
        }

        if (read is not EngagementRead.Known known)
        {
            return read switch
            {
                EngagementRead.Unavailable unavailable =>
                    new AudienceNarrowing.Refused(NarrowingRefusal.Unavailable, unavailable.Reason),
                EngagementRead.AuctionNotFound =>
                    new AudienceNarrowing.Refused(NarrowingRefusal.Precondition, "auction: no such auction"),
                EngagementRead.Failed failed =>
                    new AudienceNarrowing.Refused(NarrowingRefusal.Failed, failed.Reason),
                _ => throw new ArgumentOutOfRangeException(nameof(read)),
            };
        }

        var needsRaffle = audience is NoticeAudience.NotInRaffle or NoticeAudience.NotInRaffleOrWithoutPredictions;
        var needsRound = audience is NoticeAudience.WithoutPredictions or NoticeAudience.NotInRaffleOrWithoutPredictions;

        if (needsRaffle && !known.RaffleOpen)
        {
            return new AudienceNarrowing.Refused(NarrowingRefusal.Precondition, "raffle registration is not open");
        }

        if (needsRound && !known.RoundOpen)
        {
            return new AudienceNarrowing.Refused(NarrowingRefusal.Precondition, "no prediction round is open");
        }

        IReadOnlySet<Guid> excluded = audience switch
        {
            NoticeAudience.NotInRaffle => known.RaffleRegistrants,
            NoticeAudience.WithoutPredictions => known.Forecasters,

            // «Не в розыгрыше или без прогнозов» исключает только тех, кто и
            // зарегистрирован, и сделал прогноз.
            _ => known.RaffleRegistrants.Where(known.Forecasters.Contains).ToHashSet(),
        };

        return new AudienceNarrowing.Excluding(excluded);
    }
}
