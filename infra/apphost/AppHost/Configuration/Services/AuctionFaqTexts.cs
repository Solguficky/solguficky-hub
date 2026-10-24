using Microsoft.Extensions.Configuration;

namespace AppHost.Configuration.Services;

/// <summary>
/// Тексты FAQ аукциона и ссылка «Подробнее» у ботов хаба и аукциона: оба
/// показывают один FAQ, поэтому значения у них общие. Пределы и форму адреса
/// проверяет сам бот на старте (<c>apps/hub-bot/src/auction-faq.ts</c>):
/// AppHost передаёт значения как есть. Временный мостик, пока FAQ не уедет
/// в админку (PER-720).
///
/// Каждый текст необязателен: без значения бот показывает заглушку. Локально
/// текст — настройка, как имя бота поддержки (<see cref="SupportBotLink"/>), а
/// не параметр Aspire: пустой параметр дашборд спросил бы у каждого. В чарте
/// текст — параметр с явным пустым умолчанием: values среды без ключа
/// оставляют заглушку, а не роняют выкладку, и это свойство записано в графе,
/// а не держится на том, что генератор кладёт пустую строку и параметру без
/// значения. Пустую переменную бот читает как незаданную.
/// </summary>
internal sealed class AuctionFaqTexts
{
    /// <summary>
    /// Переменная бота, ключ настройки (user-secrets AppHost или переменная
    /// <c>AuctionFaq__&lt;Имя&gt;</c>) и имя параметра чарта.
    /// </summary>
    internal static readonly IReadOnlyList<(string Variable, string Key, string Parameter)> Fields =
    [
        ("AUCTION_FAQ_ITEMS", "AuctionFaq:Items", "auction-faq-items"),
        ("AUCTION_FAQ_PURPOSE", "AuctionFaq:Purpose", "auction-faq-purpose"),
        ("AUCTION_FAQ_SIMULTANEOUS_BIDS", "AuctionFaq:SimultaneousBids", "auction-faq-simultaneous-bids"),
        ("AUCTION_FAQ_CONNECTION_FAILURE", "AuctionFaq:ConnectionFailure", "auction-faq-connection-failure"),
        ("AUCTION_FAQ_DELIVERY", "AuctionFaq:Delivery", "auction-faq-delivery"),
        ("AUCTION_FAQ_DETAILS_URL", "AuctionFaq:DetailsUrl", "auction-faq-details-url"),
    ];

    private readonly IReadOnlyList<(string Variable, string Value)> values;
    private readonly IReadOnlyList<(string Variable, IResourceBuilder<ParameterResource> Parameter)> parameters;

    private AuctionFaqTexts(
        IReadOnlyList<(string Variable, string Value)> values,
        IReadOnlyList<(string Variable, IResourceBuilder<ParameterResource> Parameter)> parameters)
    {
        this.values = values;
        this.parameters = parameters;
    }

    /// <summary>Локальный запуск: только заданные настройки, остальное — заглушки бота.</summary>
    public static AuctionFaqTexts Local(IConfiguration configuration) =>
        new(
            Fields
                .Select(field => (field.Variable, Value: configuration[field.Key]?.Trim() ?? string.Empty))
                .Where(field => field.Value.Length > 0)
                .ToList(),
            []);

    /// <summary>
    /// Чарт: по параметру на текст, общему у двух ботов. Второй бот берёт
    /// параметр, который объявил первый, — повторное объявление того же имени
    /// Aspire отвергает.
    /// </summary>
    public static AuctionFaqTexts Published(IDistributedApplicationBuilder builder) =>
        new(
            [],
            Fields
                .Select(field =>
                {
                    var existing = builder.Resources
                        .OfType<ParameterResource>()
                        .SingleOrDefault(resource => resource.Name == field.Parameter);

                    return (field.Variable, existing is null
                        ? builder.AddParameter(field.Parameter, string.Empty, publishValueAsDefault: true)
                        : builder.CreateResourceBuilder(existing));
                })
                .ToList());

    public IResourceBuilder<T> Apply<T>(IResourceBuilder<T> bot)
        where T : IResourceWithEnvironment
    {
        foreach (var (variable, value) in values)
        {
            bot.WithEnvironment(variable, value);
        }

        foreach (var (variable, parameter) in parameters)
        {
            bot.WithEnvironment(variable, parameter);
        }

        return bot;
    }
}
