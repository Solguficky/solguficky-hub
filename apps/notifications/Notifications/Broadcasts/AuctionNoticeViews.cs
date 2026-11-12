using Notifications.V1;

namespace Notifications.Broadcasts;

/// <summary>
/// Вид экрана кнопки объявления аукциона (PER-764) — словом хранения в строке
/// <c>broadcast</c> и значением контракта. Слово, а не номер enum: строка
/// читается без схемы, а номер сменил бы смысл вместе с контрактом.
/// </summary>
public static class AuctionNoticeViews
{
    public const string Lot = "lot";

    private static readonly IReadOnlyDictionary<AuctionNoticeView, string> Words =
        new Dictionary<AuctionNoticeView, string>
        {
            [AuctionNoticeView.Auction] = "auction",
            [AuctionNoticeView.Lots] = "lots",
            [AuctionNoticeView.Lot] = Lot,
            [AuctionNoticeView.Raffle] = "raffle",
            [AuctionNoticeView.Predictions] = "predictions",
            [AuctionNoticeView.Chronicle] = "chronicle",
        };

    private static readonly IReadOnlyDictionary<string, AuctionNoticeView> Views =
        Words.ToDictionary(pair => pair.Value, pair => pair.Key, StringComparer.Ordinal);

    /// <summary>Слово хранения; <c>null</c> — значение вне словаря, включая <c>UNSPECIFIED</c>.</summary>
    public static string? Storage(AuctionNoticeView view) => Words.GetValueOrDefault(view);

    /// <summary>Значение контракта для слова, которое записала граница.</summary>
    public static AuctionNoticeView Contract(string word) =>
        Views.TryGetValue(word, out var view)
            ? view
            : throw new ArgumentOutOfRangeException(nameof(word), word, "unknown auction notice view");
}
